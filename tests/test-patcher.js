"use strict";
// Tests src/patcher.js against a real, unmodified MOTIV Mix app.asar (not included in this repo).
//   node tests/test-patcher.js "C:\Program Files\Shure\MOTIV Mix\resources\app.asar"
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const patcher = require("../src/patcher.js");

const original = process.argv[2];
if (!original) {
  console.error("usage: node tests/test-patcher.js <original app.asar>");
  process.exit(2);
}
const mod = path.join(__dirname, "..", "src", "tap-action.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv7i-patcher-test-"));
const live = path.join(dir, "app.asar");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalHash = hash(original);

try {
  fs.copyFileSync(original, live);
  assert.strictEqual(patcher.status(dir).installed, false);

  const result = patcher.install(dir, mod);
  assert.ok(result.ok);
  const asar = patcher.readAsar(live);
  assert.strictEqual(patcher.readFile(asar, "tap-action.js").toString(), fs.readFileSync(mod, "utf8"));
  const main = patcher.readFile(asar, "main.js").toString();
  for (const hook of ["onManager", "onDevice", "onWrite"]) assert.ok(main.includes(`__motivTapAction?.${hook}(`), hook);
  assert.ok(patcher.readFile(asar, "preload.js").toString().includes("motivTapAction"));
  // every other file is byte-identical to the original
  const before = patcher.readAsar(original);
  (function walk(a, b, prefix) {
    for (const [name, entry] of Object.entries(a.files)) {
      if (entry.files) { walk(entry, b.files[name], prefix + name + "/"); continue; }
      if (entry.unpacked || entry.link !== undefined || ["main.js", "preload.js"].includes(prefix + name)) continue;
      const read = (x, e) => x.buf.subarray(x.base + Number(e.offset), x.base + Number(e.offset) + e.size);
      assert.ok(read(before, entry).equals(read(asar, b.files[name])), prefix + name);
    }
  })(before.header, asar.header, "");

  const first = hash(live);
  patcher.install(dir, mod);
  assert.strictEqual(hash(live), first, "reinstall is repeatable");

  fs.copyFileSync(original, live); // MOTIV Mix updated itself over the mod
  patcher.install(dir, mod);
  assert.strictEqual(hash(live), first);

  patcher.uninstall(dir);
  assert.strictEqual(hash(live), originalHash, "uninstall restores the original");
  assert.ok(!fs.existsSync(path.join(dir, "app.asar.mod-original")));

  assert.throws(() => patcher.patchMain("no anchors", "9.9.9"), /not supported/);
  console.log("all patcher tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
