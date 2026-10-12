import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_URL, appLink, normalizeAppUrl, normalizeRelayUrl, pairLink } from "../links";

test("a relay address is a bare https origin, or http on localhost", () => {
  assert.equal(normalizeRelayUrl(" https://My-Relay.vercel.app/ "), "https://my-relay.vercel.app");
  assert.equal(normalizeRelayUrl("https://relay.example:8443"), "https://relay.example:8443");
  assert.equal(normalizeRelayUrl("http://localhost:3000"), "http://localhost:3000");
  for (const bad of ["", "http://relay.example", "https://relay.example/api", "https://u:p@relay.example",
    "https://relay.example?x=1", "https://relay.example#x", "relay.example", "javascript:alert(1)", undefined]) {
    assert.equal(normalizeRelayUrl(bad), null, String(bad));
  }
});

test("the app address falls back to the hosted app unless it is a clean https URL", () => {
  assert.equal(normalizeAppUrl(""), DEFAULT_APP_URL);
  assert.equal(normalizeAppUrl("https://my-app.example/remote"), "https://my-app.example/remote/");
  for (const bad of ["http://my-app.example", "https://my-app.example/?x=1", "https://a@my-app.example", "nope"]) {
    assert.equal(normalizeAppUrl(bad), DEFAULT_APP_URL, bad);
  }
});

test("app links carry the relay and session, never anything else", () => {
  const relay = "https://mine.vercel.app";
  assert.equal(appLink(DEFAULT_APP_URL, relay, "ABC123"),
    `${DEFAULT_APP_URL}?relay=https%3A%2F%2Fmine.vercel.app&session=ABC123`);
  assert.equal(appLink(DEFAULT_APP_URL, relay), `${DEFAULT_APP_URL}?relay=https%3A%2F%2Fmine.vercel.app`);
  assert.equal(appLink(DEFAULT_APP_URL, "", "abc123"), DEFAULT_APP_URL);
  assert.equal(appLink(DEFAULT_APP_URL, "http://evil.example", "ABC123"), `${DEFAULT_APP_URL}?session=ABC123`);
});

test("pairLink puts only a valid code in the fragment and falls back to the plain app link", () => {
  const relay = "https://mine.vercel.app";
  const base = `${DEFAULT_APP_URL}?relay=https%3A%2F%2Fmine.vercel.app&session=ABC123`;
  const code = "A".repeat(42) + "_";
  assert.equal(pairLink(DEFAULT_APP_URL, relay, "ABC123", code), `${base}#code=${code}`);
  assert.equal(pairLink(DEFAULT_APP_URL, relay, "ABC123", "short"), base);
  assert.equal(pairLink(DEFAULT_APP_URL, relay, "abc123", code), `${DEFAULT_APP_URL}?relay=https%3A%2F%2Fmine.vercel.app`);
  assert.equal(pairLink(DEFAULT_APP_URL, relay, "ABC123", `${"A".repeat(42)}"`), base);
});
