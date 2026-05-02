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
