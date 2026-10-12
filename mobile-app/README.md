# Cursor Remote app

The Flutter app for Cursor Remote: Cursor's Agents sidebar and chats on your phone, over your relay or
the same Wi-Fi. It's hosted at <https://cursor-remote-app.vercel.app> and works with any relay; setup
is in [SETUP.md](../SETUP.md).

## Run and test

```bash
flutter pub get
flutter test
flutter run -d chrome --dart-define=RELAY_URL=http://localhost:3000   # optional default relay
```

Links can carry the relay and session: `/?relay=https%3A%2F%2Fmy-relay.vercel.app&session=ABC123`,
plus `#code=…` for one-tap pairing (the fragment never reaches a server and the app removes it at start).
A relay from a link is used only after the user confirms it, and only https relays (http on localhost)
are accepted.

## Build

- Web: see [docs/self-host-app.md](../docs/self-host-app.md).
- Android: `flutter build apk --release`.
- iOS: `cd ios && pod install && cd .. && flutter build ios`.
