# Security

Cursor Remote lets a phone and a Telegram bot drive Cursor on your computer, so security reports are
welcome and taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/KrishnaGupta653/cursor-bridge/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply
within a few days. Please give a reasonable time to fix it before disclosing it publicly.

## Supported versions

Only the latest release of the extension, relay and web app gets security fixes.

## How it is protected

- **Your relay, your data.** Each user deploys their own relay (Vercel + Upstash Redis); there is no
  shared default relay. Prompts and replies pass through it, so keep its Upstash token private.
- **Pairing.** A phone joins only with a single-use pairing code (5 minutes) made on the Mac or with
  Telegram `/pair`. It then gets a 256-bit credential, stored hashed on the relay, that lasts at most
  24 hours. Session IDs alone never grant access.
- **Session control** (Chrome DevTools Protocol) listens on `127.0.0.1` only and is never exposed to
  the network.
- **Remote actions** (send, stop, approve, reject) can be turned off with `cursorRemote.remoteActions`
  and are written to the `[Audit]` log. Approvals are bound to the exact request shown.
- **Telegram** only answers the user and chat IDs in your settings file
  (`~/.config/cursor-remote/telegram.json`, readable only by you). Bot chats are not end-to-end
  encrypted: pairing messages are deleted when the code expires, and no shell access is offered.
- **Links never carry credentials in a form a server sees.** One-tap pairing links put the code after
  `#`, which browsers don't send to servers, and the app removes it from the address bar at once.

## If a secret leaks

| Leaked | Do this |
|---|---|
| Upstash token | Upstash console → your database → reset the token, update it in Vercel, redeploy |
| Telegram bot token | @BotFather → `/revoke`, then run **Cursor Remote: Set Up** again |
| Pairing code or a paired phone | **Cursor Remote: Start New Relay Session** (signs out every device) |
