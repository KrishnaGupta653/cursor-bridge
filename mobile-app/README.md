# Cursor Remote Mobile App

A Flutter app for controlling the Cursor IDE remotely.

## Features

- Server connection (WebSocket)
- Sending text input
- Running commands
- Viewing the message log

## Web deployment (Vercel)

Flutter Web is deployed to **Vercel** at https://cursor-remote-app.vercel.app. Vercel has no Flutter build environment, so only the **locally built output** (`build/web`) is uploaded.

```bash
cd mobile-app
flutter pub get
flutter build web --release --base-href /
cp vercel-build-output.json build/web/vercel.json
cd build/web && vercel --prod
```

See [DEPLOY_INSTRUCTIONS.md](DEPLOY_INSTRUCTIONS.md) for the full procedure.

## Build (mobile)

```bash
flutter pub get
flutter build apk
```

## Run

```bash
flutter run
```

## Usage

1. Launch the app
2. Enter the server address (e.g. `192.168.0.10`)
3. Tap Connect
4. Enter and send commands
