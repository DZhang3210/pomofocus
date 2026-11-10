// Exercises cloud-sync.js against a local fake S3 server (s3rver), with two
// simulated devices sharing one bucket. Run with: npm run test:sync

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S3rver = require("s3rver");
const { CloudSync, mergeSummaries, todayKey } = require("../cloud-sync");

// s3rver accepts this fixed key pair and rejects anything else.
const KEY_ID = "S3RVER";
const SECRET = "S3RVER";
const BUCKET = "pomofocus-test";

// Minimal stand-in for electron-store.
function fakeStore() {
  const data = {};
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    raw: data,
  };
}

// Stand-in for safeStorage: reversible, but visibly not plaintext.
const encrypt = (s) => `enc:${Buffer.from(s).toString("hex")}`;
const decrypt = (s) => Buffer.from(s.slice(4), "hex").toString();

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.stack}`);
    process.exitCode = 1;
  }
}

function device(name, endpoint) {
  const sync = new CloudSync({ store: fakeStore(), encrypt, decrypt });
  sync.saveConfig({
    enabled: true,
    bucket: BUCKET,
    region: "us-east-1",
    endpoint,
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    deviceName: name,
  });
  return sync;
}

const session = (startMin, durationMinutes) => {
  const start = new Date().setHours(9, 0, 0, 0) + startMin * 60000;
  return { start, end: start + durationMinutes * 60000, durationMinutes };
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pomo-s3-"));
  const server = new S3rver({
    port: 0,
    address: "127.0.0.1",
    silent: true,
    directory: dir,
    configureBuckets: [{ name: BUCKET }],
  });
  const { port } = await server.run();
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const desktop = device("Desktop", endpoint);
    const laptop = device("MacBook", endpoint);

    await test("secret key is stored encrypted, never in plain text", () => {
      const saved = desktop.store.raw["sync.config"];
      assert.ok(!("secretAccessKey" in saved));
      assert.strictEqual(saved.secretEnc, encrypt(SECRET));
      assert.strictEqual(desktop.getPublicConfig().hasSecret, true);
      assert.ok(!("secretAccessKey" in desktop.getPublicConfig()));
    });

    await test("devices get different IDs", () => {
      assert.notStrictEqual(desktop.deviceId, laptop.deviceId);
    });

    const desktopSessions = [session(0, 25), session(30, 25)];
    const laptopSessions = [session(120, 31.5)];

    await test("each device sees the other's sessions, not its own twice", async () => {
      await desktop.uploadDay(todayKey(), desktopSessions);
      const r = await laptop.syncToday(laptopSessions);
      assert.ok(r.ok, r.error);
      assert.strictEqual(r.others.length, 1);
      assert.strictEqual(r.others[0].deviceName, "Desktop");
      assert.strictEqual(r.others[0].sessions.length, 2);

      const back = await desktop.syncToday(desktopSessions);
      assert.ok(back.ok, back.error);
      assert.deepStrictEqual(back.others.map((o) => o.deviceName), ["MacBook"]);
    });

    await test("re-uploading replaces a device's file instead of adding to it", async () => {
      const more = [...desktopSessions, session(60, 25)];
      await desktop.uploadDay(todayKey(), more);
      const r = await laptop.syncToday(laptopSessions);
      assert.strictEqual(r.others[0].sessions.length, 3);
    });

    await test("mergeSummaries adds up counts and minutes per device", () => {
      const local = { count: 1, totalMinutes: 31.5, sessions: laptopSessions };
      const others = [{ deviceName: "Desktop", sessions: [...desktopSessions, session(60, 25)] }];
      const m = mergeSummaries(local, others, "MacBook");
      assert.strictEqual(m.count, 4);
      assert.strictEqual(m.totalMinutes, 106.5);
      assert.strictEqual(m.sessions.length, 4);
      assert.ok(m.sessions.every((s, i, a) => i === 0 || a[i - 1].start <= s.start), "sorted by time");
      assert.deepStrictEqual(
        m.devices.map((d) => [d.name, d.count, d.isThisDevice]),
        [
          ["MacBook", 1, true],
          ["Desktop", 3, false],
        ]
      );
    });

    // s3rver doesn't verify signatures, so a wrong secret can't be tested
    // here; it does reject unknown access key IDs.
    await test("a wrong access key gives a readable error", async () => {
      const r = await desktop.syncToday(desktopSessions, { accessKeyId: "WRONGKEY" });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /403|SignatureDoesNotMatch|InvalidAccessKeyId/);
    });

    await test("a missing bucket gives a readable error", async () => {
      const r = await desktop.syncToday(desktopSessions, { bucket: "no-such-bucket" });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /404|NoSuchBucket/);
    });

    await test("a blank secret on save keeps the saved one", async () => {
      desktop.saveConfig({ ...desktop.getPublicConfig(), endpoint, secretAccessKey: "" });
      const r = await desktop.syncToday(desktopSessions);
      assert.ok(r.ok, r.error);
    });

    await test("unreachable server fails without hanging", async () => {
      const t = Date.now();
      const r = await desktop.syncToday(desktopSessions, { endpoint: "http://127.0.0.1:9" });
      assert.strictEqual(r.ok, false);
      assert.ok(Date.now() - t < 10000);
    });

    await test("a corrupt file from another device is skipped", async () => {
      const tablet = device("Tablet", endpoint);
      await tablet.uploadDay(todayKey(), [{ start: "bad", end: 1, durationMinutes: 5 }]);
      const r = await laptop.syncToday(laptopSessions);
      const tab = r.others.find((o) => o.deviceName === "Tablet");
      assert.strictEqual(tab.sessions.length, 0);
      // The earlier test re-uploaded the desktop's 2 original sessions.
      assert.strictEqual(r.others.find((o) => o.deviceName === "Desktop").sessions.length, 2);
    });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})();
