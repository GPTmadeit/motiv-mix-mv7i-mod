"use strict";
// MOTIV Mix MV7i mod: touch panel tap actions, green lights while reverb is on,
// and in-app updates from GitHub.
//
// The tap itself is handled by the mic firmware, which toggles AUDIO:MUTE.
// When an MV7i connects we look up its real property keys in the app's own
// device description, subscribe to mute and reverb ourselves, and react to
// mute transitions the app did not cause itself:
//   "mute"        - stock behaviour, do nothing
//   "reverb"      - put mute back the way it was, toggle reverb
//   "mute+reverb" - leave mute alone, toggle reverb
// A double tap switches between reverb and mute mode; single taps then wait
// DOUBLE_TAP_MS before acting, to be sure no second tap is coming.
const { app, ipcMain, net, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MOD_VERSION = "3.1.0";
const REPO = "GPTmadeit/motiv-mix-mv7i-mod";
const INSTALLER_ASSET = "MV7i-Mod-Installer.cmd";

const MODES = ["mute", "reverb", "mute+reverb"];
const DEFAULT_SETTINGS = { mode: "mute", greenLeds: true, doubleTapSwitch: true, autoUpdateCheck: true };
const isMv7i = device => String(device?.model ?? "").toUpperCase().startsWith("MV7I");
// A mute event matching one of the app's own writes within this window is not a tap.
const SELF_WRITE_WINDOW_MS = 2500;
// One tap can flip several mute keys (device + channels). Flips of keys not yet seen
// within this window belong to the same tap; a key flipping again is a new tap.
const SAME_TAP_MS = 300;
// A second tap starting within this window of the first is a double tap.
const DOUBLE_TAP_MS = 500;
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MUTE = "AUDIO:MUTE";
const REVERB = "AUDIO:REVERB_ENABLE";
// Used only if the device description cannot be read.
const FALLBACK_SUFFIXES = ["", "/CH=0", "/CH=1", "/CH=2", "/CH=3"];
const NO_SUBKEYS = "__None__";

// Touch panel lighting while reverb is on. Theme values come from colorThemeMap
// (Shure=0, Custom=1) and expandedColorThemeMap (Default=0 ... Custom=4) in main.js;
// colours are 0xRRGGBB.
const GREEN = 0x00ff00;
const LED_GREEN_VALUES = {
  "UI:LIVE_METER_THEME": 4,
  "UI:LIVE_METER_CENTER_LED_COLOR": GREEN,
  "UI:LIVE_METER_OUTERMOST_LED_COLOR": GREEN,
  "UI:BREATHING_METER_SETTING": 1,
  "UI:BREATHING_METER_LED_COLOR": GREEN,
  "UI:SOLID_METER_SETTING": 1,
  "UI:SOLID_METER_LED_COLOR": GREEN,
  "UI:BREATHING_METER_SETTING_SPLIT": 4,
  "UI:BREATHING_METER_LED_COLOR_SPLIT_LEFT": GREEN,
  "UI:BREATHING_METER_LED_COLOR_SPLIT_RIGHT": GREEN,
  "UI:SOLID_METER_SETTING_SPLIT": 4,
  "UI:SOLID_METER_LED_COLOR_SPLIT_LEFT": GREEN,
  "UI:SOLID_METER_LED_COLOR_SPLIT_RIGHT": GREEN,
};
const LED_KEYS = Object.keys(LED_GREEN_VALUES);

let settings = { ...DEFAULT_SETTINGS };
let ndl; // { manager, parser } from NdlDeviceManager#init
let ownWrite = false; // set while this mod calls updateProperty
const devices = new Map();
const modelsSeen = new Set();
const update = { state: "idle", latest: null, error: null, checkedAt: null };

const dataFile = name => path.join(app.getPath("userData"), name);
// GUI apps on Windows have no visible console, so also keep a small log file.
const LOG_LIMIT_BYTES = 1 << 20;
function log(...args) {
  console.log("[mv7i-mod]", ...args);
  try {
    const file = dataFile("tap-action.log");
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, file + ".old");
    const text = args.map(a => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile("tap-action.json"), "utf8"));
    if (MODES.includes(saved.mode)) settings.mode = saved.mode;
    if (typeof saved.greenLeds === "boolean") settings.greenLeds = saved.greenLeds;
    if (typeof saved.doubleTapSwitch === "boolean") settings.doubleTapSwitch = saved.doubleTapSwitch;
    if (typeof saved.autoUpdateCheck === "boolean") settings.autoUpdateCheck = saved.autoUpdateCheck;
  } catch {}
  log("started mod", MOD_VERSION, settings);
}

function saveSettings() {
  try {
    fs.writeFileSync(dataFile("tap-action.json"), JSON.stringify(settings));
  } catch (err) {
    log("failed to save settings", err);
  }
}

const isKey = (key, base) => key === base || key.startsWith(base + "/");
const channelSuffix = key => (key.includes("/") ? key.slice(key.indexOf("/")) : "");

// Calls the app's own Device.updateProperty, marking the write as ours.
function write(device, key, value) {
  ownWrite = true;
  try {
    return device.updateProperty(key, value);
  } finally {
    ownWrite = false;
  }
}

// Same expansion as DevicePropertyInfoService.propertyKeys in main.js.
function expandKeys(description, wanted) {
  const keys = [];
  for (const [category, props] of description.device.propertyCategories) {
    for (const [baseKey, info] of props) {
      const flatKey = `${category}:${baseKey}`;
      if (!wanted(flatKey)) continue;
      for (const structure of info.propStructs.keys()) {
        if (structure === NO_SUBKEYS) {
          keys.push(flatKey);
          continue;
        }
        const counts = description.device.subkeyInfo.get(structure);
        const subKeys = structure.split("/");
        if (counts === undefined || counts.length !== subKeys.length) continue;
        let partial = [flatKey];
        subKeys.forEach((subKey, i) => {
          partial = partial.flatMap(k => Array.from({ length: counts[i] }, (_, n) => `${k}/${subKey}=${n}`));
        });
        keys.push(...partial);
      }
    }
  }
  return keys;
}

async function discoverKeys(device) {
  const wanted = key => isKey(key, MUTE) || isKey(key, REVERB) || LED_KEYS.includes(key) || /MUTE|BUTTON|TOUCH/.test(key);
  if (ndl !== undefined) {
    try {
      const text = await ndl.manager.deviceDescriptionManager.deviceDescription(device.category, device.interfaceId);
      const keys = expandKeys(ndl.parser.parseDeviceDescription(text), wanted);
      if (keys.some(k => isKey(k, MUTE))) return { keys, source: "description" };
      log("description has no mute keys", keys);
    } catch (err) {
      log("could not read device description, probing instead", err);
    }
  }
  const candidates = [MUTE, REVERB].flatMap(base => FALLBACK_SUFFIXES.map(s => base + s)).concat(LED_KEYS);
  const values = await Promise.all(candidates.map(k => device.getProperty(k).catch(e => e)));
  const ok = v => typeof v === "boolean" || typeof v === "number";
  return { keys: candidates.filter((_, i) => ok(values[i])), source: "probe" };
}

// ---- reverb toggle on tap ----

function reverbKeyFor(state, muteKey) {
  const sameChannel = REVERB + channelSuffix(muteKey);
  if (state.reverbKeys.includes(sameChannel)) return sameChannel;
  return state.reverbKeys[0];
}

async function toggleReverb(state, muteKey) {
  const key = reverbKeyFor(state, muteKey);
  if (key === undefined) {
    log("no reverb key on this device");
    return;
  }
  const current = await state.device.getProperty(key);
  if (typeof current !== "boolean") {
    log("cannot read", key, current);
    return;
  }
  await write(state.device, key, !current);
  log("tap ->", key, !current);
}

// Double tap: switch between reverb and mute mode. The firmware flipped mute twice, so it ends where it began.
function switchMode() {
  settings.mode = settings.mode === "mute" ? "reverb" : "mute";
  saveSettings();
  log("double tap -> mode", settings.mode);
}

function onTap(state, key, previous) {
  log("tap detected on", key, "mode", settings.mode);
  // In reverb mode the mic should never stay muted, whether this turns out to be a single or double tap.
  if (settings.mode === "reverb") {
    write(state.device, key, previous).catch(err => log("failed to restore mute", key, err));
  }
  const now = Date.now();
  const last = state.lastTap;
  if (last !== undefined && now - last.at < SAME_TAP_MS && !last.keys.has(key)) {
    last.keys.add(key);
    return;
  }
  if (last !== undefined && !last.done && now - last.at < DOUBLE_TAP_MS && settings.doubleTapSwitch) {
    clearTimeout(last.timer);
    last.done = true;
    // Remember this second tap too, so its other channels are not counted as a new tap.
    state.lastTap = { at: now, keys: new Set([key]), done: true };
    switchMode();
    return;
  }
  // Single tap, acted on once no second tap has arrived.
  const tap = { at: now, keys: new Set([key]), done: false };
  tap.timer = setTimeout(() => {
    tap.done = true;
    if (settings.mode === "mute") return;
    toggleReverb(state, key).catch(err => log("failed to toggle reverb", err));
  }, settings.doubleTapSwitch ? DOUBLE_TAP_MS : 0);
  state.lastTap = tap;
}

// ---- green lights while reverb is on ----

const ledBackupFile = state => dataFile(`led-backup-${String(state.device.hardwareId).replace(/[^\w.-]/g, "_")}.json`);

function readLedBackup(state) {
  try {
    return JSON.parse(fs.readFileSync(ledBackupFile(state), "utf8"));
  } catch {
    return undefined;
  }
}

function writeLedBackup(state) {
  try {
    if (state.ledBackup === undefined) fs.rmSync(ledBackupFile(state), { force: true });
    else fs.writeFileSync(ledBackupFile(state), JSON.stringify(state.ledBackup));
  } catch (err) {
    log("failed to store light backup", err);
  }
}

async function applyGreen(state) {
  const backup = {};
  for (const key of state.ledKeys) {
    const value = await state.device.getProperty(key);
    if (typeof value === "number") backup[key] = value;
  }
  // Save before writing, so the user's colours survive a crash mid-way.
  state.ledBackup = backup;
  writeLedBackup(state);
  await Promise.all(Object.keys(backup).map(key => write(state.device, key, { unsigned: LED_GREEN_VALUES[key] })));
  log("lights green", Object.keys(backup));
}

async function restoreLeds(state) {
  const backup = state.ledBackup;
  await Promise.all(Object.entries(backup).map(([key, value]) => write(state.device, key, { unsigned: value })));
  state.ledBackup = undefined;
  writeLedBackup(state);
  log("lights restored", backup);
}

// Serialised per device, so quick reverb toggles cannot interleave writes.
function syncLeds(state) {
  state.ledQueue = state.ledQueue.then(async () => {
    if (state.abort.signal.aborted || state.ledKeys.length === 0) return;
    const reverbOn = [...state.reverb.values()].some(Boolean);
    const want = settings.greenLeds && reverbOn;
    if (want && state.ledBackup === undefined) await applyGreen(state);
    else if (!want && state.ledBackup !== undefined) await restoreLeds(state);
  }).catch(err => log("light update failed", err));
  return state.ledQueue;
}

// ---- device tracking ----

function handleEvent(state, properties, eventType) {
  for (const [key, value] of properties) {
    if (eventType === "update") log("event", key, value);
    if (isKey(key, REVERB) && typeof value === "boolean") {
      state.reverb.set(key, value);
      syncLeds(state);
      continue;
    }
    if (!isKey(key, MUTE) || typeof value !== "boolean") continue;
    const previous = state.muted.get(key);
    state.muted.set(key, value);
    // Snapshots and repeats are not taps.
    if (eventType !== "update" || previous === undefined || previous === value) continue;
    const own = state.selfWrites.get(key);
    if (own !== undefined && own.value === value && Date.now() - own.at < SELF_WRITE_WINDOW_MS) {
      state.selfWrites.delete(key);
      continue;
    }
    onTap(state, key, previous);
  }
}

// One subscription per key, so a key the firmware rejects does not take the others down.
async function watch(state, key) {
  try {
    for await (const event of state.device.subscribeProperties([key], state.abort.signal)) {
      if (event.type === "snapshot" || event.type === "update") handleEvent(state, event.properties, event.type);
      else if (event.type === "error") log("subscription error", key, event.message);
    }
  } catch (err) {
    if (!state.abort.signal.aborted) log("subscription failed", key, err);
  }
}

async function setup(device) {
  const previous = devices.get(device.hardwareId);
  if (previous?.device === device) return;
  previous?.abort.abort();
  const state = {
    device, abort: new AbortController(), muted: new Map(), reverb: new Map(), selfWrites: new Map(),
    muteKeys: [], reverbKeys: [], ledKeys: [], watchKeys: [], lastTap: undefined, status: "connecting",
    ledBackup: undefined, ledQueue: Promise.resolve(),
  };
  devices.set(device.hardwareId, state);
  try {
    const { keys, source } = await discoverKeys(device);
    if (state.abort.signal.aborted) return;
    state.muteKeys = keys.filter(k => isKey(k, MUTE));
    state.reverbKeys = keys.filter(k => isKey(k, REVERB)).sort();
    state.ledKeys = keys.filter(k => LED_KEYS.includes(k));
    state.watchKeys = keys.filter(k => !LED_KEYS.includes(k));
    // Lights left green by a previous session are restored once reverb is seen off.
    state.ledBackup = readLedBackup(state);
    log("MV7i", device.hardwareId, "keys from", source,
      { mute: state.muteKeys, reverb: state.reverbKeys, lights: state.ledKeys, watch: state.watchKeys });
    state.status = state.muteKeys.length === 0 ? "no mute property found"
      : state.reverbKeys.length === 0 ? "no reverb property found"
      : "ready";
    for (const key of state.watchKeys) watch(state, key);
  } catch (err) {
    state.status = "setup failed";
    log("setup failed", err);
    devices.delete(device.hardwareId);
  }
}

// Called from NdlDeviceManager#init.
function onManager(manager, parser) {
  ndl = { manager, parser };
}

// Called from NdlDeviceManager.processDeviceStateChange for every device state change.
function onDevice(device) {
  try {
    const model = String(device.model ?? "");
    if (!modelsSeen.has(model)) {
      modelsSeen.add(model);
      log("device model seen:", JSON.stringify(model));
    }
    if (!isMv7i(device)) return;
    // Wait until the basic property gets have succeeded (deviceState ONLINE).
    if (String(device.deviceState).toUpperCase() !== "ONLINE") return;
    setup(device);
  } catch (err) {
    log("device handling failed", err);
  }
}

// Called from NdlDeviceManager.Device.updateProperty for every write.
function onWrite(device, key, value) {
  try {
    const state = devices.get(device.hardwareId);
    if (state === undefined) return;
    // Echoes of mute writes (the app's or our own restores) are not taps.
    if (isKey(key, MUTE)) state.selfWrites.set(key, { value, at: Date.now() });
    // The user changed a light setting in the app while green: keep their choice.
    if (!ownWrite && state.ledBackup !== undefined && key in state.ledBackup) {
      delete state.ledBackup[key];
      writeLedBackup(state);
    }
  } catch {}
}

function status() {
  const states = [...devices.values()];
  if (states.length === 0) return "MV7i not detected" + (modelsSeen.size ? ` (seen: ${[...modelsSeen].join(", ")})` : "");
  return states.map(s => s.status).join("; ");
}

// ---- updates from GitHub ----

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "mv7i-mod" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function checkForUpdate() {
  if (update.state === "checking" || update.state === "installing") return updateInfo();
  update.state = "checking";
  try {
    const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = release.assets?.find(a => a.name === INSTALLER_ASSET);
    const hashAsset = release.assets?.find(a => a.name === INSTALLER_ASSET + ".sha256");
    update.latest = { version: release.tag_name.replace(/^v/, ""), url: asset?.browser_download_url,
      hashUrl: hashAsset?.browser_download_url, page: release.html_url, notes: release.body ?? "" };
    update.state = newer(update.latest.version, MOD_VERSION) && asset ? "available" : "current";
    update.error = null;
    log("update check:", update.state, update.latest.version);
  } catch (err) {
    update.state = "error";
    update.error = String(err.message ?? err);
    log("update check failed", err);
  }
  update.checkedAt = Date.now();
  return updateInfo();
}

async function installUpdate() {
  if (update.state !== "available") throw new Error("no update available");
  update.state = "installing";
  try {
    const res = await net.fetch(update.latest.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const body = Buffer.from(await res.arrayBuffer());
    if (update.latest.hashUrl) {
      const expected = (await (await net.fetch(update.latest.hashUrl)).text()).trim().split(/\s+/)[0].toLowerCase();
      const actual = crypto.createHash("sha256").update(body).digest("hex");
      if (expected !== actual) throw new Error("downloaded installer failed its checksum");
    }
    const file = path.join(os.tmpdir(), INSTALLER_ASSET);
    fs.writeFileSync(file, body);
    log("starting installer", update.latest.version, file);
    // The installer asks for admin, waits for MOTIV Mix to close, patches, and reopens it.
    spawn("cmd.exe", ["/d", "/c", "start", '""', `"${file}"`, "/update"],
      { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    setTimeout(() => app.quit(), 1500);
    setTimeout(() => app.exit(0), 8000);
    return updateInfo();
  } catch (err) {
    update.state = "error";
    update.error = String(err.message ?? err);
    log("update install failed", err);
    throw err;
  }
}

const updateInfo = () => ({ current: MOD_VERSION, ...update });

// ---- renderer bridge ----

const UI_SCRIPT = `(() => {
  if (window.__mv7iModUi) return "already";
  if (!window.motivTapAction) return "no bridge";
  window.__mv7iModUi = true;
  const call = window.motivTapAction.call;
  const compact = location.href.includes("tray-renderer");
  const LABELS = { "mute": "Mute (default)", "reverb": "Reverb on/off", "mute+reverb": "Mute + reverb on/off" };
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
  function build() {
    const wrap = el("div", "display:flex;flex-direction:column;gap:6px;font:inherit;color:inherit;" +
      (compact ? "padding:8px 10px;font-size:12px" : "padding:12px 16px"));
    wrap.className = "mv7i-mod";
    const row = (label, control) => { const r = el("div", "display:flex;align-items:center;justify-content:space-between;gap:12px"); r.append(el("span", "", label), control); return r; };
    const select = el("select", "font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:" + (compact ? "2px 6px" : "4px 8px"));
    for (const [value, text] of Object.entries(LABELS)) {
      const option = el("option", "color:#000", text);
      option.value = value;
      select.append(option);
    }
    select.addEventListener("change", () => call("set", { mode: select.value }).then(render));
    const green = el("input");
    green.type = "checkbox";
    green.addEventListener("change", () => call("set", { greenLeds: green.checked }).then(render));
    const doubleTap = el("input");
    doubleTap.type = "checkbox";
    doubleTap.addEventListener("change", () => call("set", { doubleTapSwitch: doubleTap.checked }).then(render));
    const note = el("small", "opacity:.6");
    const upd = el("div", "display:flex;align-items:center;justify-content:space-between;gap:8px;opacity:.85");
    const updText = el("small", "cursor:pointer;text-decoration:underline dotted");
    updText.title = "Open the mod's GitHub page";
    updText.addEventListener("click", () => call("openRepo"));
    const updButton = el("button", "font:inherit;font-size:" + (compact ? "11px" : "12px") + ";color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:2px 8px;cursor:pointer");
    upd.append(updText, updButton);
    let action = null;
    updButton.addEventListener("click", () => {
      if (action === "install" && !confirm("Install mod update v" + updButton.dataset.version + "? MOTIV Mix will close, ask for admin rights, and reopen.")) return;
      updButton.disabled = true;
      call(action === "install" ? "installUpdate" : "checkUpdate").catch(err => alert("Update failed: " + err.message)).finally(render);
    });
    wrap.append(row("Touch panel tap", select), row("Double-tap switches reverb/mute", doubleTap), row("Green lights while reverb is on", green), note, upd);
    function render() {
      return call("state").then(s => {
        select.value = s.mode;
        green.checked = s.greenLeds;
        doubleTap.checked = s.doubleTapSwitch;
        note.textContent = "MV7i mod: " + s.status;
        const u = s.update;
        updButton.disabled = u.state === "checking" || u.state === "installing";
        updButton.style.display = "";
        if (u.state === "available") { updText.textContent = "Mod v" + u.current + " - v" + u.latest.version + " available"; updButton.textContent = "Install update"; updButton.dataset.version = u.latest.version; action = "install"; }
        else if (u.state === "installing") { updText.textContent = "Installing update..."; updButton.style.display = "none"; }
        else if (u.state === "checking") { updText.textContent = "Checking for updates..."; updButton.textContent = "Check"; action = "check"; }
        else { updText.textContent = "Mod v" + u.current + (u.state === "current" ? " (up to date)" : u.state === "error" ? " (update check failed)" : ""); updButton.textContent = "Check for updates"; action = "check"; }
      }).catch(() => {});
    }
    render();
    const timer = setInterval(() => (wrap.isConnected ? render() : clearInterval(timer)), 3000);
    return wrap;
  }
  let queued = false;
  function attach() {
    queued = false;
    for (const panel of document.querySelectorAll("sh-mv7i-device-panel")) {
      if (panel.querySelector(".mv7i-mod")) continue;
      const footer = panel.querySelector(".sh-device-panel-footer");
      const body = panel.querySelector(".sh-mv7i-property-panel") || panel;
      footer ? footer.before(build()) : body.append(build());
    }
  }
  new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(attach); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  attach();
  return "ok";
})();`;

const fromAppPage = event => (event.senderFrame?.url ?? "").startsWith("file://");
const handlers = {
  state: () => ({ ...settings, status: status(), update: updateInfo() }),
  set: changes => {
    if (changes?.mode !== undefined) {
      if (!MODES.includes(changes.mode)) throw new Error("bad mode");
      settings.mode = changes.mode;
    }
    if (changes?.greenLeds !== undefined) {
      settings.greenLeds = Boolean(changes.greenLeds);
      for (const state of devices.values()) syncLeds(state);
    }
    if (changes?.doubleTapSwitch !== undefined) settings.doubleTapSwitch = Boolean(changes.doubleTapSwitch);
    if (changes?.autoUpdateCheck !== undefined) settings.autoUpdateCheck = Boolean(changes.autoUpdateCheck);
    saveSettings();
    log("settings", settings);
    return handlers.state();
  },
  checkUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
  openRepo: () => shell.openExternal(`https://github.com/${REPO}`),
};
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle("motiv-tap-action:" + name, (event, arg) => {
    if (!fromAppPage(event)) throw new Error("rejected");
    return fn(arg);
  });
}

const isAppWindow = url => /\/(tray-)?renderer\/index\.html/i.test(url.replace(/\\/g, "/"));

app.on("web-contents-created", (_event, contents) => {
  contents.on("dom-ready", () => {
    const url = contents.getURL();
    if (!isAppWindow(url)) return;
    contents.executeJavaScript(UI_SCRIPT)
      .then(result => log("ui injection", result, url))
      .catch(err => log("ui injection failed", err));
  });
});

// userData is set by main.js during startup, before the app is ready.
app.whenReady().then(() => {
  loadSettings();
  if (settings.autoUpdateCheck) {
    setTimeout(checkForUpdate, 15000);
    setInterval(() => settings.autoUpdateCheck && checkForUpdate(), UPDATE_CHECK_INTERVAL_MS).unref?.();
  }
});

globalThis.__motivTapAction = { onManager, onDevice, onWrite, status, expandKeys, syncLeds, newer, MOD_VERSION };
