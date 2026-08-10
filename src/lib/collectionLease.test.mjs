import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const putCalls = [];
const getCalls = [];
let putImpl = async (...args) => {
  putCalls.push(args);
  return { url: "https://blob.invalid/lease" };
};
let getImpl = async (...args) => {
  getCalls.push(args);
  return null;
};

mock.module("./meteredBlob.mjs", {
  namedExports: {
    put: (...args) => putImpl(...args),
    get: (...args) => getImpl(...args),
  },
});

const { claimCollectionLease } = await import("./collectionLease.mjs");

beforeEach(() => {
  putCalls.length = 0;
  getCalls.length = 0;
  putImpl = async (...args) => {
    putCalls.push(args);
    return { url: "https://blob.invalid/lease" };
  };
  getImpl = async (...args) => {
    getCalls.push(args);
    return null;
  };
});

test("claims a durable user-and-date lease with atomic create semantics", async () => {
  const result = await claimCollectionLease({ userId: "alice", date: "2026-08-10" });

  assert.deepEqual(result, { acquired: true });
  assert.equal(putCalls.length, 1);
  const [pathname, body, options] = putCalls[0];
  assert.equal(pathname, "worklog/leases/collect/2026-08-10/alice.json");
  assert.ok(Buffer.byteLength(body) < 512);
  assert.equal(options.addRandomSuffix, false);
  assert.equal(options.allowOverwrite, false);
  assert.equal(options.access, "private");
});

test("duplicate atomic create is treated as an already-held lease", async () => {
  putImpl = async (...args) => {
    putCalls.push(args);
    const error = new Error("Precondition failed");
    error.name = "BlobPreconditionFailedError";
    throw error;
  };
  let cancelled = false;
  getImpl = async (...args) => {
    getCalls.push(args);
    return { blob: { size: 64 }, stream: { cancel: async () => { cancelled = true; } } };
  };

  const result = await claimCollectionLease({ userId: "alice", date: "2026-08-10" });

  assert.deepEqual(result, { acquired: false, reason: "already_collected" });
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0][1].useCache, false);
  assert.equal(cancelled, true);
});

test("provider failures fail closed instead of pretending the lease was acquired", async () => {
  putImpl = async (...args) => {
    putCalls.push(args);
    throw new Error("network unavailable");
  };

  await assert.rejects(
    claimCollectionLease({ userId: "alice", date: "2026-08-10" }),
    /network unavailable/,
  );
  assert.equal(getCalls.length, 1);
});

test("invalid dates are rejected before storage", async () => {
  await assert.rejects(
    claimCollectionLease({ userId: "alice", date: "not-a-date" }),
    /YYYY-MM-DD/,
  );
  assert.equal(putCalls.length, 0);
});
