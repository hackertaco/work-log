import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { projectRoot } from "./utils.mjs";
import { loadConfig } from "./config.mjs";

const CONFIG_PATH = path.join(projectRoot, "work-log.config.json");

async function withTempConfig(content, fn) {
  let backup = null;
  try {
    backup = await fs.readFile(CONFIG_PATH, "utf8");
  } catch {}

  await fs.writeFile(CONFIG_PATH, JSON.stringify(content, null, 2));
  try {
    await fn();
  } finally {
    if (backup == null) {
      await fs.rm(CONFIG_PATH, { force: true });
    } else {
      await fs.writeFile(CONFIG_PATH, backup);
    }
  }
}

test("loadConfig keeps default user on legacy data/vault paths", async () => {
  await withTempConfig({ dataDir: "./data", vaultDir: "./vault" }, async () => {
    const config = await loadConfig({ userId: "default" });
    assert.ok(config.dataDir.endsWith(path.join("work-log", "data")));
    assert.ok(config.vaultDir.endsWith(path.join("work-log", "vault")));
  });
});

test("loadConfig scopes non-default user into users/<id>", async () => {
  await withTempConfig({ dataDir: "./data", vaultDir: "./vault" }, async () => {
    const config = await loadConfig({ userId: "alice" });
    assert.ok(config.dataDir.endsWith(path.join("work-log", "data", "users", "alice")));
    assert.ok(config.vaultDir.endsWith(path.join("work-log", "vault", "users", "alice")));
  });
});

test("loadConfig merges per-user overrides before scoping", async () => {
  await withTempConfig({
    dataDir: "./data",
    vaultDir: "./vault",
    users: {
      alice: {
        repoRoots: ["./custom-root"],
      },
    },
  }, async () => {
    const config = await loadConfig({ userId: "alice" });
    assert.ok(config.dataDir.endsWith(path.join("work-log", "data", "users", "alice")));
    assert.ok(config.repoRoots[0].endsWith(path.join("work-log", "custom-root")));
  });
});


test("loadConfig merges env user sources into effective config", async () => {
  const savedUsers = process.env.WORK_LOG_USERS_JSON;
  process.env.WORK_LOG_USERS_JSON = JSON.stringify([
    {
      id: "alice",
      token: "alice-token",
      sources: {
        includeSlack: true,
        includeSessionLogs: true,
        repoRoots: ["./alice-root"],
        zeudeEmail: "alice@example.com",
        slack: { token: "alice-slack-token", userId: "U123", channelIds: ["C1", "C2"] }
      }
    }
  ]);

  await withTempConfig({ dataDir: "./data", vaultDir: "./vault" }, async () => {
    const config = await loadConfig({ userId: "alice" });
    assert.equal(config.includeSlack, true);
    assert.equal(config.includeSessionLogs, true);
    assert.equal(config.slackToken, "alice-slack-token");
    assert.equal(config.slackUserId, "U123");
    assert.deepEqual(config.slackChannelIds, ["C1", "C2"]);
    assert.equal(config.zeudeEmail, "alice@example.com");
    assert.ok(config.repoRoots[0].endsWith(path.join("work-log", "alice-root")));
  });

  if (savedUsers === undefined) delete process.env.WORK_LOG_USERS_JSON; else process.env.WORK_LOG_USERS_JSON = savedUsers;
});
