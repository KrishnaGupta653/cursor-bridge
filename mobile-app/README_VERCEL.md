# Flutter Web on Vercel

The Flutter Web app is deployed to **Vercel** at https://cursor-remote-app.vercel.app. Only the **prebuilt** output (`build/web`, generated locally) is uploaded.
Vercel does not run the Flutter build.

## Deployment steps

```bash
# 1. Build Flutter Web locally
cd mobile-app
flutter pub get
flutter build web --release --base-href /

# 2. Copy the Vercel config into the build output
cp vercel-build-output.json build/web/vercel.json

# 3. Deploy from the build directory
cd build/web
vercel --prod
```

The first time, link the directory to the Vercel project with `vercel link`.
Once `build/web/.vercel/` exists, later deploys from `build/web` go to the same project.

## Config files

| File | Purpose |
|------|---------|
| `vercel.json` | Routing/header settings (source, reference only) |
| `vercel-build-output.json` | Copied to `build/web/vercel.json` before deploying |

## Git-push deploys

Do not use Git-push builds: Flutter is not available in the Vercel build environment, so leave **Build Command / Output Directory** empty in the dashboard and deploy with the CLI steps above (local build, then `vercel --prod`).

See [DEPLOY_INSTRUCTIONS.md](DEPLOY_INSTRUCTIONS.md) for details.
