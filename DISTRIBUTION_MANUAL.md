# Distribution Manual

## Build and Distribution Process for macOS

### Prerequisites

- Apple Developer account and credentials configured
- `create-dmg` tool installed via Homebrew: `brew install create-dmg`

### Step-by-Step Process

1. **Build the app**

   ```bash
   npm run make
   ```

2. **Notarize the app** (required for macOS distribution)

   ```bash
   npm run notarize
   ```

   **Important Notes:**

   - Make sure you have configured your Apple Developer credentials
   - Update `keychainProfile` in `scripts/notarize.js` with your profile name
   - The notarization process may take several minutes

3. **Create DMG installer**

   ```bash
   npm run create-dmg
   ```

   **Notes:**

   - Requires `create-dmg` tool (install via `brew install create-dmg`)
   - The DMG will be created in `out/pomofocus-darwin-arm64/`
   - The script will automatically staple the notarization ticket to the app before creating the DMG

### Output Location

The final DMG file will be located at:

```
out/pomofocus-darwin-arm64/Pomofocus.dmg
```

---

## Build and Distribution Process for Ubuntu/Debian

### Prerequisites

- Ubuntu/Debian-based Linux system (for building)
- Node.js and npm installed
- Required build tools:
  ```bash
  sudo apt-get update
  sudo apt-get install -y build-essential fakeroot dpkg-dev
  ```

### Step-by-Step Process

1. **Build the app**

   ```bash
   npm run make
   ```

   **Note:** Make sure you're running this on a Linux system or use a Linux build environment (Docker, WSL, etc.)

2. **Verify the DEB package**

   The build process will automatically create a `.deb` package using `@electron-forge/maker-deb`.

### Output Location

The DEB package will be located at:

```
out/make/deb/x64/pomofocus_<version>_amd64.deb
```

### Installation

Users can install the DEB package using:

```bash
sudo dpkg -i pomofocus_<version>_amd64.deb
```

If there are dependency issues, run:

```bash
sudo apt-get install -f
```

### Distribution Options

- **Direct distribution:** Share the `.deb` file directly with users
- **PPA (Personal Package Archive):** Create a PPA for easier distribution and updates
- **Snap package:** Consider creating a Snap package for universal Linux distribution

---

## Build and Distribution Process for Windows

### Prerequisites

- Windows system (for building)
- Node.js and npm installed
- Visual Studio Build Tools or Visual Studio Community (for native module compilation)
- Code signing certificate (optional but recommended for distribution)

### Step-by-Step Process

1. **Build the app**

   ```bash
   npm run make
   ```

   **Note:** Make sure you're running this on a Windows system or use a Windows build environment.

2. **Code Signing** (Optional but Recommended)

   For production distribution, you should code sign your Windows installer:

   - Obtain a code signing certificate from a trusted Certificate Authority
   - Configure Electron Forge to sign the installer automatically
   - This prevents Windows security warnings for users

### Output Location

The Windows installer will be located at:

```
out/make/squirrel.windows/x64/Pomofocus-Setup-<version>.exe
```

### Distribution Options

- **Direct distribution:** Share the `.exe` installer file directly with users
- **Microsoft Store:** Consider publishing to Microsoft Store for wider distribution
- **Auto-updater:** Implement auto-update functionality using Electron's auto-updater

### Installation

Users can install the application by:

1. Downloading the `.exe` installer
2. Running the installer
3. Following the installation wizard

The installer will create shortcuts and register the application with Windows.

### Notes

- The installer supports both x64 and ia32 architectures (configured in `forge.config.js`)
- Windows Defender or antivirus software may flag unsigned executables
- Code signing is highly recommended for production releases
