import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_USER_ID, findAuthUserByToken, getAuthUsers, sanitizeUserId } from "./authUsers.mjs";

test("sanitizeUserId normalizes ids", () => {
  assert.equal(sanitizeUserId(" Alice Kim "), "alice-kim");
  assert.equal(sanitizeUserId(""), DEFAULT_USER_ID);
});

test("getAuthUsers falls back to RESUME_TOKEN", () => {
  const savedUsers = process.env.WORK_LOG_USERS_JSON;
  const savedToken = process.env.RESUME_TOKEN;
  delete process.env.WORK_LOG_USERS_JSON;
  process.env.RESUME_TOKEN = "single-token";

  assert.deepEqual(getAuthUsers(), [{ id: DEFAULT_USER_ID, token: "single-token" }]);

  if (savedUsers === undefined) delete process.env.WORK_LOG_USERS_JSON; else process.env.WORK_LOG_USERS_JSON = savedUsers;
  if (savedToken === undefined) delete process.env.RESUME_TOKEN; else process.env.RESUME_TOKEN = savedToken;
});

test("getAuthUsers prefers WORK_LOG_USERS_JSON mapping", () => {
  const savedUsers = process.env.WORK_LOG_USERS_JSON;
  process.env.WORK_LOG_USERS_JSON = JSON.stringify([
    { id: "alice", token: "alice-token" },
    { id: "bob kim", token: "bob-token" },
  ]);

  assert.deepEqual(getAuthUsers(), [
    { id: "alice", token: "alice-token", name: undefined },
    { id: "bob-kim", token: "bob-token", name: undefined },
  ]);
  assert.deepEqual(findAuthUserByToken("bob-token"), { id: "bob-kim", token: "bob-token", name: undefined });

  if (savedUsers === undefined) delete process.env.WORK_LOG_USERS_JSON; else process.env.WORK_LOG_USERS_JSON = savedUsers;
});
