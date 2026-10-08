# Relay Server Maintenance

How to check the relay (Vercel + Upstash Redis) is healthy, by hand or with the scheduled GitHub
Action.

## 1. Health check

```bash
curl -s https://cursor-remote-rela.vercel.app/api/health
```

Expected: HTTP 200 with `"success": true` and `"data": { "status": "healthy" }`. The endpoint
deliberately reports nothing else (no Redis or configuration details).

If it fails:

- 5xx or a timeout: open Vercel → Project → Deployments → the current deployment → Functions logs.
  Unexpected errors are logged with the route, an error code and the `x-vercel-id`, never tokens.
- Redis errors in the logs: check `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel →
  Settings → Environment Variables, and the database metrics in the Upstash Console.

## 2. End-to-end check (optional)

The relay has no public discovery or debug endpoint. To check the full flow, use the real clients:

1. In Cursor, run **Cursor Remote: Connect to Relay by Session ID** and wait for "connected".
2. Run **Cursor Remote: Pair Relay Client** and pair the phone with the code.
3. Open a chat on the phone. The **Cursor Remote** output in Cursor shows the relay polls and any
   errors with their HTTP status.

## 3. Scheduled GitHub Action

`.github/workflows/relay-health-check.yml` calls `/api/health` at 00:00, 06:00 and 12:00 UTC
(09:00, 15:00 and 21:00 KST).

- On failure it adds a comment to the open issue whose title starts with `[Relay Health]`, or opens
  one if there is none, so repeated failures stay in one issue. Close the issue once the relay is
  healthy again.
- Run it by hand from Actions → "Relay server health check" → "Run workflow"; you can pass another
  relay URL.
- Scheduled workflows only run from the default branch, so the workflow must be on `main`.

## 4. Where to look

| What | Where |
|------|-------|
| Function errors | Vercel → Project → Deployments → deployment → Functions |
| Environment variables | Vercel → Project → Settings → Environment Variables |
| Redis requests, latency, memory | Upstash Console → database → Metrics |

Every Redis key has a TTL (sessions 24 hours, messages 5 minutes), so storage cleans itself up.

## Related

- [README.md](./README.md): deployment and API overview
- [TEST_PLAN.md](./TEST_PLAN.md): automated and manual tests
