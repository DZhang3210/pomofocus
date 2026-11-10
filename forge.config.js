require("dotenv").config({
  path: ".env",
});

// Signing/notarizing only makes sense (and only works) when Apple Developer
// credentials are actually configured -- e.g. for building a local, personal
// copy of the app. Without them, osxSign still falls back to an ad-hoc
// signature, which combined with hardenedRuntime/entitlements produces an
// invalid signature and fails packaging outright.
const hasAppleCredentials = Boolean(process.env.APPLE_DEVELOPER_IDENTITY);

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = {
  hooks: {
    // Apple Silicon Macs refuse to run code with no signature at all. Without
    // a paid Developer ID, give the app a free "ad-hoc" signature instead.
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== "darwin" || hasAppleCredentials) return;
      for (const outDir of outputPaths) {
        for (const name of fs.readdirSync(outDir).filter((n) => n.endsWith(".app"))) {
          execFileSync("codesign", ["--force", "--deep", "--sign", "-", path.join(outDir, name)], {
            stdio: "inherit",
          });
        }
      }
    },
  },
  packagerConfig: {
    name: "Pomofocus",
    // No extension: the packager picks icon.icns on macOS and icon.ico on Windows.
    icon: "./assets/icon",
    asar: true,
    // Personal sound files picked in the app's settings stay on this machine.
    ignore: [/^\/assets\/sounds\/custom(\/|$)/, /^\/\.github(\/|$)/],
    ...(hasAppleCredentials && {
      osxSign: {
        identity: process.env.APPLE_DEVELOPER_IDENTITY,
        hardenedRuntime: true,
        entitlements: "entitlements.plist",
        "entitlements-inherit": "entitlements.plist",
        "signature-flags": "library",
      },
      osxNotarize: {
        tool: "notarytool",
        notarytoolPath:
          "/Applications/Xcode.app/Contents/Developer/usr/bin/notarytool",
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    }),
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "Pomofocus",
        authors: "FocusLab LLC",
        setupIcon: "./assets/icon.ico",
        setupExe: "Pomofocus-Setup.exe",
        description:
          "Productivity tool for time management using Pomodoro Technique",
      },
    },
    // {
    //   name: "@electron-forge/maker-dmg",
    //   config: {
    //     icon: "./assets/icon.icns",
    //     format: "ULFO",
    //   },
    // },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          maintainer: "FocusLab LLC",
          homepage: "https://pomofocus.io",
          icon: "./assets/icon.png",
          productName: "Pomofocus",
          genericName: "Pomodoro Timer",
          categories: ["Utility"],
          description:
            "Productivity tool for time management using Pomodoro Technique",
        },
      },
    },
  ],
};
