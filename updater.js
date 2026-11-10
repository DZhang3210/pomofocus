// updater.js
//
// Keeps installed copies up to date from this repo's GitHub Releases.
//
// Windows: Electron's built-in autoUpdater (Squirrel.Windows), fed by the
//   free update.electronjs.org service for public GitHub repos. Downloads
//   in the background and asks to restart.
//
// macOS: Electron's built-in updater refuses to install anything that isn't
//   signed with a paid Apple Developer ID, so instead this checks the latest
//   GitHub release itself, downloads the zip for this Mac's CPU, verifies its
//   SHA-256 checksum, and swaps the new app in place of the old one.

const { app, autoUpdater, dialog, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const REPO = "DZhang3210/pomofocus";
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// --- Pure helpers (no Electron needed; covered by scripts/test-updater.js) ---

// Compares "1.10.0" vs "v1.9.2" numerically. Returns 1, 0 or -1.
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split("-")[0].split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Finds this Mac's zip and its checksum file in a GitHub release.
function pickMacAssets(release, arch) {
  const version = String(release.tag_name).replace(/^v/, "");
  const zipName = `Pomofocus-darwin-${arch}-${version}.zip`;
  const zip = release.assets.find((a) => a.name === zipName);
  const sha = release.assets.find((a) => a.name === `${zipName}.sha256`);
  if (!zip || !sha) return null;
  return { version, zip, sha };
}

// Reads the hash out of `shasum -a 256` output ("<hex>  <filename>").
function parseSha256File(text) {
  const hash = String(text).trim().split(/\s+/)[0].toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function downloadToFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// --- Shared state ---

let manualCheckInProgress = false;
let updateReady = false;

function info(message, detail) {
  return dialog.showMessageBox({ type: "info", message, detail, buttons: ["OK"] });
}

async function askToRestart(version) {
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: `Pomofocus ${version} is ready to install.`,
    detail: "Restart now to update, or it will update the next time you quit.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

// --- Windows ---

function setUpWindows(onBeforeRestart) {
  // Only an app installed by Pomofocus-Setup.exe can update itself; a copy
  // run straight from an unzipped folder has no Squirrel Update.exe.
  const updateExe = path.resolve(process.execPath, "..", "..", "Update.exe");
  if (!fs.existsSync(updateExe)) return null;
  // Squirrel holds a lock on the very first run after install.
  if (process.argv.includes("--squirrel-firstrun")) return null;

  const feed = `https://update.electronjs.org/${REPO}/${process.platform}-${process.arch}/${app.getVersion()}`;
  autoUpdater.setFeedURL({ url: feed });

  autoUpdater.on("update-not-available", () => {
    if (manualCheckInProgress) info("You're up to date.", `Pomofocus ${app.getVersion()} is the latest version.`);
    manualCheckInProgress = false;
  });
  autoUpdater.on("update-available", () => {
    if (manualCheckInProgress) info("An update is downloading.", "You'll be asked to restart when it's ready.");
    manualCheckInProgress = false;
  });
  autoUpdater.on("error", (err) => {
    if (manualCheckInProgress) info("Couldn't check for updates.", String(err && err.message));
    manualCheckInProgress = false;
  });
  autoUpdater.on("update-downloaded", async (_event, _notes, releaseName) => {
    updateReady = true;
    if (await askToRestart(releaseName || "A new version")) {
      onBeforeRestart();
      autoUpdater.quitAndInstall();
    }
    // If "Later", Squirrel applies the update on the next launch by itself.
  });

  return () => {
    if (!updateReady) autoUpdater.checkForUpdates();
  };
}

// --- macOS ---

function macBundlePath() {
  // .../Pomofocus.app/Contents/MacOS/Pomofocus -> .../Pomofocus.app
  return path.resolve(process.execPath, "..", "..", "..");
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function findApp(dir) {
  const name = fs.readdirSync(dir).find((n) => n.endsWith(".app"));
  return name ? path.join(dir, name) : null;
}

// Writes a small shell script that waits for this app to exit, swaps the
// new bundle in (rolling back if the move fails), and optionally relaunches.
// The outcome goes to a status file so the next launch can report a failure.
function writeSwapScript(stagingDir, currentApp, newApp, statusFile) {
  const script = path.join(stagingDir, "swap.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
PID="$1"; CUR="$2"; NEW="$3"; STATUS="$4"; RELAUNCH="$5"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
rm -rf "$CUR.old"
if mv "$CUR" "$CUR.old"; then
  if mv "$NEW" "$CUR"; then
    rm -rf "$CUR.old"
    echo ok > "$STATUS"
  else
    mv "$CUR.old" "$CUR"
    echo "failed $NEW" > "$STATUS"
  fi
else
  echo "failed $NEW" > "$STATUS"
fi
if [ "$RELAUNCH" = "1" ]; then open "$CUR"; fi
`,
    { mode: 0o755 }
  );
  return script;
}

function setUpMac(onBeforeRestart) {
  const currentApp = macBundlePath();
  const statusFile = path.join(app.getPath("userData"), "mac-update-status.txt");
  let pending = null; // { script, newApp }
  let busy = false;

  // Report how the last swap went, then forget it.
  if (fs.existsSync(statusFile)) {
    const status = fs.readFileSync(statusFile, "utf8").trim();
    fs.rmSync(statusFile, { force: true });
    if (status.startsWith("failed ")) {
      const newApp = status.slice("failed ".length);
      app.whenReady().then(async () => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          message: "Pomofocus couldn't replace itself with the new version.",
          detail:
            "macOS may be blocking it. Allow Pomofocus under System Settings › Privacy & Security › App Management, " +
            "or drag the new version into your Applications folder yourself.",
          buttons: ["Show New Version", "OK"],
        });
        if (response === 0 && fs.existsSync(newApp)) shell.showItemInFolder(newApp);
      });
    }
  }

  function launchSwap(relaunch) {
    if (!pending || pending.launched) return;
    pending.launched = true;
    spawn(
      "/bin/sh",
      [pending.script, String(process.pid), currentApp, pending.newApp, statusFile, relaunch ? "1" : "0"],
      { detached: true, stdio: "ignore" }
    ).unref();
  }

  // If the user picked "Later", swap in the new version once they quit.
  app.on("will-quit", () => launchSwap(false));

  async function check() {
    if (busy || pending) {
      if (manualCheckInProgress && pending) info("An update is ready.", "Quit Pomofocus to install it.");
      manualCheckInProgress = false;
      return;
    }
    busy = true;
    const manual = manualCheckInProgress;
    manualCheckInProgress = false;
    try {
      if (currentApp.includes("/AppTranslocation/")) {
        if (manual) info("Move Pomofocus to Applications first.", "macOS is running it from a temporary location, so it can't update itself.");
        return;
      }
      fs.accessSync(path.dirname(currentApp), fs.constants.W_OK);

      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const release = await res.json();

      if (compareVersions(release.tag_name, app.getVersion()) <= 0) {
        if (manual) info("You're up to date.", `Pomofocus ${app.getVersion()} is the latest version.`);
        return;
      }
      const assets = pickMacAssets(release, process.arch);
      if (!assets) throw new Error(`Release ${release.tag_name} has no macOS ${process.arch} download.`);
      if (manual) info("An update is downloading.", "You'll be asked to restart when it's ready.");

      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "pomofocus-update-"));
      const zipPath = path.join(stagingDir, assets.zip.name);

      const shaRes = await fetch(assets.sha.browser_download_url, { redirect: "follow" });
      const expected = parseSha256File(await shaRes.text());
      if (!expected) throw new Error("Checksum file is unreadable.");
      await downloadToFile(assets.zip.browser_download_url, zipPath);
      const actual = await sha256OfFile(zipPath);
      if (actual !== expected) throw new Error("Downloaded update failed its checksum check.");

      const extractDir = path.join(stagingDir, "app");
      fs.mkdirSync(extractDir);
      await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
      fs.rmSync(zipPath, { force: true });
      const newApp = findApp(extractDir);
      if (!newApp) throw new Error("The update didn't contain an app.");
      await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp]).catch(() => {});

      pending = { script: writeSwapScript(stagingDir, currentApp, newApp, statusFile), newApp };
      if (await askToRestart(assets.version)) {
        launchSwap(true);
        onBeforeRestart();
        app.quit();
      }
    } catch (err) {
      if (err && err.code === "EACCES") {
        if (manual) info("Pomofocus can't update itself here.", "Move it into your Applications folder and try again.");
      } else if (manual) {
        info("Couldn't check for updates.", String(err && err.message));
      } else {
        console.error("Update check failed:", err);
      }
    } finally {
      busy = false;
    }
  }

  return check;
}

// --- Entry point ---

let checkNow = null;

// onBeforeRestart lets main.js stop its "hide on close" behavior so the app
// can actually quit when an update needs a restart.
function initUpdater({ onBeforeRestart }) {
  if (!app.isPackaged) return;
  if (process.platform === "win32") checkNow = setUpWindows(onBeforeRestart);
  else if (process.platform === "darwin") checkNow = setUpMac(onBeforeRestart);
  if (!checkNow) return;
  setTimeout(checkNow, FIRST_CHECK_DELAY_MS);
  setInterval(checkNow, CHECK_INTERVAL_MS);
}

// Called from the "Check for Updates…" menu item.
function checkForUpdatesManually() {
  if (!checkNow) {
    info(
      "Updates aren't available for this copy.",
      app.isPackaged
        ? "Install Pomofocus from the GitHub Releases page to get automatic updates."
        : "You're running from source; pull the latest code instead."
    );
    return;
  }
  manualCheckInProgress = true;
  checkNow();
}

module.exports = {
  initUpdater,
  checkForUpdatesManually,
  // exported for scripts/test-updater.js
  compareVersions,
  pickMacAssets,
  parseSha256File,
  sha256OfFile,
  downloadToFile,
  writeSwapScript,
};
