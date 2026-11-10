// main.js

// Modules to control application life and create native browser window
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  ipcMain,
  shell,
  dialog,
  Tray,
  safeStorage,
} = require("electron");

// The Windows installer (Squirrel) launches the app with --squirrel-* flags
// to create/remove shortcuts during install, update and uninstall. Handle
// those and exit right away instead of opening the app mid-install.
if (require("electron-squirrel-startup")) {
  app.quit();
  return;
}

const { initUpdater, checkForUpdatesManually } = require("./updater");
const { CloudSync, mergeSummaries, todayKey } = require("./cloud-sync");
const windowStateKeeper = require("electron-window-state");
const Store = require("electron-store");
const fs = require("fs");
const path = require("path");

const ICON_FILENAME =
  process.platform === "darwin"
    ? "icon.icns"
    : process.platform === "win32"
    ? "icon.ico"
    : "icon.png";
const ICON_PATH = path.join(__dirname, "assets", ICON_FILENAME);
// Tray() loads its icon via nativeImage, which can't decode the .icns format
// used for the macOS window/dock icon -- use the universally-supported PNG.
const TRAY_ICON_PATH = path.join(__dirname, "assets", "icon.png");

// Only one running copy at a time -- if the app is already running
// (possibly hidden in the tray), a second launch just focuses that
// window instead of spawning a duplicate.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

// --- Persistent focus-time log ---
// A plain CSV on disk (Documents/Pomofocus/focus-log.csv) recording every
// completed Pomodoro, independent of the app's own settings store.
const LOG_DIR = path.join(app.getPath("documents"), "Pomofocus");
const LOG_FILE = path.join(LOG_DIR, "focus-log.csv");

function ensureLogFile() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "Date,Start Time,End Time,Duration (minutes)\n");
  }
}

function appendFocusLog({ startTime, endTime, durationMinutes }) {
  ensureLogFile();
  const start = new Date(startTime);
  const end = new Date(endTime);
  const date = start.toLocaleDateString("en-CA");
  const startStr = start.toLocaleTimeString();
  const endStr = end.toLocaleTimeString();
  const row = `${date},${startStr},${endStr},${durationMinutes}\n`;
  fs.appendFileSync(LOG_FILE, row);
}

// Reads today's rows straight from the CSV -- the authoritative record of
// what was actually logged, independent of any in-memory counters. Also
// returns each session's actual start/end (ms epoch) so the renderer can
// draw a timeline of when work happened during the day.
function getTodaySummaryFromLog() {
  try {
    if (!fs.existsSync(LOG_FILE))
      return { count: 0, totalMinutes: 0, sessions: [] };
    const today = new Date().toLocaleDateString("en-CA");
    const lines = fs
      .readFileSync(LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean);
    let count = 0;
    let totalMinutes = 0;
    const sessions = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts[0] === today) {
        const durationMinutes = parseFloat(parts[3]) || 0;
        count++;
        totalMinutes += durationMinutes;
        const start = new Date(`${parts[0]} ${parts[1]}`);
        let end = new Date(`${parts[0]} ${parts[2]}`);
        if (!isNaN(start) && !isNaN(end)) {
          if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
          sessions.push({
            start: start.getTime(),
            end: end.getTime(),
            durationMinutes,
          });
        }
      }
    }
    return { count, totalMinutes, sessions };
  } catch (err) {
    return { count: 0, totalMinutes: 0, sessions: [] };
  }
}

const store = new Store({
  defaults: {
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
    settings: {
      durations: { pomodoro: 25, shortBreak: 5, longBreak: 15 },
      longBreakInterval: 4,
      autoStartBreaks: false,
      autoStartPomodoros: false,
      reminder: {
        enabled: true,
        intervalMinutes: 5,
        maxRings: 5, // 0 = unlimited
      },
      // Paths to user-imported audio files, one per sound slot. null means
      // "use the built-in sound" for that slot.
      sounds: {
        start: null,
        pause: null,
        skip: null,
        alarm: null,
        reminder: null,
      },
      // 0 (silent) to 1 (full) -- scales every sound, custom or built-in.
      masterVolume: 1,
    },
    tasks: [],
  },
});

// --- Cross-device sync (S3) ---
// Created once the app is ready, since safeStorage needs that. The AWS
// secret key is encrypted with the OS keychain/DPAPI before it's stored.
let cloudSync = null;
const SYNC_RETRY_MS = 15 * 60 * 1000;

function initCloudSync() {
  cloudSync = new CloudSync({
    store,
    encrypt: (text) =>
      safeStorage.isEncryptionAvailable()
        ? `os:${safeStorage.encryptString(text).toString("base64")}`
        : `plain:${Buffer.from(text).toString("base64")}`,
    decrypt: (stored) => {
      const [kind, data] = String(stored).split(":");
      const buf = Buffer.from(data || "", "base64");
      return kind === "os" ? safeStorage.decryptString(buf) : buf.toString();
    },
  });
  // Catch up on any upload that failed while offline.
  const catchUp = () => {
    if (cloudSync.isEnabled()) pushTodayToCloud();
  };
  setTimeout(catchUp, 5000);
  setInterval(catchUp, SYNC_RETRY_MS);
}

// Upload this device's sessions for today; failures are retried later.
function pushTodayToCloud() {
  if (!cloudSync || !cloudSync.isEnabled()) return;
  const local = getTodaySummaryFromLog();
  cloudSync
    .uploadDay(todayKey(), local.sessions)
    .then(() => (cloudSync.lastError = null))
    .catch((err) => {
      cloudSync.lastError = err.message;
      console.error("Cloud sync upload failed:", err.message);
    });
}

// Today's totals: this device's log, plus every other device's when sync is on.
async function getTodaySummaryAllDevices() {
  const local = getTodaySummaryFromLog();
  if (!cloudSync || !cloudSync.isEnabled()) return { ...local, sync: { state: "off" } };
  const result = await cloudSync.syncToday(local.sessions);
  if (!result.ok) return { ...local, sync: { state: "error", error: result.error } };
  const merged = mergeSummaries(local, result.others, cloudSync.deviceName);
  return { ...merged, sync: { state: "ok", devices: merged.devices } };
}

// --- Work Start Reminder ---
// Armed when a break ends. Pings on a repeating interval until the next
// work Pomodoro is actually started, in case you forget and end up
// working untracked. Uses a self-rescheduling timeout (rather than
// setInterval) so the exact next-fire timestamp is always known and can
// be broadcast to the renderer for a live countdown.
let reminderTimer = null;
let reminderFireCount = 0;

function scheduleRing(mainWindow, intervalMinutes, maxRings) {
  const nextRingAt = Date.now() + intervalMinutes * 60 * 1000;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("reminder:armed", {
      nextRingAt,
      intervalMinutes,
      maxRings,
      count: reminderFireCount,
    });
  }
  reminderTimer = setTimeout(() => {
    fireRing(mainWindow, intervalMinutes, maxRings);
  }, intervalMinutes * 60 * 1000);
}

function fireRing(mainWindow, intervalMinutes, maxRings) {
  reminderFireCount++;
  const suffix = maxRings > 0 ? `/${maxRings}` : "";

  if (Notification.isSupported()) {
    new Notification({
      title: "Pomofocus Reminder",
      body: `Did you start your work timer? (${reminderFireCount}${suffix})`,
    }).show();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    mainWindow.webContents.send("reminder:ring", {
      count: reminderFireCount,
      max: maxRings,
    });
  }

  if (maxRings > 0 && reminderFireCount >= maxRings) {
    stopReminder(mainWindow);
    return;
  }

  scheduleRing(mainWindow, intervalMinutes, maxRings);
}

function startReminder(mainWindow) {
  const { enabled, intervalMinutes, maxRings } = store.get("settings.reminder");
  if (!enabled) return;
  clearTimeout(reminderTimer);
  reminderTimer = null;
  reminderFireCount = 0;
  scheduleRing(mainWindow, intervalMinutes, maxRings);
}

function stopReminder(mainWindow) {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("reminder:disarmed");
  }
}

function createWindow() {
  let mainWindowState = windowStateKeeper({
    defaultWidth: 430,
    defaultHeight: 770,
  });

  const isWindows = process.platform === "win32";
  mainWindow = new BrowserWindow({
    width: mainWindowState.width || 430,
    height: mainWindowState.height || 770,
    x: mainWindowState.x,
    y: mainWindowState.y,
    icon: ICON_PATH,
    ...(!isWindows && { titleBarStyle: "hidden" }),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindowState.manage(mainWindow);

  mainWindow.loadFile("index.html");

  const alwaysOnTop = store.get("alwaysOnTop", false);
  const visibleOnAllWorkspaces = store.get("visibleOnAllWorkspaces", false);

  mainWindow.setAlwaysOnTop(alwaysOnTop, "floating");
  mainWindow.setVisibleOnAllWorkspaces(visibleOnAllWorkspaces);
  mainWindow.setFullScreenable(true);

  const defaultMenu = Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Always on Top",
          type: "checkbox",
          checked: alwaysOnTop,
          click: (menuItem) => {
            const isOnTop = menuItem.checked;
            mainWindow.setAlwaysOnTop(isOnTop, "floating");
            store.set("alwaysOnTop", isOnTop);
          },
        },
        {
          label: "Visible on All Workspaces",
          type: "checkbox",
          checked: visibleOnAllWorkspaces,
          click: (menuItem) => {
            const isVisible = menuItem.checked;
            mainWindow.setVisibleOnAllWorkspaces(isVisible);
            store.set("visibleOnAllWorkspaces", isVisible);
          },
        },
        { type: "separator" },
        {
          label: "Window Size",
          submenu: [
            {
              label: "Small (215 × 164)",
              click: () => {
                mainWindow.setSize(215, 165);
                mainWindow.center();
              },
            },
            {
              label: "Medium (430 × 770)",
              click: () => {
                mainWindow.setSize(430, 770);
                mainWindow.center();
              },
            },
            {
              label: "Large (700 × 850)",
              click: () => {
                mainWindow.setSize(700, 850);
                mainWindow.center();
              },
            },
          ],
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator:
            process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => {
            mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => checkForUpdatesManually(),
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(defaultMenu);

  mainWindow.on("focus", () => mainWindow.flashFrame(false));

  // Clicking the X hides the window (like minimizing) instead of quitting,
  // so the timer keeps running in the background and nothing resets.
  // The only way to actually quit is via the tray menu's "Quit".
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    clearTimeout(reminderTimer);
    reminderTimer = null;
    mainWindow = null;
  });

  createTray();

  // --- IPC: state persistence ---
  ipcMain.handle("store:get", (event, key) => store.get(key));
  ipcMain.on("store:set", (event, key, value) => store.set(key, value));

  // --- IPC: OS notifications ---
  ipcMain.on("notify", (event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // --- IPC: Work Start Reminder lifecycle, driven by renderer timer state ---
  ipcMain.on("reminder:arm", () => startReminder(mainWindow));
  ipcMain.on("reminder:disarm", () => stopReminder(mainWindow));

  // --- IPC: persistent focus-time log ---
  ipcMain.on("log:focus-session", (event, data) => {
    try {
      appendFocusLog(data);
    } catch (err) {
      console.error("Failed to write focus log:", err);
    }
    pushTodayToCloud();
  });
  ipcMain.on("log:open", () => {
    ensureLogFile();
    shell.showItemInFolder(LOG_FILE);
  });
  ipcMain.handle("log:get-today-summary", () => getTodaySummaryAllDevices());

  // --- IPC: cross-device sync settings ---
  ipcMain.handle("sync:get-config", () => cloudSync.getPublicConfig());
  ipcMain.handle("sync:save-config", (event, config) => {
    cloudSync.saveConfig(config);
    pushTodayToCloud();
    return cloudSync.getPublicConfig();
  });
  // Tests the values currently in the form (saved or not) by doing a real
  // upload, list and read of today's data.
  ipcMain.handle("sync:test", async (event, form) => {
    const local = getTodaySummaryFromLog();
    const result = await cloudSync.syncToday(local.sessions, form);
    return result.ok
      ? { ok: true, otherDevices: result.others.map((o) => o.deviceName) }
      : { ok: false, error: result.error };
  });

  // --- IPC: custom sound file picker ---
  ipcMain.handle("sound:choose-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a sound file",
      properties: ["openFile"],
      filters: [
        { name: "Audio Files", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(TRAY_ICON_PATH);
  tray.setToolTip("Pomofocus");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Pomofocus", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showMainWindow);
}

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
});

// Restarting to install a Windows update closes windows before
// "before-quit" fires, so the hide-on-close handler must be off first.
app.on("before-quit-for-update", () => {
  isQuitting = true;
});

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    initCloudSync();
    createWindow();
    initUpdater({
      onBeforeRestart: () => {
        isQuitting = true;
      },
    });

    app.on("activate", function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", function () {
    if (process.platform !== "darwin") app.quit();
  });
}
