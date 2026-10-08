# Relay Server Test Plan

## 1. Automated tests

Run from `relay-server/`:

```bash
npm run type-check
npm test             # command policy + security tests (no network, no Redis)
npm run test:redis   # Redis lifecycle against a throwaway local redis-server
```

`test:redis` starts `redis-server` from PATH on a temporary Unix socket. It covers session creation,
pairing (including a failed join keeping the code), a phone joining while the Mac polls, multi-phone
delivery and pruning, targeted replies, the body size limit and revocation. CI runs all three.

## 2. Manual test with real clients

Prerequisites: the relay is deployed, and the extension and the app use the same relay URL.

### A. Pair a phone

1. In Cursor, run **Cursor Remote: Connect to Relay by Session ID** and enter a 6-character ID
   (or press Enter to reuse the last one).
2. Expected: a "connected to relay session" notification. If the ID was taken or the login expired,
   the extension switches to a new ID and says so.
3. Run **Cursor Remote: Pair Relay Client**. The code is copied and shown with the session ID.
4. In the app choose **Relay**, enter the session ID, then paste the code.
5. Expected: the app shows the Agents sidebar. The code cannot be used a second time.

### B. Code expiry

1. Create a pairing code and wait more than 5 minutes.
2. Expected: the app reports the code was rejected or expired; a new code works.

### C. Phone joins only while the Mac is live

1. Quit Cursor (or let the Mac sleep) for more than 2 minutes.
2. Try to join from a second phone with a fresh code created before quitting.
3. Expected: `PC_MUST_CONNECT_FIRST`; the code still works once Cursor is back.

### D. Restart Cursor

1. With a phone paired, quit and reopen Cursor.
2. Expected: one Cursor window reconnects to the same session on its own; the phone keeps working
   without pairing again. Relay commands run in any other window say that another window is
   already connected.

### E. New session revokes the old one

1. Run **Cursor Remote: Start New Relay Session**.
2. Expected: the old session stops working on the phone; pairing with the new code works.

### F. Session lifetime

After 24 hours the Mac's login expires. On the next connect the extension starts a new session ID
and asks you to pair the phone again.

## 3. Quick API check

```bash
curl -s https://cursor-remote-rela.vercel.app/api/health
```

Only `{ "status": "healthy" }` is returned. All other endpoints need a capability token, so test them
with the real clients or `npm run test:redis`.
