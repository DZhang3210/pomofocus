const path = require("path");

async function main() {
  const { notarize } = await import("@electron/notarize");
  console.log("Starting notarization...");
  try {
    // Update paths since __dirname is now in scripts folder
    const ROOT_DIR = path.join(__dirname, "..");
    const APP_PATH = path.join(ROOT_DIR, "out", "Pomofocus-darwin-arm64", "Pomofocus.app");
    
    await notarize({
      appPath: APP_PATH,
      appBundleId: "io.pomofocus.pomofocus", // Replace with your app's bundle ID
      keychainProfile: "my-keychain-profile", // The profile name you created with store-credentials
    });
    console.log("Notarization complete!");
  } catch (error) {
    console.error("Notarization failed:", error);
  }
}

main();


