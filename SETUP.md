# Set up Cursor Remote

Control Cursor's agents from your phone, from anywhere: read chats, send prompts, stop runs and approve
commands, from the web app or a Telegram bot. This guide takes about 15 minutes. Everything in it is
free (Vercel Hobby, Upstash free tier, Telegram).

```
Phone (web app or Telegram)  ⇄  your relay (Vercel + Upstash Redis)  ⇄  Cursor Remote extension  ⇄  Cursor
```

You run your own relay: there is no shared server, so your messages only pass through infrastructure
you own. The web app is shared ([cursor-remote-app.vercel.app](https://cursor-remote-app.vercel.app)) and
stores nothing; your links tell it which relay to use.

**Contents**

1. [Install the extension](#1-install-the-extension)
2. [Deploy your relay](#2-deploy-your-relay)
3. [Run Set Up in Cursor](#3-run-set-up-in-cursor)
4. [Sign in your phone](#4-sign-in-your-phone)
5. [Session control](#5-session-control)
6. [Keep the computer awake](#6-keep-the-computer-awake)
7. [Everyday use](#7-everyday-use)
8. [Troubleshooting](#troubleshooting)
9. [Reset or uninstall](#reset-or-uninstall)

**You need:** [Cursor](https://cursor.com/download), a [GitHub](https://github.com/signup) account
(Vercel signs in with it), and, for the bot, [Telegram](https://telegram.org/apps) on your phone.
Tested on macOS; Windows and Linux work, with the differences noted below.

---

## 1. Install the extension

**From Open VSX (easiest):** in Cursor open the Extensions view (`Cmd+Shift+X` / `Ctrl+Shift+X`), search
for **Cursor Remote** by `krishnagupta653`, and click Install. Page:
[open-vsx.org/extension/krishnagupta653/cursor-remote-extension](https://open-vsx.org/extension/krishnagupta653/cursor-remote-extension).

**From GitHub Releases:** download the latest `cursor-remote-extension-x.y.z.vsix` from
[Releases](https://github.com/KrishnaGupta653/cursor-bridge/releases), then in Cursor run
**Extensions: Install from VSIX…** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and pick the file.

A **Remote** item appears in the status bar. Click it any time for every action.

## 2. Deploy your relay

The relay is a small Vercel project with an Upstash Redis database. It passes messages between your phone
and your computer and forgets them after 5 minutes.

### One click

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FKrishnaGupta653%2Fcursor-bridge%2Ftree%2Fmain%2Frelay-server&project-name=cursor-remote-relay&repository-name=cursor-remote-relay&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D)

1. Click the button and sign in to [Vercel](https://vercel.com/signup) with GitHub.
2. Choose where Vercel creates its copy of the code (your GitHub account is fine) and keep the name
   `cursor-remote-relay`.
3. When asked to **add Upstash for Redis**, accept, create a free database, and pick the region closest
   to you. Vercel adds its connection settings to the project by itself.
4. Click **Deploy** and wait for "Congratulations".
5. Open the project and copy its domain, for example `https://cursor-remote-relay-abc.vercel.app`
   (**Settings → Domains**).
6. Check it: open `https://<your-relay>/api/health`. You should see `"redis":"ok"`.

Optional, for speed: in the Vercel project, **Settings → Functions → Function Region**, choose the region
nearest your Upstash database, then redeploy.

### By hand (if you prefer)

1. Create a Redis database at [console.upstash.com](https://console.upstash.com) and copy the
   **REST URL** and **REST token** from its page.
2. Install the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`), then:

   ```bash
   git clone https://github.com/KrishnaGupta653/cursor-bridge.git
   cd cursor-bridge/relay-server
   vercel link
   vercel env add UPSTASH_REDIS_REST_URL production
   vercel env add UPSTASH_REDIS_REST_TOKEN production
   vercel --prod
   ```

The relay accepts either `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the
`KV_REST_API_URL` / `KV_REST_API_TOKEN` pair Vercel's integration creates. See
[relay-server/README.md](relay-server/README.md) for details.

## 3. Run Set Up in Cursor

Command Palette → **Cursor Remote: Set Up**. It has four steps; you can skip any of them and run it again
later.

1. **Relay server.** Paste your relay's address. Set Up calls `/api/health` and tells you exactly what's
   wrong if it isn't ready (no Redis, wrong project, login wall). It also has a Deploy button if you
   skipped step 2.
2. **Telegram bot (optional).**
   1. In Telegram open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a username
      ending in `bot`, and copy the token it sends.
   2. Paste the token. Set Up checks it with Telegram.
   3. Open your new bot and send `/start`. Set Up sees that message, shows your name, and asks you to
      confirm, so only your account can use the bot. No need to look up IDs.
   4. The token is saved in `~/.config/cursor-remote/telegram.json`, which only your user can read
      (permissions `600`), and you get a "✅ Cursor Remote is set up" message.

   **If Telegram's Bot API is blocked on your network** (some offices and countries), Set Up switches to
   Telegram's app protocol: sign in at [my.telegram.org](https://my.telegram.org/apps), open **API
   development tools**, create an app, and paste its `api_id` and `api_hash`. You'll also enter your
   numeric user ID, which [@userinfobot](https://t.me/userinfobot) tells you. This needs
   [Python 3](https://www.python.org/downloads/); the extension installs the rest on first start.
3. **Your phone.** Shows a QR code; see the next section.
4. **Session control.** See [section 5](#5-session-control). If Cursor needs a restart for it, Set Up
   asks at the end.

Run **Cursor Remote: Diagnose** any time to check every part (it never shows tokens or codes).

## 4. Sign in your phone

- **QR code:** scan the code Set Up shows with your phone's camera. It opens the app already pointed at
  your relay and signed in. It works once and expires in 5 minutes.
- **Telegram:** send `/pair` to your bot and tap **Tap to open the app and connect**. Same one-time link,
  any time, from anywhere.
- **By hand:** open the app, enter your relay address and the session ID, and paste the code from
  **Cursor Remote: Pair Relay Client**.

The first time a link brings in a relay, the app asks "Use this relay?" and shows its address. Only
accept addresses you deployed.

Then add it to your home screen so it opens like an app:

- **iPhone (Safari):** Share → [Add to Home Screen](https://support.apple.com/guide/iphone/bookmark-favorite-webpages-iph42ab2f3a7/ios#iph4f9a47bbc).
- **Android (Chrome):** ⋮ menu → [Add to Home screen / Install app](https://support.google.com/chrome/answer/9658361).

The phone stays signed in for the relay session (24 hours). **Log out** signs it out and revokes its login.

## 5. Session control

Session control lets the phone and Telegram **send, stop and approve** in Cursor's own Agents window.
Without it they can only read chats. It uses Cursor's debugging port on `127.0.0.1:9222`, which is
never reachable from the network.

Set Up turns on the `cursorRemote.enableCdp` setting and, on request:

- **Restart by itself when it's off** (`cursorRemote.autoRestartWithSessionControl`): when Cursor is
  opened from the Dock without session control, it restarts itself after a 10-second countdown you can
  cancel. Unsaved files are asked about.
- **Open at login (macOS):** adds a login item,
  `~/Library/LaunchAgents/com.cursor-remote.session-control.plist`, that opens Cursor with session
  control when you log in. It takes effect at your next login.

**Windows and Linux:** start Cursor with these flags (for example, edit your desktop shortcut):

```bash
cursor --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

## 6. Keep the computer awake

The phone can only reach Cursor while the computer is awake and online. If it sleeps for more than about
2 minutes, the relay shows it as offline until it wakes.

- **macOS:** run `caffeinate -dimsu` in a terminal while you're away (Ctrl+C to stop), or
  System Settings → Lock Screen / Battery → never sleep on power adapter.
- **Windows:** Settings → System → Power → Screen and sleep → **Never** when plugged in.
- **Linux:** `systemd-inhibit --what=sleep:idle sleep infinity`.

## 7. Everyday use

| From | What |
|------|------|
| Phone app | Pick a chat in the Agents sidebar, type to prompt it, approve or reject commands, stop runs |
| Telegram `/chats` | Chats grouped like Cursor's sidebar; tap `/c_3`, then just type |
| Telegram `/last`, `/stop`, `/model` | Latest reply, stop the agent, switch models |
| Telegram `/pair` | One-tap sign-in link for a phone (works once, 5 minutes) |
| Telegram `/app`, `/relay` | Link to the app, relay session status |
| Status bar **Remote** | Every action on the computer: pair, Telegram, relay, Set Up, Diagnose |

When the bot starts it sends "🟢 Cursor Remote started" with a link to the session. Turn that off with
`cursorRemote.telegramStartNotice`.

Same Wi-Fi instead of a relay: status bar → **Pair a device**, then in the app choose **Local** and enter
the computer's IP and port. See [USER_MANUAL.md](USER_MANUAL.md).

## Troubleshooting

Start with **Cursor Remote: Diagnose**; it names the failing part. Then:

| Problem | Fix |
|---------|-----|
| `/api/health` says `"redis":"not_configured"` | In Vercel → the project → **Storage**, connect Upstash Redis, then **Deployments → Redeploy**. |
| `/api/health` says `"redis":"unreachable"` | The Upstash database is paused or its token changed. Check it at [console.upstash.com](https://console.upstash.com), update the env vars, redeploy. |
| Relay asks for a Vercel login (401/403) | Vercel → Settings → **Deployment Protection** → turn off Vercel Authentication for production. |
| "doesn't look like a Cursor Remote relay" | You entered the app's address or the wrong project. Use the relay project's domain. |
| Deploy button says the repository wasn't found | Use the [by hand](#by-hand-if-you-prefer) steps, or fork this repository and deploy its `relay-server` folder. |
| App says "Enter your relay server" | Open it from a Set Up QR code or a Telegram `/pair` link, or type your relay address in **Relay server**. |
| Pairing code rejected | Codes work once and expire after 5 minutes. Send `/pair` again or run Pair Relay Client. |
| Telegram bot doesn't answer | Run Diagnose. Only the account you confirmed in Set Up is answered. Another Cursor window may own the bot (one bot, one window); close it or run Set Up there. |
| Set Up says another program is reading the bot's messages | Stop the bot in other Cursor windows, or remove a webhook: open `https://api.telegram.org/bot<token>/deleteWebhook` once. |
| Phone can read but can't send or approve | Session control is off: run **Cursor Remote: Restart Cursor with Session Control**. |
| Corporate network blocks `*.vercel.app` or Telegram | Use the MTProto fallback for Telegram; for the relay, add a [custom domain](https://vercel.com/docs/domains) in Vercel. |

More: [USER_MANUAL.md](USER_MANUAL.md), [relay-server/MAINTENANCE.md](relay-server/MAINTENANCE.md), or
[open an issue](https://github.com/KrishnaGupta653/cursor-bridge/issues) with the Diagnose report (it
contains no secrets).

## Reset or uninstall

- **Sign out every phone:** Cursor Remote: Start New Relay Session (or Revoke Relay Session).
- **Remove the Telegram bot:** delete `~/.config/cursor-remote/telegram.json`, and in
  [@BotFather](https://t.me/BotFather) use `/revoke` or `/deletebot`.
- **Remove the login item (macOS):** delete `~/Library/LaunchAgents/com.cursor-remote.session-control.plist`.
- **Remove the relay:** delete the Vercel project and the Upstash database.
- **Remove the extension:** Extensions view → Cursor Remote → Uninstall.

Security details: [SECURITY.md](SECURITY.md). Host the web app yourself: [docs/self-host-app.md](docs/self-host-app.md).
