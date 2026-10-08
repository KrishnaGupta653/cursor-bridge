import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cliHistoryFile, isStaleTelegramMessage, readTelegramOffset, writePrivateFile, writeTelegramOffset,
} from "../private-state";

describe("Private extension state", () => {
  it("persists the update offset privately so a restart does not replay commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tg-"));
    const file = path.join(dir, "telegram.offset");
    try {
      assert.equal(readTelegramOffset(file), 0);
      writeTelegramOffset(file, 987654321);
      assert.equal(readTelegramOffset(file), 987654321);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      fs.writeFileSync(file, "garbage");
      assert.equal(readTelegramOffset(file), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps CLI history out of the workspace, per workspace, owner-only", () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "cr-store-"));
    try {
      const a = cliHistoryFile(storage, "/Users/me/project-a");
      assert.ok(a.startsWith(path.join(storage, "cli-history") + path.sep));
      assert.ok(!a.includes("project-a"));
      assert.notEqual(a, cliHistoryFile(storage, "/Users/me/project-b"));
      assert.equal(a, cliHistoryFile(storage, "/Users/me/project-a/"));
      assert.equal(writePrivateFile(a, "{}"), true);
      assert.equal(fs.statSync(a).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(a)).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it("drops messages older than two minutes and keeps undated ones", () => {
    const now = 1_800_000_000_000;
    assert.equal(isStaleTelegramMessage(now / 1000 - 30, now), false);
    assert.equal(isStaleTelegramMessage(now / 1000 - 121, now), true);
    assert.equal(isStaleTelegramMessage(now / 1000 - 86_400, now), true);
    assert.equal(isStaleTelegramMessage(undefined, now), false);
  });
});
