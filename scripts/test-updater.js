// Checks the parts of updater.js that don't need a real Mac or a real
// release: version comparison, asset picking, checksum verification,
// downloading, and the swap script (success and rollback).
// Run with: npm run test:updater   (needs `sh` on PATH; Git Bash works on Windows)

const assert = require("assert");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const u = require("../updater");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok   ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}\n     ${err.stack}`);
      process.exitCode = 1;
    });
}

(async () => {
  await test("compareVersions", () => {
    assert.strictEqual(u.compareVersions("v1.3.0", "1.2.9"), 1);
    assert.strictEqual(u.compareVersions("1.10.0", "1.9.0"), 1);
    assert.strictEqual(u.compareVersions("v1.3.0", "1.3.0"), 0);
    assert.strictEqual(u.compareVersions("1.2.0", "v1.3.0"), -1);
    assert.strictEqual(u.compareVersions("2.0", "1.99.99"), 1);
  });

  await test("pickMacAssets finds this Mac's zip and checksum", () => {
    const release = {
      tag_name: "v1.4.0",
      assets: [
        { name: "Pomofocus-Setup.exe" },
        { name: "Pomofocus-darwin-arm64-1.4.0.zip" },
        { name: "Pomofocus-darwin-arm64-1.4.0.zip.sha256" },
        { name: "Pomofocus-darwin-x64-1.4.0.zip" },
        { name: "Pomofocus-darwin-x64-1.4.0.zip.sha256" },
      ],
    };
    const arm = u.pickMacAssets(release, "arm64");
    assert.strictEqual(arm.version, "1.4.0");
    assert.strictEqual(arm.zip.name, "Pomofocus-darwin-arm64-1.4.0.zip");
    assert.strictEqual(arm.sha.name, "Pomofocus-darwin-arm64-1.4.0.zip.sha256");
    assert.strictEqual(u.pickMacAssets(release, "x64").zip.name, "Pomofocus-darwin-x64-1.4.0.zip");
    // No checksum file -> refuse rather than install unverified.
    const noSha = { tag_name: "v1.4.0", assets: [{ name: "Pomofocus-darwin-arm64-1.4.0.zip" }] };
    assert.strictEqual(u.pickMacAssets(noSha, "arm64"), null);
  });

  await test("parseSha256File reads shasum output", () => {
    const h = "a".repeat(64);
    assert.strictEqual(u.parseSha256File(`${h}  Pomofocus-darwin-arm64-1.4.0.zip\n`), h);
    assert.strictEqual(u.parseSha256File("not a hash"), null);
  });

  await test("downloadToFile + sha256OfFile match a served file", async () => {
    const body = crypto.randomBytes(256 * 1024);
    const expected = crypto.createHash("sha256").update(body).digest("hex");
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/file" });
        return res.end();
      }
      res.end(body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomo-test-"));
    try {
      const dest = path.join(dir, "x.zip");
      await u.downloadToFile(`http://127.0.0.1:${server.address().port}/redirect`, dest);
      assert.strictEqual(await u.sha256OfFile(dest), expected);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Simulates the app bundle swap with plain folders. PID 999999 is assumed
  // not to exist, so the script doesn't wait.
  function runSwap(setUpNew) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomo-swap-"));
    const cur = path.join(dir, "Pomofocus.app");
    const neu = path.join(dir, "staging", "Pomofocus.app");
    const status = path.join(dir, "status.txt");
    fs.mkdirSync(cur);
    fs.writeFileSync(path.join(cur, "version"), "old");
    fs.mkdirSync(path.dirname(neu));
    if (setUpNew) {
      fs.mkdirSync(neu);
      fs.writeFileSync(path.join(neu, "version"), "new");
    }
    const script = u.writeSwapScript(path.dirname(neu), cur, neu, status);
    const toSh = (p) => p.replace(/\\/g, "/");
    execFileSync("sh", [toSh(script), "999999", toSh(cur), toSh(neu), toSh(status), "0"]);
    return { dir, cur, status };
  }

  await test("swap script replaces the app", () => {
    const { dir, cur, status } = runSwap(true);
    try {
      assert.strictEqual(fs.readFileSync(path.join(cur, "version"), "utf8"), "new");
      assert.strictEqual(fs.readFileSync(status, "utf8").trim(), "ok");
      assert.ok(!fs.existsSync(`${cur}.old`), "backup should be cleaned up");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("swap script rolls back if the new app can't be moved in", () => {
    const { dir, cur, status } = runSwap(false);
    try {
      assert.strictEqual(fs.readFileSync(path.join(cur, "version"), "utf8"), "old");
      assert.ok(fs.readFileSync(status, "utf8").startsWith("failed "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})();
