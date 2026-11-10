// cloud-sync.js
//
// Shares today's focus sessions across devices through an S3 bucket.
//
// Each device uploads only its own file for the day:
//   pomofocus/days/<YYYY-MM-DD>/<deviceId>.json
// so devices never overwrite each other. To show today's totals, a device
// lists that day's folder and reads every other device's file. The local CSV
// log stays the source of truth; S3 is just a shared copy, re-uploaded in
// full each time, so a failed upload fixes itself on the next one.

const crypto = require("crypto");
const os = require("os");
const { AwsClient } = require("aws4fetch");

const PREFIX = "pomofocus/days";
const REQUEST_TIMEOUT_MS = 8000;

function todayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
}

class CloudSync {
  // store: electron-store instance
  // encrypt/decrypt: protect the secret key at rest (Electron safeStorage)
  constructor({ store, encrypt, decrypt }) {
    this.store = store;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    if (!store.get("sync.deviceId")) store.set("sync.deviceId", crypto.randomUUID());
    this.lastError = null;
  }

  get deviceId() {
    return this.store.get("sync.deviceId");
  }

  get deviceName() {
    return this.store.get("sync.deviceName") || os.hostname();
  }

  // Settings as shown in the UI. The secret itself never leaves this process.
  getPublicConfig() {
    const c = this.store.get("sync.config") || {};
    return {
      enabled: Boolean(c.enabled),
      bucket: c.bucket || "",
      region: c.region || "us-east-1",
      endpoint: c.endpoint || "",
      accessKeyId: c.accessKeyId || "",
      hasSecret: Boolean(c.secretEnc),
      deviceName: this.deviceName,
    };
  }

  // A blank secretAccessKey keeps the one already saved.
  saveConfig({ enabled, bucket, region, endpoint, accessKeyId, secretAccessKey, deviceName }) {
    const prev = this.store.get("sync.config") || {};
    const next = {
      enabled: Boolean(enabled),
      bucket: String(bucket || "").trim(),
      region: String(region || "").trim() || "us-east-1",
      endpoint: String(endpoint || "").trim().replace(/\/+$/, ""),
      accessKeyId: String(accessKeyId || "").trim(),
      secretEnc: secretAccessKey ? this.encrypt(String(secretAccessKey).trim()) : prev.secretEnc,
    };
    this.store.set("sync.config", next);
    if (deviceName !== undefined) this.store.set("sync.deviceName", String(deviceName).trim());
  }

  // Full config including the decrypted secret, optionally overridden by
  // unsaved values from the settings form (for "Test Connection").
  resolveConfig(overrides = {}) {
    const c = { ...(this.store.get("sync.config") || {}) };
    for (const k of ["bucket", "region", "endpoint", "accessKeyId"]) {
      if (overrides[k] !== undefined) c[k] = String(overrides[k]).trim();
    }
    c.endpoint = (c.endpoint || "").replace(/\/+$/, "");
    c.region = c.region || "us-east-1";
    c.secretAccessKey = overrides.secretAccessKey
      ? String(overrides.secretAccessKey).trim()
      : c.secretEnc
      ? this.decrypt(c.secretEnc)
      : "";
    return c;
  }

  isEnabled() {
    const c = this.store.get("sync.config") || {};
    return Boolean(c.enabled && c.bucket && c.accessKeyId && c.secretEnc);
  }

  // --- S3 plumbing ---

  _client(c) {
    if (!c.bucket || !c.accessKeyId || !c.secretAccessKey) {
      throw new Error("Bucket, access key ID and secret access key are all required.");
    }
    const aws = new AwsClient({
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      service: "s3",
      region: c.region,
    });
    // Path-style for custom endpoints (MinIO, R2, test servers); the normal
    // virtual-hosted style for Amazon S3 itself.
    const base = c.endpoint
      ? `${c.endpoint}/${encodeURIComponent(c.bucket)}`
      : `https://${c.bucket}.s3.${c.region}.amazonaws.com`;
    const request = async (method, pathAndQuery, body) => {
      const res = await aws.fetch(`${base}/${pathAndQuery}`, {
        method,
        body,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
        const message = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
        throw new Error(`S3 ${method} failed (${res.status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`);
      }
      return res;
    };
    return { request };
  }

  async _listKeys(s3, prefix) {
    const keys = [];
    let token = null;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix });
      if (token) q.set("continuation-token", token);
      const xml = await (await s3.request("GET", `?${q}`)).text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1]
        : null;
    } while (token);
    return keys;
  }

  // --- Public operations ---

  // Uploads this device's sessions for `date` (replacing the previous copy).
  async uploadDay(date, sessions, overrides) {
    const s3 = this._client(this.resolveConfig(overrides));
    const body = JSON.stringify({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      date,
      updatedAt: new Date().toISOString(),
      sessions: sessions.map(({ start, end, durationMinutes }) => ({ start, end, durationMinutes })),
    });
    await s3.request("PUT", `${PREFIX}/${date}/${this.deviceId}.json`, body);
  }

  // Reads every other device's file for `date`.
  async fetchOtherDevices(date, overrides) {
    const s3 = this._client(this.resolveConfig(overrides));
    const keys = await this._listKeys(s3, `${PREFIX}/${date}/`);
    const others = keys.filter((k) => k.endsWith(".json") && !k.endsWith(`/${this.deviceId}.json`));
    const results = await Promise.all(
      others.map(async (key) => {
        try {
          const data = await (await s3.request("GET", key)).json();
          if (data.date !== date || !Array.isArray(data.sessions)) return null;
          return {
            deviceId: data.deviceId,
            deviceName: String(data.deviceName || "Another device"),
            sessions: data.sessions.filter(
              (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isFinite(s.durationMinutes)
            ),
          };
        } catch {
          return null; // one unreadable file shouldn't hide the rest
        }
      })
    );
    return results.filter(Boolean);
  }

  // Upload today's sessions, then read everyone else's. Used by Summary and
  // by "Test Connection" (which also proves list, write and read all work).
  async syncToday(localSessions, overrides) {
    const date = todayKey();
    try {
      await this.uploadDay(date, localSessions, overrides);
      const others = await this.fetchOtherDevices(date, overrides);
      this.lastError = null;
      return { ok: true, others };
    } catch (err) {
      this.lastError = err.message;
      return { ok: false, error: err.message, others: [] };
    }
  }
}

// Combines this device's summary with other devices' sessions.
function mergeSummaries(local, others, localDeviceName) {
  const devices = [
    { name: localDeviceName, count: local.count, minutes: local.totalMinutes, isThisDevice: true },
  ];
  let count = local.count;
  let totalMinutes = local.totalMinutes;
  const sessions = local.sessions.map((s) => ({ ...s, device: localDeviceName }));
  for (const o of others) {
    const minutes = o.sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
    devices.push({ name: o.deviceName, count: o.sessions.length, minutes, isThisDevice: false });
    count += o.sessions.length;
    totalMinutes += minutes;
    for (const s of o.sessions) sessions.push({ ...s, device: o.deviceName });
  }
  sessions.sort((a, b) => a.start - b.start);
  return { count, totalMinutes: Math.round(totalMinutes * 10) / 10, sessions, devices };
}

module.exports = { CloudSync, mergeSummaries, todayKey };
