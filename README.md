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

## Syncing Across Devices (Amazon S3)

Optional. When it's on, **Today's Summary** adds up focus time from every device that uses the same bucket. Each device uploads its own file for the day (`pomofocus/days/<date>/<device-id>.json`) after every completed Pomodoro, so devices never overwrite each other. The local CSV log stays the source of truth; if a device is offline, it uploads the next time it can (it retries every 15 minutes).

### One-time AWS setup

1. **Create a bucket.** In the [S3 console](https://console.aws.amazon.com/s3/), click **Create bucket**, pick a name (e.g. `yourname-pomofocus`) and a region, and leave **Block all public access** turned on.
2. **Create a key that can only touch that bucket.** In the [IAM console](https://console.aws.amazon.com/iam/), go to **Users → Create user**, name it `pomofocus-sync`, and don't give it console access. On the permissions step choose **Attach policies directly → Create policy**, switch to **JSON**, and paste this (replace `YOUR-BUCKET` twice):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::YOUR-BUCKET",
         "Condition": { "StringLike": { "s3:prefix": "pomofocus/*" } }
       },
       {
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject"],
         "Resource": "arn:aws:s3:::YOUR-BUCKET/pomofocus/*"
       }
     ]
   }
   ```

   Name the policy `pomofocus-sync`, attach it to the user, and finish.
3. **Make an access key.** Open the user → **Security credentials → Create access key** → choose **Application running outside AWS**. Copy the **Access key ID** and **Secret access key** (the secret is only shown once).
4. **On each device:** open **Settings → Sync Across Devices**, turn it on, enter the bucket, region, access key ID and secret, give the device a name, click **Test Connection**, then **Save**.

Cost: a handful of tiny requests per Pomodoro, which comes to well under a cent a month. The secret key is encrypted on each device with the OS keychain (macOS) or Windows' data protection.

## Releasing an Update

Pushing a version tag makes GitHub build the Windows installer and both macOS apps (Apple Silicon and Intel) and publish them on the [Releases page](https://github.com/DZhang3210/pomofocus/releases). Installed copies check for updates on launch and every 6 hours, or on demand via **Help → Check for Updates…**.

```bash
npm version patch        # or minor / major: bumps package.json and creates a vX.Y.Z tag
git push --follow-tags   # pushes the commit and the tag; the Release workflow does the rest
```

The tag must match the version in `package.json`, or the build stops.

### Installing on a new device (one time)

- **Windows:** download `Pomofocus-Setup.exe` and run it. Windows may say it "protected your PC" because the app isn't signed: click **More info → Run anyway**. Updates then install automatically.
- **macOS:** download `Pomofocus-darwin-arm64-….zip` (Apple Silicon) or `Pomofocus-darwin-x64-….zip` (Intel), unzip it, and drag **Pomofocus** into **Applications**. The first time you open it, macOS blocks it because it isn't signed with a paid Apple Developer ID: go to **System Settings → Privacy & Security** and click **Open Anyway**. After that, Pomofocus downloads updates from the Releases page itself, checks each one's SHA-256 checksum, and replaces itself. If macOS stops it from doing that, allow Pomofocus under **Privacy & Security → App Management**.

## License

MIT
