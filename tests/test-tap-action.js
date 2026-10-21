"use strict";
// Exercises src/tap-action.js against a fake electron module, a fake NDL manager and a fake MV7i.
//   node tests/test-tap-action.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mv7i-mod-test-"));
const handlers = {};
let fetchRoutes = {};
const spawned = [];
const fakeElectron = {
  app: { getPath: () => userData, on() {}, whenReady: () => new Promise(() => {}), quit() {}, exit() {} },
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
  shell: { openExternal() {} },
  net: {
    fetch: async url => {
      const body = fetchRoutes[url];
      if (body === undefined) return { ok: false, status: 404 };
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      return { ok: true, status: 200, json: async () => JSON.parse(buf), text: async () => buf.toString(), arrayBuffer: async () => buf };
    },
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "child_process") return { spawn: (...args) => { spawned.push(args); return { unref() {} }; } };
  return load.call(this, request, ...rest);
};
require(path.join(__dirname, "..", "src", "tap-action.js"));
const { onManager, onDevice, onWrite, status, expandKeys, newer } = globalThis.__motivTapAction;
const appEvent = { senderFrame: { url: "file:///C:/app/tray-renderer/index.html" } };
const call = (name, arg) => handlers["motiv-tap-action:" + name](appEvent, arg);

const MUTE = "AUDIO:MUTE/CH=1";
const MUTE2 = "AUDIO:MUTE/CH=0";
const REVERB = "AUDIO:REVERB_ENABLE/CH=1";
const BLUE = 0x0000ff;

// Parsed-description shape produced by JsonV2DeviceDescriptionParser (Maps, "__None__" for no subkeys).
const plain = () => ({ propStructs: new Map([["__None__", {}]]) });
const description = {
  device: {
    subkeyInfo: new Map([["CH", [2]]]),
    propertyCategories: new Map([
      ["AUDIO", new Map([
        ["MUTE", { propStructs: new Map([["CH", {}]]) }],
        ["REVERB_ENABLE", { propStructs: new Map([["CH", {}]]) }],
        ["GAIN", { propStructs: new Map([["CH", {}]]) }],
      ])],
      ["UI", new Map([
        ["MUTE_LOCK", plain()],
        ["LIVE_METER_THEME", plain()], ["LIVE_METER_CENTER_LED_COLOR", plain()],
        ["SOLID_METER_SETTING", plain()], ["SOLID_METER_LED_COLOR", plain()],
      ])],
    ]),
  },
};
const goodManager = { deviceDescriptionManager: { deviceDescription: async () => "json" } };
onManager(goodManager, { parseDeviceDescription: () => description });

function fakeDevice(id, model = "MV7i") {
  const props = {
    [MUTE]: false, [MUTE2]: false, "AUDIO:REVERB_ENABLE/CH=0": false, [REVERB]: false, "UI:MUTE_LOCK": false,
    "UI:LIVE_METER_THEME": 0, "UI:LIVE_METER_CENTER_LED_COLOR": BLUE, "UI:SOLID_METER_SETTING": 0, "UI:SOLID_METER_LED_COLOR": BLUE,
  };
  const listeners = new Map();
  const device = {
    hardwareId: id, model, deviceState: "ONLINE", category: 1, interfaceId: 1, writes: [], subscribed: [],
    getProperty: async key => (key in props ? props[key] : { code: "INVALID_PROPERTY" }),
    updateProperty(key, value) {
      onWrite(device, key, value); // mirrors the hook in Device.updateProperty
      device.writes.push([key, value]);
      device.set(key, typeof value === "object" ? value.unsigned : value);
      return Promise.resolve(true);
    },
    // Mirrors NdlDeviceManager.subscribeProperties: a snapshot, then updates until aborted.
    subscribeProperties(keys, signal) {
      device.subscribed.push(...keys);
      const queue = [{ type: "snapshot", properties: new Map(keys.map(k => [k, props[k]])) }];
      let wake;
      for (const k of keys) listeners.set(k, event => { queue.push(event); wake?.(); });
      signal.addEventListener("abort", () => wake?.());
      return (async function* () {
        while (!signal.aborted) {
          if (queue.length) yield queue.shift();
          else await new Promise(r => { wake = r; });
        }
      })();
    },
    set(key, value) {
      props[key] = value;
      listeners.get(key)?.({ type: "update", properties: new Map([[key, value]]) });
    },
    props,
  };
  return device;
}
const tick = () => new Promise(r => setTimeout(r, 30));
const wait = ms => new Promise(r => setTimeout(r, ms));
// A firmware tap: the mute property flips on the device.
const tap = (device, key = MUTE) => device.set(key, !device.props[key]);
const connect = async device => { onDevice(device); await tick(); };
const nonLedWrites = d => d.writes.filter(([k]) => !k.startsWith("UI:"));
const lights = d => ["UI:LIVE_METER_THEME", "UI:LIVE_METER_CENTER_LED_COLOR", "UI:SOLID_METER_SETTING", "UI:SOLID_METER_LED_COLOR"].map(k => d.props[k]);
const GREEN_LIGHTS = [4, 0x00ff00, 1, 0x00ff00];
const STOCK_LIGHTS = [0, BLUE, 0, BLUE];

(async () => {
  // key expansion matches the app's own algorithm
  assert.deepStrictEqual(expandKeys(description, k => k.startsWith("AUDIO")).sort(), [
    "AUDIO:GAIN/CH=0", "AUDIO:GAIN/CH=1", "AUDIO:MUTE/CH=0", "AUDIO:MUTE/CH=1",
    "AUDIO:REVERB_ENABLE/CH=0", "AUDIO:REVERB_ENABLE/CH=1"]);
  assert.match(status(), /not detected/);

  // --- tap actions ---
  let d = fakeDevice("a");
  await connect(d);
  assert.ok(d.subscribed.includes(MUTE) && d.subscribed.includes(REVERB), "mute and reverb are watched on connect");
  assert.ok(!d.subscribed.some(k => k.includes("METER")), "light keys are not subscribed");
  assert.match(status(), /ready/);
  tap(d); await tick();
  assert.deepStrictEqual(d.writes, [], "mute mode must not write");

  d = fakeDevice("pending"); d.deviceState = "DISCOVERED";
  await connect(d);
  assert.deepStrictEqual(d.subscribed, [], "not set up until online");

  await call("set", { mode: "mute+reverb", greenLeds: false });
  d = fakeDevice("b");
  await connect(d);
  tap(d); await tick();
  assert.deepStrictEqual(d.writes, [[REVERB, true]]);
  assert.strictEqual(d.props[MUTE], true);

  await call("set", { mode: "reverb" });
  d = fakeDevice("c");
  await connect(d);
  tap(d); await tick();
  assert.deepStrictEqual(d.writes, [[MUTE, false], [REVERB, true]]);
  await wait(450);
  tap(d); await tick();
  assert.deepStrictEqual(d.writes.slice(2), [[MUTE, false], [REVERB, false]], "second tap toggles reverb back");

  d = fakeDevice("d");
  await connect(d);
  await d.updateProperty(MUTE, true); await tick();
  assert.deepStrictEqual(d.writes, [[MUTE, true]], "app-initiated mute must be ignored");

  d = fakeDevice("e");
  await connect(d);
  tap(d, MUTE); tap(d, MUTE2); await tick();
  assert.deepStrictEqual(d.writes, [[MUTE, false], [MUTE2, false], [REVERB, true]], "one toggle per multi-channel tap");

  await call("set", { mode: "mute+reverb" });
  const old = fakeDevice("f");
  await connect(old);
  d = fakeDevice("f");
  await connect(d);
  tap(old); await tick();
  assert.deepStrictEqual(old.writes, [], "old device object no longer handled after reconnect");
  tap(d); await tick();
  assert.deepStrictEqual(d.writes, [[REVERB, true]]);

  d = fakeDevice("g", "MV7I"); await connect(d);
  tap(d); await tick();
  assert.deepStrictEqual(d.writes, [[REVERB, true]], "model match is case-insensitive");
  d = fakeDevice("h", "MV7+"); await connect(d);
  assert.deepStrictEqual(d.subscribed, [], "other models untouched");

  // --- green lights while reverb is on ---
  await call("set", { mode: "reverb", greenLeds: true });
  d = fakeDevice("led1");
  await connect(d);
  tap(d); await tick();
  assert.strictEqual(d.props[REVERB], true);
  assert.strictEqual(d.props[MUTE], false, "reverb mode leaves the mic unmuted");
  assert.deepStrictEqual(lights(d), GREEN_LIGHTS, "lights go green when reverb turns on");
  const backupFile = path.join(userData, "led-backup-led1.json");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(backupFile)),
    { "UI:LIVE_METER_THEME": 0, "UI:LIVE_METER_CENTER_LED_COLOR": BLUE, "UI:SOLID_METER_SETTING": 0, "UI:SOLID_METER_LED_COLOR": BLUE });
  await wait(450);
  tap(d); await tick();
  assert.strictEqual(d.props[REVERB], false);
  assert.deepStrictEqual(lights(d), STOCK_LIGHTS, "original lights restored when reverb turns off");
  assert.ok(!fs.existsSync(backupFile), "backup removed after restore");

  // reverb switched on from the app itself also turns the lights green
  d = fakeDevice("led2");
  await connect(d);
  d.set(REVERB, true); await tick();
  assert.deepStrictEqual(lights(d), GREEN_LIGHTS);
  // the user picks a new solid colour in the app while green: their choice is kept on restore
  await d.updateProperty("UI:SOLID_METER_LED_COLOR", { unsigned: 0xff00ff });
  d.set(REVERB, false); await tick();
  assert.deepStrictEqual(lights(d), [0, BLUE, 0, 0xff00ff]);

  // turning the option off restores the lights even while reverb stays on
  d = fakeDevice("led3");
  await connect(d);
  d.set(REVERB, true); await tick();
  assert.deepStrictEqual(lights(d), GREEN_LIGHTS);
  await call("set", { greenLeds: false }); await tick();
  assert.deepStrictEqual(lights(d), STOCK_LIGHTS);
  await call("set", { greenLeds: true }); await tick();
  assert.deepStrictEqual(lights(d), GREEN_LIGHTS);

  // lights left green by a previous session are restored once reverb is seen off
  fs.writeFileSync(path.join(userData, "led-backup-led4.json"), JSON.stringify({ "UI:SOLID_METER_LED_COLOR": BLUE }));
  d = fakeDevice("led4");
  d.props["UI:SOLID_METER_LED_COLOR"] = 0x00ff00;
  await connect(d);
  assert.strictEqual(d.props["UI:SOLID_METER_LED_COLOR"], BLUE);

  // falls back to probing when the description cannot be read
  onManager({ deviceDescriptionManager: { deviceDescription: async () => { throw new Error("nope"); } } }, null);
  d = fakeDevice("i"); await connect(d);
  tap(d); await tick();
  assert.deepStrictEqual(nonLedWrites(d), [[MUTE, false], [REVERB, true]]);
  assert.deepStrictEqual(lights(d), GREEN_LIGHTS, "probed light keys work too");
  onManager(goodManager, { parseDeviceDescription: () => description });

  // --- settings and bridge ---
  const state = await call("state");
  assert.strictEqual(state.mode, "reverb");
  assert.strictEqual(state.greenLeds, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(userData, "tap-action.json"))),
    { mode: "reverb", greenLeds: true, autoUpdateCheck: true });
  assert.throws(() => call("set", { mode: "explode" }));
  assert.throws(() => handlers["motiv-tap-action:state"]({ senderFrame: { url: "https://evil.example" } }));

  // --- updates from GitHub ---
  assert.ok(newer("3.0.1", "3.0.0") && newer("v4.0.0", "3.9.9") && !newer("3.0.0", "3.0.0") && !newer("2.9.9", "3.0.0"));
  const api = "https://api.github.com/repos/GPTmadeit/motiv-mix-mv7i-mod/releases/latest";
  const installer = Buffer.from("@echo off\r\n");
  const assets = [
    { name: "MV7i-Mod-Installer.cmd", browser_download_url: "https://dl/installer" },
    { name: "MV7i-Mod-Installer.cmd.sha256", browser_download_url: "https://dl/sha" },
  ];
  fetchRoutes = { [api]: { tag_name: "v3.0.0", assets, html_url: "https://gh/r" } };
  assert.strictEqual((await call("checkUpdate")).state, "current");
  fetchRoutes = { [api]: { tag_name: "v3.1.0", assets, html_url: "https://gh/r" }, "https://dl/installer": installer,
    "https://dl/sha": "0000  MV7i-Mod-Installer.cmd\n" };
  const info = await call("checkUpdate");
  assert.strictEqual(info.state, "available");
  assert.strictEqual(info.latest.version, "3.1.0");
  await assert.rejects(call("installUpdate"), /checksum/, "a corrupted download is refused");
  assert.strictEqual(spawned.length, 0);
  await call("checkUpdate");
  fetchRoutes["https://dl/sha"] = crypto.createHash("sha256").update(installer).digest("hex") + "  MV7i-Mod-Installer.cmd\n";
  await call("installUpdate");
  assert.strictEqual(spawned.length, 1, "installer launched");
  assert.match(spawned[0][1].join(" "), /MV7i-Mod-Installer\.cmd" \/update$/);
  fetchRoutes = {};

  console.log("all tests passed");
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
