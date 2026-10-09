# Vercel Deployment

The Flutter Web app is live at https://cursor-remote-app.vercel.app.

## Why build locally?

**The Vercel build environment does not have Flutter.**
`flutter build web` cannot run on Vercel, so the app is built locally and only the **build output** (`build/web`) is uploaded to Vercel.

## Deploying

### 1. Build locally and deploy with the Vercel CLI

```bash
# 1. Build Flutter Web
cd mobile-app
flutter pub get
flutter build web --release --base-href /

# 2. Copy the Vercel config into the build output
cp vercel-build-output.json build/web/vercel.json

# 3. Deploy from the build directory
cd build/web
vercel --prod
```

The first time, you may need to link the directory to the Vercel project with `vercel link`. Once `build/web/.vercel/` exists, later deploys from `build/web` go to the same project:

```bash
cd mobile-app/build/web
vercel link   # choose the project that serves cursor-remote-app.vercel.app
vercel --prod
```

### 2. Vercel dashboard settings

Because Vercel cannot build Flutter, do not rely on Git-push builds. In the project settings leave these empty:

- **Build Command**: empty
- **Install Command**: empty
- **Output Directory**: empty

Deploy only with the local build followed by `vercel --prod`, as in step 1.

## Vercel config file

**The only Vercel config used for deployment is `vercel-build-output.json`.**
Copy it to `build/web/vercel.json` and deploy from `build/web`. It provides the SPA rewrite to `/index.html` and a `Cache-Control: public, max-age=0, must-revalidate` header.
Do not put a `vercel.json` in `web/`: a `buildCommand` there makes Vercel try to run `flutter`, which fails with exit code 127.

## Project layout

- `mobile-app/` - Flutter project root
- `mobile-app/web/` - Flutter Web sources (`index.html` etc.), no `vercel.json`
- `mobile-app/build/web/` - build output (**this folder is what gets deployed**)
- `mobile-app/vercel.json` - routing/header reference only (not used for deployment)
- `mobile-app/vercel-build-output.json` - copied to `build/web/vercel.json` before each deploy
