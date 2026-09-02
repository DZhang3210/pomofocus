const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const APP_NAME = "pomofocus";
const APP_DISPLAY_NAME = "Pomofocus";
// Update paths since __dirname is now in scripts folder
const ROOT_DIR = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT_DIR, "out", `${APP_NAME}-darwin-arm64`);
const APP_PATH = path.join(OUT_DIR, `${APP_DISPLAY_NAME}.app`);
const DMG_NAME = `${APP_DISPLAY_NAME}.dmg`;
const DMG_PATH = path.join(OUT_DIR, DMG_NAME);
const ICON_PATH = path.join(ROOT_DIR, "assets", "icon.icns");

console.log("🔧 Creating DMG installer for Pomofocus...\n");

// Check if the app exists
if (!fs.existsSync(APP_PATH)) {
  console.error(`❌ Error: App not found at ${APP_PATH}`);
  console.error("   Please build the app first using: npm run make");
  process.exit(1);
}

// Check if create-dmg (Homebrew version) is installed
const CREATE_DMG_PATH = "/usr/local/bin/create-dmg";
if (!fs.existsSync(CREATE_DMG_PATH)) {
  console.error("❌ Error: create-dmg (Homebrew) is not installed");
  console.error("   Please install it using: brew install create-dmg");
  process.exit(1);
}

try {
  // Step 1: Staple the notarization ticket
  console.log("📎 Step 1: Stapling notarization ticket to app...");
  try {
    execSync(`xcrun stapler staple "${APP_PATH}"`, { stdio: "inherit" });
    console.log("✅ Stapling completed\n");
  } catch (error) {
    console.warn(
      "⚠️  Warning: Stapling failed. The app may not be notarized yet."
    );
    console.warn("   You can continue, but users may see security warnings.\n");
  }

  // Step 2: Remove old DMG if it exists
  if (fs.existsSync(DMG_PATH)) {
    console.log("🗑️  Removing old DMG...");
    fs.unlinkSync(DMG_PATH);
  }

  // Step 3: Create the DMG
  console.log("📦 Step 2: Creating DMG with create-dmg...");
  const createDmgArgs = [
    CREATE_DMG_PATH,
    "--volname",
    APP_DISPLAY_NAME,
    "--volicon",
    ICON_PATH,
    "--window-pos",
    "200",
    "120",
    "--window-size",
    "600",
    "400",
    "--icon-size",
    "100",
    "--icon",
    `${APP_DISPLAY_NAME}.app`,
    "175",
    "190",
    "--hide-extension",
    `${APP_DISPLAY_NAME}.app`,
    "--app-drop-link",
    "425",
    "190",
    DMG_PATH,
    APP_PATH,
  ].map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));

  execSync(createDmgArgs.join(" "), {
    stdio: "inherit",
    cwd: OUT_DIR,
    shell: true,
  });

  console.log("\n✅ DMG created successfully!");
  console.log(`📍 Location: ${DMG_PATH}`);
  console.log(`📦 File: ${DMG_NAME}\n`);
} catch (error) {
  console.error("\n❌ Error creating DMG:", error.message);
  process.exit(1);
}


