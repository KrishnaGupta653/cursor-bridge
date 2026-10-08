# Cursor Remote Relay Server

The relay lets the phone reach the Cursor extension from any network. It runs as one Vercel
function backed by Upstash Redis and only forwards messages; it never talks to Cursor itself.

Production: `https://cursor-remote-rela.vercel.app`. The full message format is in
[PROTOCOL.md](../PROTOCOL.md#relay-api).

## Architecture

```
Phone / Web app  ⇄  HTTPS polling  ⇄  Vercel relay (api/relay.ts)  ⇄  HTTPS polling  ⇄  Cursor extension
                                              │
                                        Upstash Redis
```

There is no SSE stream, no PC server and no database other than Redis.

## How sessions work

- **The Mac creates the session.** In Cursor, run **Cursor Remote: Connect to Relay by Session ID**
  (or Pair Relay Client). The extension calls `POST /api/session` with a 6-character ID and gets a
  capability token.
- **Sessions last 24 hours.** A session ID can never be claimed again, even after it expires. If an
  ID is taken or a login expired, the extension switches to a fresh random ID; phones pair again.
- **Phones join with a pairing code.** **Cursor Remote: Pair Relay Client** calls `POST /api/pair`
  and shows a code that works once and expires after 5 minutes. The phone sends it with the session
  ID to `POST /api/connect` and gets its own token. A phone can join only while the Mac is polling,
  and a failed join does not use up the code.
- **Capability tokens** are 256-bit random values. Redis stores only their SHA-256 hashes.
- **Messages expire after 5 minutes.** A reply addressed to one phone (`targetDeviceId`) goes only
  to that phone; other messages go to every phone that is still polling.
- **Liveness comes from polling.** Every `GET /api/poll` refreshes the device's last-seen time. The
  Mac counts as connected for 2 minutes after its last poll; a phone that has not polled for about
  2 minutes stops receiving messages and is pruned from the session.
- **Revocation:** `POST /api/disconnect` from the Mac revokes the session for everyone
  (**Cursor Remote: Revoke Relay Session**, or **Start New Relay Session**).
- Failed authentication is rate-limited per client IP (`x-vercel-forwarded-for` / `x-real-ip`).
- Bodies over 256 KB from a phone (4 MB from the Mac) are rejected with `413`.

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/session` | POST | Mac creates a session (no token yet) |
| `/api/session` | GET | Session record (token required) |
| `/api/connect` | POST | Mac reconnects with its token; phone joins with a pairing code |
| `/api/pair` | POST | Mac creates a pairing code |
| `/api/send` | POST | Queue a message |
| `/api/poll` | GET | Fetch queued messages and mark this device as seen |
| `/api/disconnect` | POST | Revoke this device (from the Mac: the whole session) |
| `/api/health` | GET | Returns `{ "status": "healthy" }` and nothing else |
| `/api/store` | GET | Storage label (always Upstash Redis) |

Kept only for extensions older than 0.5.0, scheduled for removal: `/api/heartbeat` (polling already
refreshes the Mac's last-seen time), `/api/sessions-with-mobile` and `/api/debug-sessions` (always
`403`).

Every route is served by `api/relay.ts` through the rewrite in `vercel.json`, because the Hobby plan
allows 12 functions per deployment.

## Deploy

1. Create a Redis database in the [Upstash Console](https://console.upstash.com) and copy its REST
   URL and token.
2. In Vercel → Project → Settings → Environment Variables, set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`. Both are required.
3. Deploy from this folder:

   ```bash
   cd relay-server
   npm install
   vercel --prod
   ```

4. Check it: `curl https://<your-relay>/api/health` should return `"status": "healthy"`.
5. To use your own relay, set `cursorRemote.relayServerUrl` in Cursor and the relay URL in the app.

## Local development and tests

```bash
cd relay-server
npm install
cp .env.example .env.local   # then add your Upstash URL and token
npm run dev

npm run type-check
npm test              # command policy + security tests (no network)
npm run test:redis    # needs a local redis-server on PATH
```

See [TEST_PLAN.md](./TEST_PLAN.md) for manual checks and [MAINTENANCE.md](./MAINTENANCE.md) for
the routine health check.

## License

MIT License
