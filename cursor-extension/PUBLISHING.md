# Cursor Remote Extension Publishing Guide

How to publish the Cursor Remote extension to the VS Code Extension Marketplace.

## 📋 Prerequisites

### 1. Create an Azure DevOps account

- Create an account at [Azure DevOps](https://dev.azure.com)
- You need a Personal Access Token (PAT)

### 2. Create a VS Code Marketplace publisher

- Go to [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)
- Create the publisher `krishnagupta653`
- Fill in the publisher profile (display name, description, links)

### 3. Install the tools

```bash
npm install -g @vscode/vsce
```

Or run it without a global install: `npx --yes @vscode/vsce <command>`.

## 🔧 package.json fields

### Required fields

`cursor-extension/package.json` must contain these fields:

```json
{
  "name": "cursor-remote-extension",
  "displayName": "Cursor Remote",
  "description": "Remote control Cursor AI from your mobile device via WebSocket or Relay Server - Code anywhere, anytime with session-based connection",
  "version": "0.6.0",
  "publisher": "krishnagupta653",
  "author": "Krishna Gupta",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/KrishnaGupta653/cursor-bridge.git"
  },
  "homepage": "https://github.com/KrishnaGupta653/cursor-bridge",
  "bugs": {
    "url": "https://github.com/KrishnaGupta653/cursor-bridge/issues"
  },
  "icon": "icon.png",
  "keywords": [
    "cursor",
    "remote",
    "mobile",
    "websocket",
    "relay",
    "session",
    "cli",
    "agent"
  ],
  "categories": [
    "Other"
  ],
  "engines": {
    "vscode": "^1.74.0"
  }
}
```

### What the main fields mean

- **publisher**: the publisher ID registered on the Marketplace (`krishnagupta653`)
- **name**: the extension name; together with the publisher it forms the extension ID
  `krishnagupta653.cursor-remote-extension`
- **repository**: the GitHub repository URL
- **icon**: the extension icon (128x128px PNG, see [images/ICON_REQUIREMENTS.md](images/ICON_REQUIREMENTS.md))
- **keywords**: Marketplace search keywords
- **categories**: the extension category

## 📦 Build the VSIX package

### 1. Install and test

```bash
cd cursor-extension
npm install
npm test                  # compile + unit tests
npx tsc --noEmit -p .     # type-check
```

### 2. Create the VSIX package

```bash
npx --yes @vscode/vsce package --no-dependencies
```

`vsce` runs the `vscode:prepublish` script first: it compiles with `tsc` and then bundles
`src/extension.ts` with esbuild into `out/extension.js`, so `ws` is inside the bundle and
`--no-dependencies` is safe.

On success the file `cursor-remote-extension-0.6.0.vsix` is created.

### 3. Check the package contents (optional)

```bash
npx --yes @vscode/vsce ls --no-dependencies
```

### 4. Test the package locally

```bash
cursor --install-extension cursor-remote-extension-0.6.0.vsix
```

Or in Cursor: `Extensions` → `...` → `Install from VSIX...`.

## 🚀 Publish to the Marketplace

### Option 1: From the command line (recommended)

#### 1. Create a Personal Access Token

1. Go to [Azure DevOps](https://dev.azure.com)
2. User Settings → Personal Access Tokens
3. Click "New Token"
4. Organization: **All accessible organizations**; Scope: **Marketplace (Manage)**
5. Create the token and copy it (it is shown only once). Keep it out of the repository.

#### 2. Log in

```bash
vsce login krishnagupta653
```

Paste the Personal Access Token when asked.

#### 3. Publish

```bash
vsce publish --no-dependencies
```

Or publish a prebuilt package:

```bash
vsce publish --packagePath cursor-remote-extension-0.6.0.vsix
```

### Option 2: Upload on the website

1. Go to [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)
2. Select the `krishnagupta653` publisher
3. "New Extension" → "Visual Studio Code"
4. Upload the VSIX file
5. Check the extension details and publish

## 📝 Version updates

### Version numbers

- **Major**: large changes that break compatibility (e.g. 1.0.0 → 2.0.0)
- **Minor**: new features, backward compatible (e.g. 0.5.0 → 0.6.0)
- **Patch**: bug fixes (e.g. 0.6.0 → 0.6.1)

### How to release a new version

1. Update the `version` field in `package.json`
2. Add an entry to `CHANGELOG.md` (same format as the existing entries)
3. Update the version badge in `README.md`
4. Test and package:

   ```bash
   npm test
   npx --yes @vscode/vsce package --no-dependencies
   ```

5. Publish:

   ```bash
   vsce publish --no-dependencies
   ```

## 🔍 Verify the release

1. Go to [Visual Studio Marketplace](https://marketplace.visualstudio.com/vscode)
2. Search for "Cursor Remote"
3. Check the extension page
4. Test the install:

   ```bash
   cursor --install-extension krishnagupta653.cursor-remote-extension
   ```

## ⚠️ Notes

### 1. Icon file

- `icon.png` must be in the `cursor-extension/` root
- Size: 128x128px
- PNG format

### 2. README.md

- `README.md` in the extension root is required
- The Marketplace shows it automatically
- Markdown is supported

### 3. License

- The `LICENSE` file and the `license` field in `package.json` are both present (MIT)

### 4. Excluded files

`.vscodeignore` lists files that are left out of the package:

```
.vscode/**
.vscode-test/**
src/**
.gitignore
tsconfig.json
.vscodeignore
**/*.map
.DS_Store
*.vsix
../**
out/**/*.test.js
python/__pycache__/**
```

## 🐛 Troubleshooting

### Error: "Missing publisher name"

- Add the `publisher` field to `package.json`

### Error: "Missing repository field"

- Add the `repository` field to `package.json`

### Error: "Extension name not found"

- Check the `name` field in `package.json`
- The extension ID has the form `publisher.extension-name` (here `krishnagupta653.cursor-remote-extension`)

### Error: "Personal Access Token expired"

- Create a new token in Azure DevOps
- Run `vsce login krishnagupta653` again

## 📚 References

- [VS Code Extension Publishing Guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI Documentation](https://github.com/microsoft/vscode-vsce)
- [Marketplace Publisher Guide](https://docs.microsoft.com/en-us/azure/devops/extend/publish/overview)

## ✅ Release checklist

- [ ] `publisher` in `package.json` is `krishnagupta653`
- [ ] `repository`, `homepage` and `bugs` point to `KrishnaGupta653/cursor-bridge`
- [ ] `version` updated in `package.json`, `CHANGELOG.md` and the `README.md` badge
- [ ] `icon.png` exists and `icon` is set in `package.json`
- [ ] `.vscodeignore` is up to date
- [ ] `npm test` and `npx tsc --noEmit -p .` pass
- [ ] VSIX package builds
- [ ] Extension tested locally from the VSIX
- [ ] Personal Access Token created
- [ ] Published to the Marketplace
- [ ] Extension visible on the Marketplace
- [ ] Install and basic use tested
