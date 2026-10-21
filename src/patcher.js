"use strict";
// Patches the user's own installed MOTIV Mix app.asar with the MV7i mod.
// Run by the installer through MOTIV Mix.exe with ELECTRON_RUN_AS_NODE=1, or with plain Node.
//
//   node patcher.js <resources dir> install <tap-action.js>
//   node patcher.js <resources dir> uninstall
//   node patcher.js <resources dir> status
//
// Nothing from MOTIV Mix is shipped with the mod: the original archive is read from the
// user's machine, a few hooks are inserted, and the mod file is added next to main.js.
process.noAsar = true; // treat .asar files as plain files under Electron
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MOD_FILE = "tap-action.js";
const BACKUP = "app.asar.mod-original";
const LEGACY_BACKUP_DIR = "tap-action-backup"; // used by the v1/v2 zip installers

const MAIN_PATCHES = [
  // Give the mod the device description manager and its parser.
  ["async #init(){this.deviceDescriptionManager=this.#interop.descriptionManager;",
   "async #init(){this.deviceDescriptionManager=this.#interop.descriptionManager;"
   + "globalThis.__motivTapAction?.onManager(this,system_api_service_interfaces_dist_src.JsonV2DeviceDescriptionParser);"],
  // Tell the mod about every device state change (connect, reconnect).
  ["processDeviceStateChange(device,networkDeviceDiscoveryStatus){device.deviceStatus=networkDeviceDiscoveryStatus,"
   + "this.#devicesMap.set(device.hardwareId,device),",
   "processDeviceStateChange(device,networkDeviceDiscoveryStatus){device.deviceStatus=networkDeviceDiscoveryStatus,"
   + "this.#devicesMap.set(device.hardwareId,device),globalThis.__motivTapAction?.onDevice(device),"],
  // Let the mod see every property write, so it can tell the app's writes from taps.
  ["updateProperty(key,value1,options){return ndl_device_manager_Log.debug(",
   "updateProperty(key,value1,options){return globalThis.__motivTapAction?.onWrite(this,key,value1),ndl_device_manager_Log.debug("],
];
const MAIN_PRELUDE = `try{require("./${MOD_FILE}")}catch(e){console.error("[mv7i-mod] failed to load",e)}\n`;
const PRELOAD_SUFFIX = "\n;(()=>{const{contextBridge,ipcRenderer}=require(\"electron\");"
  + "contextBridge.exposeInMainWorld(\"motivTapAction\",{call:(name,arg)=>ipcRenderer.invoke(\"motiv-tap-action:\"+name,arg)})})();\n";

class UserError extends Error {}

// ---- asar archive format: [uint32 4][uint32 headerSize][uint32 payload][uint32 jsonLength][json][padding][files] ----

function readAsar(file) {
  const buf = fs.readFileSync(file);
  const headerSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const header = JSON.parse(buf.toString("utf8", 16, 16 + jsonLength));
  return { buf, header, base: 8 + headerSize };
}

function fileEntry(header, name) {
  return header.files[name];
}

function readFile(asar, name) {
  const entry = fileEntry(asar.header, name);
  if (entry === undefined || entry.unpacked) throw new UserError(`${name} is missing from app.asar`);
  const start = asar.base + Number(entry.offset);
  return asar.buf.subarray(start, start + entry.size);
}

const BLOCK_SIZE = 4 * 1024 * 1024;
function integrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += BLOCK_SIZE) {
    blocks.push(crypto.createHash("sha256").update(data.subarray(i, i + BLOCK_SIZE)).digest("hex"));
  }
  return { algorithm: "SHA256", hash: crypto.createHash("sha256").update(data).digest("hex"), blockSize: BLOCK_SIZE, blocks };
}

// Rewrites the archive with some top-level files replaced or added. Unpacked files stay where they are.
function writeAsar(asar, replacements, out) {
  const header = structuredClone(asar.header);
  for (const [name, data] of Object.entries(replacements)) {
    const old = header.files[name] ?? {};
    header.files[name] = { size: data.length, offset: "0", ...(old.executable ? { executable: true } : {}), integrity: integrity(data) };
  }
  const chunks = [];
  let offset = 0;
  (function walk(dir, prefix) {
    for (const [name, entry] of Object.entries(dir.files)) {
      if (entry.files) walk(entry, prefix + name + "/");
      else if (entry.link === undefined && !entry.unpacked) {
        const data = prefix === "" && name in replacements ? replacements[name]
          : asar.buf.subarray(asar.base + Number(entry.offset), asar.base + Number(entry.offset) + entry.size);
        entry.offset = String(offset);
        offset += data.length;
        chunks.push(data);
      }
    }
  })(header, "");
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  const fd = fs.openSync(out, "w");
  try {
    fs.writeSync(fd, prefix);
    for (const chunk of chunks) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- mod ----

const isModded = asar => fileEntry(asar.header, MOD_FILE) !== undefined;
const appVersion = asar => {
  try { return JSON.parse(readFile(asar, "package.json").toString("utf8")).version; } catch { return "unknown"; }
};
const modVersion = asar => {
  try { return /MOD_VERSION = "([^"]+)"/.exec(readFile(asar, MOD_FILE).toString("utf8"))?.[1] ?? "unknown"; } catch { return "unknown"; }
};

function patchMain(text, version) {
  for (const [anchor, replacement] of MAIN_PATCHES) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      throw new UserError(`MOTIV Mix ${version} is not supported by this mod version (a code anchor was found ${count} times). `
        + "Check the GitHub page for a newer mod release.");
    }
    text = text.replace(anchor, () => replacement);
  }
  return MAIN_PRELUDE + text;
}

function buildPatched(original, modSource, out) {
  const version = appVersion(original);
  const main = patchMain(readFile(original, "main.js").toString("utf8"), version);
  const preload = readFile(original, "preload.js").toString("utf8") + PRELOAD_SUFFIX;
  writeAsar(original, {
    "main.js": Buffer.from(main, "utf8"),
    "preload.js": Buffer.from(preload, "utf8"),
    [MOD_FILE]: modSource,
  }, out);
  return version;
}

// Finds an unmodified copy of app.asar, making the backup on first install.
function pristine(resources) {
  const live = path.join(resources, "app.asar");
  const backup = path.join(resources, BACKUP);
  const legacy = path.join(resources, LEGACY_BACKUP_DIR, "app.asar");
  if (!isModded(readAsar(live))) {
    // First install, or MOTIV Mix updated itself over the mod: this is the new original.
    fs.copyFileSync(live, backup);
  } else if (!fs.existsSync(backup)) {
    if (!fs.existsSync(legacy)) {
      throw new UserError("MOTIV Mix is already modified but no original backup was found. Reinstall MOTIV Mix, then run this again.");
    }
    fs.copyFileSync(legacy, backup);
  }
  const original = readAsar(backup);
  if (isModded(original)) throw new UserError(`The backup ${BACKUP} is not an original MOTIV Mix archive.`);
  return original;
}

function removeLegacyBackup(resources) {
  // The v1/v2 zip moved app.asar.unpacked into its backup and copied an identical one in; drop the spare copy.
  fs.rmSync(path.join(resources, LEGACY_BACKUP_DIR), { recursive: true, force: true });
}

function install(resources, modPath) {
  const original = pristine(resources);
  const live = path.join(resources, "app.asar");
  const temp = live + ".mod-new";
  try {
    const version = buildPatched(original, fs.readFileSync(modPath), temp);
    // Sanity check the result before swapping it in.
    const check = readAsar(temp);
    if (!isModded(check) || !readFile(check, "main.js").toString("utf8").includes("__motivTapAction?.onDevice")) {
      throw new UserError("The patched archive failed verification; nothing was changed.");
    }
    fs.renameSync(temp, live);
    removeLegacyBackup(resources);
    return { ok: true, action: "installed", appVersion: version, modVersion: modVersion(check) };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function uninstall(resources) {
  const live = path.join(resources, "app.asar");
  const backup = path.join(resources, BACKUP);
  const legacyDir = path.join(resources, LEGACY_BACKUP_DIR);
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, live);
    fs.rmSync(backup);
  } else if (fs.existsSync(path.join(legacyDir, "app.asar"))) {
    fs.copyFileSync(path.join(legacyDir, "app.asar"), live);
  } else if (isModded(readAsar(live))) {
    throw new UserError("No original backup found. Reinstall MOTIV Mix to remove the mod.");
  }
  removeLegacyBackup(resources);
  return { ok: true, action: "uninstalled" };
}

function status(resources) {
  const live = readAsar(path.join(resources, "app.asar"));
  return { ok: true, installed: isModded(live), appVersion: appVersion(live), modVersion: isModded(live) ? modVersion(live) : null };
}

if (require.main === module) {
  const [resources, command, modPath] = process.argv.slice(2);
  let result;
  try {
    if (!resources || !fs.existsSync(path.join(resources, "app.asar"))) throw new UserError(`No app.asar in ${resources}`);
    if (command === "install") result = install(resources, modPath);
    else if (command === "uninstall") result = uninstall(resources);
    else if (command === "status") result = status(resources);
    else throw new UserError(`unknown command ${command}`);
  } catch (err) {
    result = { ok: false, error: err instanceof UserError ? err.message : String(err.stack ?? err) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  // MOTIV Mix.exe is a GUI program, so the installer reads the result from a file instead of stdout.
  if (process.env.MOD_RESULT) fs.writeFileSync(process.env.MOD_RESULT, JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { readAsar, readFile, writeAsar, buildPatched, install, uninstall, status, patchMain };
