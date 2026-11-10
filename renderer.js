const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

const SOUND_KEYS = ["start", "pause", "skip", "alarm", "reminder"];
const customSoundBuffers = {}; // key -> decoded AudioBuffer, or absent (user-picked, overrides everything)
const defaultSoundBuffers = {}; // key -> decoded AudioBuffer, or absent (bundled with the app, better than the synthesized fallback)
let sharedAudioCtx = null;
let masterGainNode = null;

let settings = null;
let tasks = [];
let completedPomodoros = 0;
let statsDate = null; // YYYY-MM-DD the current completedPomodoros count belongs to

let mode = "pomodoro";
let remaining = 0;
let running = false;
let tickInterval = null;
let toastHideTimer = null;
let pomodoroStartedAt = null;

// Overtime: once a Pomodoro hits 0:00, it rings once (the nominal time is
// still worth signaling) but then always keeps counting up instead of
// force-ending the session -- you finish it by hand when you're ready.
let inOvertime = false;
let overtimeSeconds = 0;

// Today's totals, for the Summary panel. Reset alongside completedPomodoros
// by checkDayRollover().
let overtimeSecondsToday = 0;
let breakOverrunSecondsToday = 0;
let shortBreakSecondsToday = 0;
let longBreakSecondsToday = 0;
// Set when a break finishes on its own; cleared (and folded into
// breakOverrunSecondsToday) once the next Pomodoro actually starts.
let lastBreakEndedAt = null;

let reminderCountdownTimer = null;
let reminderNextRingAt = null;
let reminderMeta = { count: 0, max: 0 };

const timeDisplay = document.getElementById("timeDisplay");
const startPauseBtn = document.getElementById("startPauseBtn");
const skipBtn = document.getElementById("skipBtn");
const progressBar = document.getElementById("progressBar");
const sessionNumberEl = document.getElementById("sessionNumber");
const sessionCaptionEl = document.getElementById("sessionCaption");
const tabs = document.querySelectorAll(".tab");
const taskListEl = document.getElementById("taskList");
const addTaskForm = document.getElementById("addTaskForm");
const newTaskInput = document.getElementById("newTaskInput");
const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const reminderToast = document.getElementById("reminderToast");
const reminderToastText = document.getElementById("reminderToastText");
const reminderToastDismiss = document.getElementById("reminderToastDismiss");
const reminderStatus = document.getElementById("reminderStatus");
const reminderStatusText = document.getElementById("reminderStatusText");
const adviceToast = document.getElementById("adviceToast");
const adviceText = document.getElementById("adviceText");
const adviceRarityBadge = document.getElementById("adviceRarityBadge");
const adviceToastDismiss = document.getElementById("adviceToastDismiss");
const openLogBtn = document.getElementById("openLogBtn");
const masterVolumeInput = document.getElementById("masterVolume");
const masterVolumeLabel = document.getElementById("masterVolumeLabel");
const resetSessionsBtn = document.getElementById("resetSessionsBtn");
const summaryBtn = document.getElementById("summaryBtn");
const summaryOverlay = document.getElementById("summaryOverlay");
const closeSummaryBtn = document.getElementById("closeSummaryBtn");
const summaryDateEl = document.getElementById("summaryDate");
const summaryPomodorosEl = document.getElementById("summaryPomodoros");
const summaryFocusTimeEl = document.getElementById("summaryFocusTime");
const summaryOvertimeEl = document.getElementById("summaryOvertime");
const summaryBreakOverrunEl = document.getElementById("summaryBreakOverrun");
const summaryTasksListEl = document.getElementById("summaryTasksList");
const summaryTimelineEl = document.getElementById("summaryTimeline");
const breakdownFocusEl = document.getElementById("breakdownFocus");
const breakdownOvertimeEl = document.getElementById("breakdownOvertime");
const breakdownShortBreakEl = document.getElementById("breakdownShortBreak");
const breakdownLongBreakEl = document.getElementById("breakdownLongBreak");
const breakdownOverrunEl = document.getElementById("breakdownOverrun");
const breakdownTooltipEl = document.getElementById("breakdownTooltip");

async function init() {
  settings = await ipcRenderer.invoke("store:get", "settings");
  tasks = (await ipcRenderer.invoke("store:get", "tasks")) || [];
  completedPomodoros =
    (await ipcRenderer.invoke("store:get", "completedPomodoros")) || 0;
  statsDate = (await ipcRenderer.invoke("store:get", "statsDate")) || null;
  overtimeSecondsToday =
    (await ipcRenderer.invoke("store:get", "overtimeSecondsToday")) || 0;
  breakOverrunSecondsToday =
    (await ipcRenderer.invoke("store:get", "breakOverrunSecondsToday")) || 0;
  shortBreakSecondsToday =
    (await ipcRenderer.invoke("store:get", "shortBreakSecondsToday")) || 0;
  longBreakSecondsToday =
    (await ipcRenderer.invoke("store:get", "longBreakSecondsToday")) || 0;
  checkDayRollover();
  setInterval(checkDayRollover, 60 * 1000);

  // Older installs won't have these keys yet -- backfill them.
  if (!settings.sounds) {
    settings.sounds = {
      start: null,
      pause: null,
      skip: null,
      alarm: null,
      reminder: null,
    };
  }
  if (typeof settings.masterVolume !== "number") {
    settings.masterVolume = 1;
  }

  resetTimerForMode("pomodoro");
  renderTasks();
  refreshSoundRows();
  loadBundledDefaultSounds();
  SOUND_KEYS.forEach((key) => {
    if (settings.sounds[key]) loadCustomSound(key, settings.sounds[key]);
  });
}

// --- Daily session counter ---
// The "#N" counter (and the long-break cadence built on top of it) is
// scoped to a calendar day. It rolls over automatically -- checked at
// startup, every minute while running, and every time a Pomodoro
// completes -- so leaving the app open (or hidden in the tray) overnight
// still resets it at the right moment. It can also be reset by hand.
function todayKey() {
  return new Date().toLocaleDateString("en-CA");
}

function checkDayRollover() {
  const today = todayKey();
  if (statsDate !== today) {
    statsDate = today;
    completedPomodoros = 0;
    overtimeSecondsToday = 0;
    breakOverrunSecondsToday = 0;
    shortBreakSecondsToday = 0;
    longBreakSecondsToday = 0;
    ipcRenderer.send("store:set", "completedPomodoros", 0);
    ipcRenderer.send("store:set", "statsDate", statsDate);
    ipcRenderer.send("store:set", "overtimeSecondsToday", 0);
    ipcRenderer.send("store:set", "breakOverrunSecondsToday", 0);
    ipcRenderer.send("store:set", "shortBreakSecondsToday", 0);
    ipcRenderer.send("store:set", "longBreakSecondsToday", 0);
    render();
  }
}

function resetTodaysSessions() {
  completedPomodoros = 0;
  statsDate = todayKey();
  ipcRenderer.send("store:set", "completedPomodoros", 0);
  ipcRenderer.send("store:set", "statsDate", statsDate);
  render();
}

function totalSecondsFor(m) {
  return settings.durations[m] * 60;
}

function resetTimerForMode(m) {
  mode = m;
  remaining = totalSecondsFor(m);
  running = false;
  pomodoroStartedAt = null;
  inOvertime = false;
  overtimeSeconds = 0;
  clearInterval(tickInterval);
  document.body.className = "mode-" + m;
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.mode === m));

  // Manually switching to a break (or just being on one) means you're not
  // supposed to be working -- the "did you start your work timer?"
  // reminder doesn't apply, even if it was armed from an earlier break.
  if (m !== "pomodoro") {
    ipcRenderer.send("reminder:disarm");
    reminderToast.classList.add("hidden");
    hideReminderStatus();
  }

  render();
}

function render() {
  const total = totalSecondsFor(mode);
  const elapsed = total - remaining;

  let timeText;
  if (inOvertime) {
    const overMM = String(Math.floor(overtimeSeconds / 60)).padStart(2, "0");
    const overSS = String(overtimeSeconds % 60).padStart(2, "0");
    timeText = `+${overMM}:${overSS}`;
  } else {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    timeText = `${mm}:${ss}`;
  }
  timeDisplay.textContent = timeText;
  timeDisplay.classList.toggle("overtime", inOvertime);

  startPauseBtn.textContent = running ? "PAUSE" : "START";
  progressBar.style.width = inOvertime
    ? "100%"
    : `${Math.min(100, (elapsed / total) * 100)}%`;

  // During a break, show the number of the Pomodoro that break belongs to
  // (the one just finished) rather than the upcoming one -- otherwise the
  // long break shows as e.g. "#5" instead of "#4", making the cycle look
  // like it's 4 short + 1 long instead of the actual 3 short + 1 long.
  const sessionNumber = mode === "pomodoro" ? completedPomodoros + 1 : completedPomodoros;
  sessionNumberEl.textContent = `#${sessionNumber}`;
  const caption = inOvertime
    ? "Still working -- take a break when ready!"
    : mode === "pomodoro"
    ? "Time to focus!"
    : mode === "longBreak"
    ? "Time for a long break!"
    : "Time for a short break!";
  sessionCaptionEl.textContent = caption;
  document.title = `${timeText} - ${caption}`;

  skipBtn.textContent = inOvertime ? "✓" : "⏭";
  skipBtn.title = inOvertime ? "Finish & take a break" : "Skip";
}

function tick() {
  if (inOvertime) {
    overtimeSeconds++;
    render();
    return;
  }
  remaining--;
  if (remaining <= 0) {
    if (mode === "pomodoro") {
      // Nominal work time is up -- ring once as the "time's up" signal
      // (that part still matters), but don't force the session to end.
      // Keep counting up silently in overtime until you decide, by hand,
      // that you're actually done -- the goal was never overtime, just
      // finishing the thing that mattered.
      ipcRenderer.send("notify", {
        title: "Pomofocus",
        body: "Time's up! Keep going or wrap up whenever you're ready.",
      });
      playAlarm();
      inOvertime = true;
      remaining = 0;
      render();
      return;
    }
    completeSession(false);
  } else {
    render();
  }
}

function start() {
  if (running) return;
  running = true;
  if (mode === "pomodoro" && pomodoroStartedAt === null) {
    pomodoroStartedAt = Date.now();
    if (lastBreakEndedAt !== null) {
      const overrunSeconds = Math.max(
        0,
        Math.round((Date.now() - lastBreakEndedAt) / 1000)
      );
      breakOverrunSecondsToday += overrunSeconds;
      ipcRenderer.send(
        "store:set",
        "breakOverrunSecondsToday",
        breakOverrunSecondsToday
      );
      lastBreakEndedAt = null;
    }
  }
  tickInterval = setInterval(tick, 1000);
  if (mode === "pomodoro") {
    ipcRenderer.send("reminder:disarm");
    reminderToast.classList.add("hidden");
    hideReminderStatus();
  }
  render();
}

function pause() {
  running = false;
  clearInterval(tickInterval);
  render();
}

function toggleStartPause() {
  if (running) {
    pause();
    playPauseClick();
  } else {
    start();
    playStartClick();
  }
}

function skip() {
  playSkipClick();
  // Finishing an overtime session via this button is a real completion
  // (you actually did the work), not an abandonment -- just triggered by
  // hand instead of automatically.
  const finishingOvertime = inOvertime;
  clearInterval(tickInterval);
  running = false;
  completeSession(finishingOvertime ? false : true);
}

function completeSession(skipped) {
  clearInterval(tickInterval);
  running = false;
  checkDayRollover();
  const finishedMode = mode;
  const wasOvertime = inOvertime;
  inOvertime = false;

  if (finishedMode === "pomodoro") {
    completedPomodoros++;
    ipcRenderer.send("store:set", "completedPomodoros", completedPomodoros);
    const nextMode =
      completedPomodoros % settings.longBreakInterval === 0
        ? "longBreak"
        : "shortBreak";
    if (!skipped) {
      if (wasOvertime) {
        // Overtime is meant to be silent -- no alarm, no notification --
        // since you were consciously still working, not caught off guard.
        overtimeSecondsToday += overtimeSeconds;
        ipcRenderer.send(
          "store:set",
          "overtimeSecondsToday",
          overtimeSecondsToday
        );
      } else {
        ipcRenderer.send("notify", {
          title: "Pomofocus",
          body:
            nextMode === "longBreak"
              ? "Time for a long break!"
              : "Time for a short break!",
        });
        playAlarm();
      }
      if (pomodoroStartedAt !== null) {
        const durationMinutes = wasOvertime
          ? settings.durations.pomodoro + overtimeSeconds / 60
          : settings.durations.pomodoro;
        ipcRenderer.send("log:focus-session", {
          startTime: pomodoroStartedAt,
          endTime: Date.now(),
          durationMinutes: Math.round(durationMinutes * 10) / 10,
        });
      }
      showAdvice();
    }
    resetTimerForMode(nextMode);
    if (settings.autoStartBreaks) start();
  } else {
    if (!skipped) {
      ipcRenderer.send("notify", {
        title: "Pomofocus",
        body: "Time to focus!",
      });
      playAlarm();
      // The break just ended on its own -- start the clock on how long it
      // takes you to actually begin the next Pomodoro, for the Summary.
      lastBreakEndedAt = Date.now();

      // Track completed break time today, split by type, for the Summary
      // breakdown bar.
      const breakSeconds = settings.durations[finishedMode] * 60;
      if (finishedMode === "longBreak") {
        longBreakSecondsToday += breakSeconds;
        ipcRenderer.send(
          "store:set",
          "longBreakSecondsToday",
          longBreakSecondsToday
        );
      } else {
        shortBreakSecondsToday += breakSeconds;
        ipcRenderer.send(
          "store:set",
          "shortBreakSecondsToday",
          shortBreakSecondsToday
        );
      }
    }
    resetTimerForMode("pomodoro");
    if (settings.autoStartPomodoros) {
      start();
    } else {
      // A break just ended and the next Pomodoro hasn't auto-started --
      // arm the reminder so a forgotten restart doesn't go untracked.
      ipcRenderer.send("reminder:arm");
    }
  }
}

// --- Custom sound import ---
// Each of the 5 sound slots (start/pause/skip/alarm/reminder) can be
// overridden with a user-picked audio file. Files are read directly off
// disk (nodeIntegration is on) and decoded once into an AudioBuffer,
// cached in customSoundBuffers. Playback tries, in order: the user's
// custom override, a bundled default audio file (better than a
// synthesized tone, shipped with the app so it never depends on an
// external file the user could move or delete), then finally the
// synthesized sound as a last-resort fallback that can never fail.
function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGainNode = sharedAudioCtx.createGain();
    masterGainNode.gain.value =
      settings && typeof settings.masterVolume === "number"
        ? settings.masterVolume
        : 1;
    masterGainNode.connect(sharedAudioCtx.destination);
  }
  // Chromium can suspend an idle context; wake it so sounds aren't dropped.
  if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume();
  return sharedAudioCtx;
}

// Every sound -- custom, bundled default, or synthesized -- connects here
// instead of straight to ctx.destination, so the master volume slider
// scales all of them uniformly from one place.
function getMasterGain() {
  getAudioCtx();
  return masterGainNode;
}

async function decodeAudioFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const arrayBuffer = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  );
  return getAudioCtx().decodeAudioData(arrayBuffer);
}

async function loadCustomSound(key, filePath) {
  try {
    customSoundBuffers[key] = await decodeAudioFile(filePath);
    return true;
  } catch (e) {
    delete customSoundBuffers[key];
    return false;
  }
}

// Bundled audio files that ship with the app itself, one per sound slot
// that has an upgraded default (assets/sounds/<key>.<ext>). Not every slot
// necessarily has one -- missing files are silently skipped.
const BUNDLED_DEFAULT_SOUNDS = {
  alarm: "alarm.mp3",
};

async function loadBundledDefaultSounds() {
  for (const key of Object.keys(BUNDLED_DEFAULT_SOUNDS)) {
    const filePath = path.join(
      __dirname,
      "assets",
      "sounds",
      BUNDLED_DEFAULT_SOUNDS[key]
    );
    try {
      defaultSoundBuffers[key] = await decodeAudioFile(filePath);
    } catch (e) {
      // No bundled file for this slot (or it failed to decode) -- the
      // synthesized sound remains the fallback, so this is harmless.
    }
  }
}

function playBufferFrom(bufferMap, key) {
  const buffer = bufferMap[key];
  if (!buffer) return false;
  try {
    const ctx = getAudioCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(getMasterGain());
    source.start();
    return true;
  } catch (e) {
    return false;
  }
}

function playSound(key, defaultFn) {
  if (playBufferFrom(customSoundBuffers, key)) return;
  if (playBufferFrom(defaultSoundBuffers, key)) return;
  defaultFn();
}

// Loud, urgent, siren-style alarm for when a session actually ends --
// rapid alternating high/low square-wave tones, each doubled with a
// slightly detuned layer for a harsher, more piercing "buzz". Meant to
// feel intrusive, like a real alarm clock demanding attention.
// (Built-in fallback -- used only when no custom alarm sound is set.)
function playDefaultAlarm() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const freqs = [1175, 880];
    const beepDuration = 0.11;
    const gap = 0.015;
    const repeats = 12;
    for (let i = 0; i < repeats; i++) {
      const start = now + i * (beepDuration + gap);
      [0, 8, -8].forEach((detune) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.connect(g);
        g.connect(getMasterGain());
        o.frequency.value = freqs[i % 2];
        o.detune.value = detune;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.28, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + beepDuration);
        o.start(start);
        o.stop(start + beepDuration);
      });
    }
  } catch (e) {}
}

// Softer sine-wave triple ping for the work-start reminder -- louder than
// before, but tonally distinct from playDefaultAlarm() so the two are
// never confused for each other.
// (Built-in fallback -- used only when no custom reminder sound is set.)
function playDefaultReminderBeep() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    [0, 0.15, 0.3].forEach((offset) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.connect(g);
      g.connect(getMasterGain());
      o.frequency.value = 720;
      g.gain.setValueAtTime(0.0001, now + offset);
      g.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
      o.start(now + offset);
      o.stop(now + offset + 0.25);
    });
  } catch (e) {}
}

// Punchy, tactile UI-feedback clicks for Start/Pause/Skip. Each has two
// layered parts: a bright filtered-noise transient (the "click" texture
// of a real mechanical button) plus a short pitched thump underneath
// (the "thock" weight), both louder and snappier than a plain tone.
function createNoiseBuffer(ctx, duration) {
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function playTactileClick(pitch) {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.03);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.value = 1800;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.55, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(getMasterGain());
    noise.start(now);
    noise.stop(now + 0.03);

    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(pitch, now);
    o.frequency.exponentialRampToValueAtTime(pitch * 0.55, now + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    o.connect(g);
    g.connect(getMasterGain());
    o.start(now);
    o.stop(now + 0.1);
  } catch (e) {}
}

function playStartClick() {
  playSound("start", () => playTactileClick(320));
}

function playPauseClick() {
  playSound("pause", () => playTactileClick(190));
}

function playSkipClick() {
  playSound("skip", () => {
    playTactileClick(280);
    setTimeout(() => playTactileClick(420), 70);
  });
}

function playAlarm() {
  playSound("alarm", playDefaultAlarm);
}

function playReminderBeep() {
  playSound("reminder", playDefaultReminderBeep);
}

// --- Post-session advice ---
// A short, silly-but-not-crass line after every completed Pomodoro, with
// a loot-table style rarity so most are common but occasionally something
// rarer shows up.
const ADVICE = [
  // common
  { text: "Hydrate or diedrate.", rarity: "common" },
  { text: "Stand up. Stretch. Pretend you're a tree for a sec.", rarity: "common" },
  { text: "Blink. You've been staring at that screen like it owes you money.", rarity: "common" },
  { text: "Your posture called. It wants a word.", rarity: "common" },
  { text: "Somewhere, a snack is waiting for you.", rarity: "common" },
  { text: "Look at something 20 feet away. Your eyes will thank you.", rarity: "common" },
  { text: "You just did a thing. That's more than most tomatoes can say.", rarity: "common" },
  { text: "Roll your shoulders back like you mean it.", rarity: "common" },
  { text: "Time for a victory lap around your chair.", rarity: "common" },
  { text: "One down. The rest fear you now.", rarity: "common" },
  { text: "Breathe. In through the nose, out through the disappointment of Mondays.", rarity: "common" },
  { text: "Go pet an animal. Any animal. Doesn't have to be yours.", rarity: "common" },
  { text: "You earned a sip of something. Your call what.", rarity: "common" },
  { text: "Wiggle your toes. It's free and it works.", rarity: "common" },
  { text: "Nice. Very nice. Suspiciously nice.", rarity: "common" },
  { text: "Somewhere, a tomato is proud of you.", rarity: "common" },
  // rare
  { text: "Legend says the last person to finish this fast also found a good parking spot.", rarity: "rare" },
  { text: "You've unlocked: mild smugness.", rarity: "rare" },
  { text: "Achievement unlocked: Did The Thing.", rarity: "rare" },
  { text: "Rare sighting: a human, focused, on purpose.", rarity: "rare" },
  { text: "You just out-focused 90% of open browser tabs everywhere.", rarity: "rare" },
  { text: "The productivity gods nodded. Briefly. It's a big deal for them.", rarity: "rare" },
  { text: "Somewhere, a to-do list just got 3% less terrifying.", rarity: "rare" },
  { text: "This is the part where you'd get a trophy, if trophies were real and I had hands.", rarity: "rare" },
  // legendary
  { text: "LEGENDARY FOCUS. Frame this moment. Tell no one, or tell everyone.", rarity: "legendary" },
  { text: "You have achieved main character energy for exactly one Pomodoro.", rarity: "legendary" },
  { text: "Inducted into the Focus Hall of Fame. Population: you.", rarity: "legendary" },
  { text: "Rare drop: pure, uncut productivity. Handle with pride.", rarity: "legendary" },
];

const ADVICE_RARITY_WEIGHTS = { legendary: 5, rare: 25, common: 70 };
let adviceHideTimer = null;

function pickAdvice() {
  const roll = Math.random() * 100;
  let rarity;
  if (roll < ADVICE_RARITY_WEIGHTS.legendary) rarity = "legendary";
  else if (roll < ADVICE_RARITY_WEIGHTS.legendary + ADVICE_RARITY_WEIGHTS.rare)
    rarity = "rare";
  else rarity = "common";

  const pool = ADVICE.filter((a) => a.rarity === rarity);
  return pool[Math.floor(Math.random() * pool.length)];
}

function showAdvice() {
  const advice = pickAdvice();
  adviceText.textContent = advice.text;

  adviceToast.classList.remove(
    "hidden",
    "rarity-common",
    "rarity-rare",
    "rarity-legendary"
  );
  adviceToast.classList.add(`rarity-${advice.rarity}`);

  if (advice.rarity === "common") {
    adviceRarityBadge.classList.add("hidden");
  } else {
    adviceRarityBadge.textContent =
      advice.rarity === "legendary" ? "✨ Legendary" : "★ Rare";
    adviceRarityBadge.classList.remove("hidden");
  }

  clearTimeout(adviceHideTimer);
  adviceHideTimer = setTimeout(() => adviceToast.classList.add("hidden"), 7000);
}

adviceToastDismiss.addEventListener("click", () => {
  adviceToast.classList.add("hidden");
});

ipcRenderer.on("reminder:ring", (event, { count, max }) => {
  playReminderBeep();
  const suffix = max > 0 ? `/${max}` : "";
  reminderToastText.textContent = `Did you start your work timer? (${count}${suffix})`;
  reminderToast.classList.remove("hidden");
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => reminderToast.classList.add("hidden"), 8000);
});

reminderToastDismiss.addEventListener("click", () => {
  reminderToast.classList.add("hidden");
});

// --- Live "next reminder" countdown badge ---
ipcRenderer.on("reminder:armed", (event, { nextRingAt, count, maxRings }) => {
  reminderMeta = { count, max: maxRings };
  reminderNextRingAt = nextRingAt;
  reminderStatus.classList.remove("hidden");
  updateReminderCountdown();
  clearInterval(reminderCountdownTimer);
  reminderCountdownTimer = setInterval(updateReminderCountdown, 1000);
});

ipcRenderer.on("reminder:disarmed", () => {
  hideReminderStatus();
});

function updateReminderCountdown() {
  if (reminderNextRingAt === null) return;
  const msLeft = Math.max(0, reminderNextRingAt - Date.now());
  const totalSec = Math.ceil(msLeft / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const ringLabel =
    reminderMeta.max > 0
      ? ` (ring ${reminderMeta.count + 1}/${reminderMeta.max})`
      : "";
  reminderStatusText.textContent = `Next reminder in ${mm}:${ss}${ringLabel}`;
}

function hideReminderStatus() {
  reminderStatus.classList.add("hidden");
  clearInterval(reminderCountdownTimer);
  reminderCountdownTimer = null;
  reminderNextRingAt = null;
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => resetTimerForMode(tab.dataset.mode));
});

startPauseBtn.addEventListener("click", toggleStartPause);
skipBtn.addEventListener("click", skip);

function renderTasks() {
  taskListEl.innerHTML = "";
  tasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "task-item" + (task.done ? " done" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.addEventListener("change", () => {
      task.done = checkbox.checked;
      persistTasks();
      renderTasks();
    });

    const span = document.createElement("span");
    span.className = "task-text";
    span.textContent = task.text;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "task-delete";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      tasks = tasks.filter((t) => t.id !== task.id);
      persistTasks();
      renderTasks();
    });

    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(del);
    taskListEl.appendChild(li);
  });
}

function persistTasks() {
  ipcRenderer.send("store:set", "tasks", tasks);
}

addTaskForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = newTaskInput.value.trim();
  if (!text) return;
  tasks.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    text,
    done: false,
  });
  newTaskInput.value = "";
  persistTasks();
  renderTasks();
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

settingsBtn.addEventListener("click", () => {
  document.getElementById("durPomodoro").value = settings.durations.pomodoro;
  document.getElementById("durShortBreak").value =
    settings.durations.shortBreak;
  document.getElementById("durLongBreak").value = settings.durations.longBreak;
  document.getElementById("longBreakInterval").value =
    settings.longBreakInterval;
  document.getElementById("autoStartBreaks").checked =
    settings.autoStartBreaks;
  document.getElementById("autoStartPomodoros").checked =
    settings.autoStartPomodoros;
  document.getElementById("reminderEnabled").checked =
    settings.reminder.enabled;
  document.getElementById("reminderInterval").value = String(
    settings.reminder.intervalMinutes
  );
  document.getElementById("reminderMaxRings").value = String(
    settings.reminder.maxRings
  );
  const volPct = Math.round(settings.masterVolume * 100);
  masterVolumeInput.value = volPct;
  masterVolumeLabel.textContent = `${volPct}%`;
  refreshSoundRows();
  loadSyncFields();
  settingsOverlay.classList.remove("hidden");
});

// --- Sync settings ---
const syncField = (id) => document.getElementById(id);

async function loadSyncFields() {
  const c = await ipcRenderer.invoke("sync:get-config");
  syncField("syncEnabled").checked = c.enabled;
  syncField("syncBucket").value = c.bucket;
  syncField("syncRegion").value = c.region;
  syncField("syncAccessKeyId").value = c.accessKeyId;
  syncField("syncSecret").value = "";
  syncField("syncSecret").placeholder = c.hasSecret ? "Saved — leave blank to keep" : "";
  syncField("syncDeviceName").value = c.deviceName;
  syncField("syncEndpoint").value = c.endpoint;
  setSyncStatus("");
}

function readSyncFields() {
  return {
    enabled: syncField("syncEnabled").checked,
    bucket: syncField("syncBucket").value,
    region: syncField("syncRegion").value,
    accessKeyId: syncField("syncAccessKeyId").value,
    secretAccessKey: syncField("syncSecret").value,
    deviceName: syncField("syncDeviceName").value,
    endpoint: syncField("syncEndpoint").value,
  };
}

function setSyncStatus(text, kind) {
  const el = syncField("syncStatus");
  el.textContent = text;
  el.className = `sync-status${kind ? ` ${kind}` : ""}`;
}

syncField("syncTestBtn").addEventListener("click", async () => {
  setSyncStatus("Testing…");
  const result = await ipcRenderer.invoke("sync:test", readSyncFields());
  if (result.ok) {
    const others = result.otherDevices;
    setSyncStatus(
      others.length
        ? `Connected · also found ${others.join(", ")} today`
        : "Connected · no other devices yet today",
      "ok"
    );
  } else {
    setSyncStatus(result.error, "error");
  }
});

closeSettingsBtn.addEventListener("click", () =>
  settingsOverlay.classList.add("hidden")
);

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add("hidden");
});

saveSettingsBtn.addEventListener("click", () => {
  settings.durations.pomodoro = clampInt(
    document.getElementById("durPomodoro").value,
    1,
    180,
    25
  );
  settings.durations.shortBreak = clampInt(
    document.getElementById("durShortBreak").value,
    1,
    60,
    5
  );
  settings.durations.longBreak = clampInt(
    document.getElementById("durLongBreak").value,
    1,
    120,
    15
  );
  settings.longBreakInterval = clampInt(
    document.getElementById("longBreakInterval").value,
    1,
    12,
    4
  );
  settings.autoStartBreaks = document.getElementById("autoStartBreaks").checked;
  settings.autoStartPomodoros = document.getElementById(
    "autoStartPomodoros"
  ).checked;
  settings.reminder.enabled = document.getElementById(
    "reminderEnabled"
  ).checked;
  settings.reminder.intervalMinutes = parseInt(
    document.getElementById("reminderInterval").value,
    10
  );
  settings.reminder.maxRings = parseInt(
    document.getElementById("reminderMaxRings").value,
    10
  );

  ipcRenderer.send("store:set", "settings", settings);
  ipcRenderer.invoke("sync:save-config", readSyncFields());
  settingsOverlay.classList.add("hidden");

  if (!running) {
    remaining = totalSecondsFor(mode);
    render();
  }

  if (!settings.reminder.enabled) {
    ipcRenderer.send("reminder:disarm");
    reminderToast.classList.add("hidden");
    hideReminderStatus();
  }
});

openLogBtn.addEventListener("click", () => {
  ipcRenderer.send("log:open");
});

resetSessionsBtn.addEventListener("click", () => {
  resetTodaysSessions();
});

// --- Custom sound rows in Settings ---
const DEFAULT_SOUND_FNS = {
  start: () => playTactileClick(320),
  pause: () => playTactileClick(190),
  skip: () => {
    playTactileClick(280);
    setTimeout(() => playTactileClick(420), 70);
  },
  alarm: playDefaultAlarm,
  reminder: playDefaultReminderBeep,
};

function refreshSoundRows() {
  SOUND_KEYS.forEach((key) => {
    const row = document.querySelector(`.sound-row[data-sound="${key}"]`);
    if (!row) return;
    const fileEl = row.querySelector(".sound-row-file");
    const resetBtn = row.querySelector(".sound-reset-btn");
    const path = settings.sounds[key];
    if (path) {
      const filename = path.split(/[\\/]/).pop();
      fileEl.textContent = customSoundBuffers[key]
        ? filename
        : `${filename} (failed to load, using default)`;
      resetBtn.classList.remove("hidden");
    } else {
      fileEl.textContent = "Default";
      resetBtn.classList.add("hidden");
    }
  });
}

document.querySelectorAll(".sound-choose-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const key = btn.closest(".sound-row").dataset.sound;
    const filePath = await ipcRenderer.invoke("sound:choose-file");
    if (!filePath) return;
    const ok = await loadCustomSound(key, filePath);
    settings.sounds[key] = filePath;
    ipcRenderer.send("store:set", "settings", settings);
    refreshSoundRows();
    if (ok) playSound(key, DEFAULT_SOUND_FNS[key]);
  });
});

document.querySelectorAll(".sound-test-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.closest(".sound-row").dataset.sound;
    playSound(key, DEFAULT_SOUND_FNS[key]);
  });
});

document.querySelectorAll(".sound-reset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.closest(".sound-row").dataset.sound;
    settings.sounds[key] = null;
    delete customSoundBuffers[key];
    ipcRenderer.send("store:set", "settings", settings);
    refreshSoundRows();
  });
});

// --- Master volume slider ---
// Updates the live gain immediately while dragging, so you can hear the
// change take effect in real time, and persists + plays a preview once
// you let go.
masterVolumeInput.addEventListener("input", () => {
  const pct = parseInt(masterVolumeInput.value, 10);
  masterVolumeLabel.textContent = `${pct}%`;
  settings.masterVolume = pct / 100;
  getMasterGain().gain.value = settings.masterVolume;
});

masterVolumeInput.addEventListener("change", () => {
  ipcRenderer.send("store:set", "settings", settings);
  playSound("start", () => playTactileClick(320));
});

// --- Summary panel ---
function formatMinutes(totalMinutes) {
  const mins = Math.round(totalMinutes);
  if (mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// A day-timeline showing when actual work happened -- each logged Pomodoro
// (nominal + any overtime, since that's all one continuous session) drawn
// as a block positioned at its real clock time. Everything else on the
// strip is downtime: breaks, break overrun, or just being away.
//
// The visible window is either a fixed quarter of the day (Night/Morning/
// Afternoon/Evening) or "All Day", which auto-fits to the actual sessions
// so a single session isn't squashed into a sliver of a full 24h axis.
const TIMELINE_PRESETS = {
  night: [0, 6],
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 24],
};
let lastTimelineSessions = [];
let timelineFilter = "all";

function computeTimelineRange(filter, sessions) {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  if (TIMELINE_PRESETS[filter]) {
    const [startHour, endHour] = TIMELINE_PRESETS[filter];
    return {
      start: todayMidnight.getTime() + startHour * 60 * 60 * 1000,
      end: todayMidnight.getTime() + endHour * 60 * 60 * 1000,
    };
  }

  // "all": auto-fit to the actual sessions (padded to whole hours, with a
  // sensible minimum span so a single session isn't the entire width).
  if (!sessions || sessions.length === 0) {
    return { start: todayMidnight.getTime(), end: Date.now() };
  }
  const now = Date.now();
  const minStart = Math.min(...sessions.map((s) => s.start));
  const maxEnd = Math.max(...sessions.map((s) => s.end), now);
  const rangeStart = new Date(minStart);
  rangeStart.setMinutes(0, 0, 0);
  let rangeEnd = new Date(maxEnd);
  rangeEnd.setMinutes(0, 0, 0);
  rangeEnd = new Date(rangeEnd.getTime() + 60 * 60 * 1000);
  const minSpanMs = 4 * 60 * 60 * 1000;
  if (rangeEnd.getTime() - rangeStart.getTime() < minSpanMs) {
    rangeEnd = new Date(rangeStart.getTime() + minSpanMs);
  }
  return { start: rangeStart.getTime(), end: rangeEnd.getTime() };
}

function renderTimeline(sessions) {
  lastTimelineSessions = sessions || [];
  drawTimeline();
}

function drawTimeline() {
  const sessions = lastTimelineSessions;
  if (timelineFilter === "all" && sessions.length === 0) {
    summaryTimelineEl.innerHTML =
      '<div class="summary-empty">No sessions yet today</div>';
    return;
  }

  const range = computeTimelineRange(timelineFilter, sessions);
  const rangeStartMs = range.start;
  const rangeEndMs = range.end;
  const totalMs = rangeEndMs - rangeStartMs;
  const svgWidth = 1000;
  const barY = 18;
  const barHeight = 28;
  const svgHeight = barY + barHeight + 18;

  // A tick line every hour, but only label enough of them to stay
  // readable -- packing a label onto every hour gets illegible once the
  // range spans much of the day.
  const rangeHours = totalMs / (60 * 60 * 1000);
  const labelEveryNHours = Math.max(1, Math.ceil(rangeHours / 8));

  let ticks = "";
  let hourIndex = 0;
  for (
    let cursor = rangeStartMs;
    cursor <= rangeEndMs;
    cursor += 60 * 60 * 1000, hourIndex++
  ) {
    const x = ((cursor - rangeStartMs) / totalMs) * svgWidth;
    const showLabel = hourIndex % labelEveryNHours === 0;
    ticks += `<line x1="${x.toFixed(1)}" y1="${barY}" x2="${x.toFixed(
      1
    )}" y2="${barY + barHeight}" class="timeline-tick${
      showLabel ? " timeline-tick-major" : ""
    }"/>`;
    if (showLabel) {
      const label = new Date(cursor)
        .toLocaleTimeString(undefined, { hour: "numeric" })
        .replace(" ", "");
      ticks += `<text x="${x.toFixed(1)}" y="${
        barY + barHeight + 13
      }" class="timeline-hour-label" text-anchor="middle">${label}</text>`;
    }
  }

  let blocks = "";
  let visibleCount = 0;
  sessions.forEach((s) => {
    if (s.end <= rangeStartMs || s.start >= rangeEndMs) return;
    visibleCount++;
    const clippedStart = Math.max(s.start, rangeStartMs);
    const clippedEnd = Math.min(s.end, rangeEndMs);
    const x = ((clippedStart - rangeStartMs) / totalMs) * svgWidth;
    const w = Math.max(3, ((clippedEnd - clippedStart) / totalMs) * svgWidth);
    blocks += `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(
      1
    )}" height="${barHeight}" rx="3" class="timeline-block"/>`;
  });

  let nowLine = "";
  const now = Date.now();
  if (now >= rangeStartMs && now <= rangeEndMs) {
    const x = ((now - rangeStartMs) / totalMs) * svgWidth;
    nowLine = `<line x1="${x.toFixed(1)}" y1="${barY - 5}" x2="${x.toFixed(
      1
    )}" y2="${barY + barHeight + 5}" class="timeline-now"/>`;
  }

  const emptyNotice =
    visibleCount === 0
      ? '<div class="summary-empty timeline-empty-overlay">No sessions in this window</div>'
      : "";

  summaryTimelineEl.innerHTML = `
    <svg viewBox="0 0 ${svgWidth} ${svgHeight}" class="timeline-svg" preserveAspectRatio="none">
      <rect x="0" y="${barY}" width="${svgWidth}" height="${barHeight}" rx="3" class="timeline-track"/>
      ${ticks}
      ${blocks}
      ${nowLine}
    </svg>
    ${emptyNotice}
  `;
}

document.querySelectorAll(".timeline-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    timelineFilter = btn.dataset.range;
    document
      .querySelectorAll(".timeline-filter-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    drawTimeline();
  });
});

// A proportional bar showing how today's tracked time split between
// nominal focus time, overtime, short/long breaks, and break overrun.
function renderBreakdown(
  nominalMinutes,
  overtimeMinutes,
  shortBreakMinutes,
  longBreakMinutes,
  overrunMinutes
) {
  const total =
    nominalMinutes +
    overtimeMinutes +
    shortBreakMinutes +
    longBreakMinutes +
    overrunMinutes;
  const pctOf = (v) => (total > 0 ? (v / total) * 100 : 0);

  const segments = [
    { el: breakdownFocusEl, label: "Focus", minutes: nominalMinutes },
    { el: breakdownOvertimeEl, label: "Overtime", minutes: overtimeMinutes },
    {
      el: breakdownShortBreakEl,
      label: "Short Break",
      minutes: shortBreakMinutes,
    },
    {
      el: breakdownLongBreakEl,
      label: "Long Break",
      minutes: longBreakMinutes,
    },
    { el: breakdownOverrunEl, label: "Break Overrun", minutes: overrunMinutes },
  ];

  segments.forEach(({ el, label, minutes }) => {
    const p = pctOf(minutes);
    el.style.width = `${p}%`;
    el.dataset.label = label;
    el.dataset.minutes = String(minutes);
    el.dataset.pct = p.toFixed(1);
  });
}

// Hover tooltip on the breakdown bar -- shows the exact time and share for
// whichever segment is under the cursor.
function showBreakdownTooltip(seg) {
  const minutes = parseFloat(seg.dataset.minutes || "0");
  if (minutes <= 0) return;
  const pct = seg.dataset.pct || "0";
  breakdownTooltipEl.textContent = `${seg.dataset.label}: ${formatMinutes(
    minutes
  )} (${pct}%)`;
  breakdownTooltipEl.classList.remove("hidden");

  const wrapRect = seg.closest(".breakdown-bar-wrap").getBoundingClientRect();
  const segRect = seg.getBoundingClientRect();
  const centerX = segRect.left + segRect.width / 2 - wrapRect.left;
  breakdownTooltipEl.style.left = `${centerX}px`;
}

function hideBreakdownTooltip() {
  breakdownTooltipEl.classList.add("hidden");
}

document.querySelectorAll(".breakdown-segment").forEach((seg) => {
  seg.addEventListener("mouseenter", () => showBreakdownTooltip(seg));
  seg.addEventListener("mouseleave", hideBreakdownTooltip);
});

// One line under the date saying which devices today's totals include.
function renderSyncNote(sync) {
  const el = document.getElementById("summarySyncNote");
  el.classList.remove("error");
  if (!sync || sync.state === "off") {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (sync.state === "error") {
    el.classList.add("error");
    el.textContent = `Showing this device only — couldn't sync: ${sync.error}`;
    return;
  }
  const active = sync.devices.filter((d) => d.count > 0 || d.isThisDevice);
  el.textContent =
    active.length <= 1
      ? "Synced · no sessions from other devices yet today"
      : "All devices: " +
        active
          .map((d) => `${d.name}${d.isThisDevice ? " (this one)" : ""} ${d.count}`)
          .join(" · ");
}

async function openSummary() {
  const logSummary = await ipcRenderer.invoke("log:get-today-summary");
  const doneTasks = tasks.filter((t) => t.done);

  summaryDateEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // Use the log's count (not the live completedPomodoros counter) so this
  // matches Focus Time and the timeline -- all three come from the same
  // source of truth and stay consistent with each other. completedPomodoros
  // also counts skipped/abandoned sessions, which aren't real completions.
  summaryPomodorosEl.textContent = String(logSummary.count);
  renderSyncNote(logSummary.sync);

  const overtimeMinutes = overtimeSecondsToday / 60;
  const overrunMinutes = breakOverrunSecondsToday / 60;
  const shortBreakMinutes = shortBreakSecondsToday / 60;
  const longBreakMinutes = longBreakSecondsToday / 60;
  const nominalMinutes = Math.max(0, logSummary.totalMinutes - overtimeMinutes);

  summaryFocusTimeEl.textContent = formatMinutes(logSummary.totalMinutes);
  summaryOvertimeEl.textContent = formatMinutes(overtimeMinutes);
  summaryBreakOverrunEl.textContent = formatMinutes(overrunMinutes);

  renderBreakdown(
    nominalMinutes,
    overtimeMinutes,
    shortBreakMinutes,
    longBreakMinutes,
    overrunMinutes
  );

  timelineFilter = "all";
  document
    .querySelectorAll(".timeline-filter-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.range === "all"));
  renderTimeline(logSummary.sessions);

  summaryTasksListEl.innerHTML = "";
  if (doneTasks.length === 0) {
    const li = document.createElement("li");
    li.className = "summary-empty";
    li.textContent = "No tasks checked off yet";
    summaryTasksListEl.appendChild(li);
  } else {
    doneTasks.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t.text;
      summaryTasksListEl.appendChild(li);
    });
  }

  summaryOverlay.classList.remove("hidden");
}

summaryBtn.addEventListener("click", openSummary);
closeSummaryBtn.addEventListener("click", () =>
  summaryOverlay.classList.add("hidden")
);
summaryOverlay.addEventListener("click", (e) => {
  if (e.target === summaryOverlay) summaryOverlay.classList.add("hidden");
});

init();
