# Pomofocus

A fully local, self-contained Pomodoro timer desktop app built with Electron. No internet connection or account required — everything runs and stays on your machine.

## Features

- Pomodoro / Short Break / Long Break timer with configurable durations and auto-start rules
- Overtime: when a Pomodoro hits 0:00 it rings once, then keeps counting up instead of ending, so you can finish what you're doing and mark it done yourself
- Work Start Reminder: pings repeatedly after a break ends until you actually start the next Pomodoro, so you don't work untracked
- Post-session advice toasts with a common/rare/legendary rarity system
- Task list tied to the current session
- Today's Summary panel: focus time, overtime, break overrun, a zoomable timeline of the day, and a color-coded "where the time went" breakdown with hover tooltips
- Persistent CSV focus log written to disk (`Documents/Pomofocus/focus-log.csv`)
- Custom sounds per action (start, pause, skip, alarm, reminder), plus a master volume control
- System tray support (closing the window hides it; use the tray menu to fully quit) and single-instance locking

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later, with npm
- Windows, macOS, or Linux

## Getting Started

```bash
git clone https://github.com/DZhang3210/pomofocus.git
cd pomofocus
npm install
npm start
```

This launches the app via `electron-forge start` using your local source — no build step required for everyday development.

## Project Structure

- `main.js` — Electron main process (window/tray management, settings storage, focus log, IPC)
- `renderer.js` — UI logic, timer state machine, sounds, Summary panel, advice system
- `index.html` / `style.css` — app UI and styling
- `preload.js` — preload script
- `assets/` — icons and bundled default sounds
- `scripts/` — packaging helpers (notarization, DMG creation) used only when building installers

Settings are stored via `electron-store` in your OS's app data directory (e.g. `%APPDATA%\pomofocus\config.json` on Windows).

## Building Installers

```bash
npm run make
```

This uses [Electron Forge](https://www.electronforge.io/) to produce a platform-specific installer in `out/make/`. Building for macOS requires additional steps for notarization (Apple Developer credentials in a local `.env` file, which is gitignored — see `DISTRIBUTION_MANUAL.md` for the full platform-by-platform build and distribution process, including Windows and Linux).

## License

MIT
