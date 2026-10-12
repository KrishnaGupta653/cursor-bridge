# Host the web app yourself

You don't have to: the hosted app at <https://cursor-remote-app.vercel.app> works with any relay, because
your links (`?relay=…`) and the app's **Relay server** field tell it where to connect. It stores nothing
on its server; logins stay in the phone's browser storage.

Host your own copy if you want to change the app or keep everything on your own domains.

## Build and deploy on Vercel

Vercel can't build Flutter, so build locally and upload only the output.

1. Install [Flutter](https://docs.flutter.dev/get-started/install) and the
   [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`).
2. Build, optionally baking in your relay as the default:

   ```bash
   cd mobile-app
   flutter pub get
   flutter build web --release --no-tree-shake-icons --dart-define=RELAY_URL=https://your-relay.vercel.app
   cp vercel-build-output.json build/web/vercel.json
   ```

   Without `RELAY_URL` the app asks for a relay (or takes it from a link). Copy
   `vercel-build-output.json`, not `vercel.json`: it has the SPA rewrite and cache headers and nothing
   that makes Vercel try to run Flutter.
3. Deploy from the build folder:

   ```bash
   cd build/web
   vercel link      # first time: create or choose a project
   vercel --prod
   ```

   `flutter build` empties `build/web`, including its `.vercel` link. Keep a copy of
   `build/web/.vercel` somewhere outside `build/` and copy it back before `vercel --prod`.

4. In Vercel → the project → Settings → Build and Deployment, leave **Build Command**, **Install
   Command** and **Output Directory** empty, and don't connect Git builds.

## Point the extension at it

In Cursor settings set **Cursor Remote: App Url** (`cursorRemote.appUrl`) to your app's address, for
example `https://my-cursor-remote.vercel.app/`. Telegram links and the Set Up QR code then open your copy.

## Other hosts

`build/web` is a static site. Any static host works if it serves `index.html` for unknown paths and
sends `Cache-Control: no-cache` for `index.html`, `flutter_service_worker.js` and `main.dart.js`, so
phones pick up new builds. Serve it over https: browsers block a plain-http page from talking to an
https relay.
