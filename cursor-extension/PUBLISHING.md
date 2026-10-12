# Releasing Cursor Remote

Releases are built by GitHub Actions ([`.github/workflows/release-extension.yml`](../.github/workflows/release-extension.yml)).
A version tag builds and tests the extension, attaches the `.vsix` to a GitHub Release, and publishes it
to [Open VSX](https://open-vsx.org) (the registry Cursor's extension search uses) when a token is set.

## One-time setup

1. **Open VSX account.** Sign in at [open-vsx.org](https://open-vsx.org) with GitHub, sign the
   Publisher Agreement (profile page), and create an access token under
   [Settings → Access Tokens](https://open-vsx.org/user-settings/tokens).
2. **Namespace.** Create the `krishnagupta653` namespace once (it must match `publisher` in `package.json`):

   ```bash
   npx --yes ovsx create-namespace krishnagupta653 -p <token>
   ```

3. **Repository secret.** In GitHub → Settings → Secrets and variables → Actions, add `OVSX_TOKEN` with
   the token. Without it the workflow still makes the GitHub Release and skips Open VSX.

## Each release

1. On a `feature/*` branch: bump `version` in `cursor-extension/package.json`, add a
   `## [x.y.z] - date` section to [`CHANGELOG.md`](CHANGELOG.md), and run the tests:

   ```bash
   npm --workspace cursor-extension test
   ```

2. Finish the branch with Git Flow and merge to `main` the usual way.
3. Tag the release commit and push the tag (the tag must equal the package version, with a `v`):

   ```bash
   git tag v0.7.0
   git push origin v0.7.0
   ```

4. Watch the **Release extension** run in the Actions tab. The release page gets the `.vsix` and the
   CHANGELOG notes for that version.

## Build a VSIX locally

```bash
cd cursor-extension
npx --yes @vscode/vsce package --no-dependencies
cursor --install-extension cursor-remote-extension-<version>.vsix
```

`vsce` runs `vscode:prepublish`, which bundles `src/extension.ts` and its dependencies (`ws`,
`qrcode-generator`) into `out/extension.js` with esbuild, so `--no-dependencies` is safe.

## Visual Studio Marketplace (optional)

The Microsoft Marketplace is for VS Code; Cursor users install from Open VSX or the `.vsix`. To publish
there too, create a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
and an Azure DevOps token with **Marketplace (Manage)** scope, then:

```bash
npx --yes @vscode/vsce publish --no-dependencies -p <token>
```
