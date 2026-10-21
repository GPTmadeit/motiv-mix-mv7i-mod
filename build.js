"use strict";
// Builds dist/MV7i-Mod-Installer.cmd: a batch launcher + PowerShell installer with the mod
// files embedded as base64, so the whole installer is one double-clickable file.
//   node build.js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const base64 = file => fs.readFileSync(path.join(root, file)).toString("base64").replace(/.{1,100}/g, "$&\n").trimEnd();

const modSource = read("src/tap-action.js");
const version = /const MOD_VERSION = "([^"]+)"/.exec(modSource)[1];

// cmd runs the first block and hands the whole file to PowerShell, which skips it as a comment.
const LAUNCHER = `<# : MV7i Touch Panel Mod installer - double-click to run
@echo off
setlocal
set "MOD_SELF=%~f0"
set "MOD_ARGS=%*"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:MOD_SELF))"
exit /b %ERRORLEVEL%
#>
`;

const script = read("installer/installer.ps1")
  .replace("__MOD_VERSION__", () => version)
  .replace("__PAYLOAD_PATCHER__", () => base64("src/patcher.js"))
  .replace("__PAYLOAD_MOD__", () => base64("src/tap-action.js"));

const text = (LAUNCHER + script).replace(/\r?\n/g, "\r\n");
if (/[^\x00-\x7f]/.test(text)) throw new Error("installer must be plain ASCII for cmd.exe");

const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, "MV7i-Mod-Installer.cmd");
fs.writeFileSync(out, text);
const hash = crypto.createHash("sha256").update(text).digest("hex");
fs.writeFileSync(out + ".sha256", `${hash}  MV7i-Mod-Installer.cmd\n`);
console.log(`built ${out} (v${version}, ${text.length} bytes, sha256 ${hash})`);
