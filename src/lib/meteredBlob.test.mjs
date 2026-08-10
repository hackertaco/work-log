import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

const calls = {
  put: [],
  list: [],
  get: [],
  del: [],
};

let putImpl = async (_pathname, _body, options) => {
  calls.put.push(options);
  return { url: "https://blob.invalid/item", etag: "etag-1" };
};
let listImpl = async (options) => {
  calls.list.push(options);
  return { blobs: [], hasMore: false };
};
let getImpl = async (_pathname, options) => {
  calls.get.push(options);
  return null;
};
let delImpl = async (_target, options) => {
  calls.del.push(options);
};

mock.module("@vercel/blob", {
  namedExports: {
    put: (...args) => putImpl(...args),
    list: (...args) => listImpl(...args),
    get: (...args) => getImpl(...args),
    del: (...args) => delImpl(...args),
  },
});

const { put, list, get, del } = await import("./meteredBlob.mjs");
const { runWithRequestContext } = await import("./requestContext.mjs");

const ENV_KEYS = [
  "WORK_LOG_DISABLE_BLOB",
  "WORK_LOG_BLOB_TIMEOUT_MS",
  "WORK_LOG_BLOB_MAX_WRITE_BYTES",
  "WORK_LOG_BLOB_MAX_READ_BYTES",
  "WORK_LOG_BLOB_MAX_LIST_ITEMS",
  "WORK_LOG_BLOB_MAX_DELETE_ITEMS",
  "VERCEL_BLOB_RETRIES",
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const values of Object.values(calls)) values.length = 0;
  putImpl = async (_pathname, _body, options) => {
    calls.put.push(options);
    return { url: "https://blob.invalid/item", etag: "etag-1" };
  };
  listImpl = async (options) => {
    calls.list.push(options);
    return { blobs: [], hasMore: false };
  };
  getImpl = async (_pathname, options) => {
    calls.get.push(options);
    return null;
  };
  delImpl = async (_target, options) => {
    calls.del.push(options);
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

test("kill switch rejects before the Blob SDK is called", async () => {
  process.env.WORK_LOG_DISABLE_BLOB = "1";

  await assert.rejects(
    put("private/customer.json", "secret", { access: "private" }),
    /disabled/i,
  );
  assert.equal(calls.put.length, 0);
});

test("put enforces a byte ceiling and disables SDK retries", async () => {
  process.env.WORK_LOG_BLOB_MAX_WRITE_BYTES = "8";

  await assert.rejects(
    put("private/customer.json", "123456789", { access: "private" }),
    /byte ceiling/i,
  );
  assert.equal(calls.put.length, 0);

  await put("private/customer.json", "12345678", { access: "private" });
  assert.equal(calls.put.length, 1);
  assert.equal(process.env.VERCEL_BLOB_RETRIES, "0");
  assert.ok(calls.put[0].abortSignal instanceof AbortSignal);
  assert.equal(calls.put[0].multipart, false);
});

test("put rejects multipart fan-out before the SDK is called", async () => {
  await assert.rejects(
    put("private/customer.json", "small", { access: "private", multipart: true }),
    /multipart/i,
  );
  assert.equal(calls.put.length, 0);
});

test("list caps provider output items", async () => {
  process.env.WORK_LOG_BLOB_MAX_LIST_ITEMS = "2";

  await list({ prefix: "private/", limit: 999 });

  assert.equal(calls.list.length, 1);
  assert.equal(calls.list[0].limit, 2);
  assert.ok(calls.list[0].abortSignal instanceof AbortSignal);
});

test("get cancels and rejects an oversized provider response", async () => {
  process.env.WORK_LOG_BLOB_MAX_READ_BYTES = "4";
  let cancelled = false;
  getImpl = async (_pathname, options) => {
    calls.get.push(options);
    return {
      statusCode: 200,
      blob: { size: 5 },
      stream: { cancel: async () => { cancelled = true; } },
    };
  };

  await assert.rejects(
    get("private/customer.json", { access: "private" }),
    /byte ceiling/i,
  );
  assert.equal(cancelled, true);
});

test("get fails closed when provider byte metadata is missing", async () => {
  let cancelled = false;
  getImpl = async (_pathname, options) => {
    calls.get.push(options);
    return {
      statusCode: 200,
      blob: {},
      stream: { cancel: async () => { cancelled = true; } },
    };
  };

  await assert.rejects(
    get("private/customer.json", { access: "private" }),
    /byte length/i,
  );
  assert.equal(cancelled, true);
});

test("get consumes the bounded stream before reporting success", async () => {
  getImpl = async (_pathname, options) => {
    calls.get.push(options);
    return {
      statusCode: 200,
      blob: { size: 4 },
      stream: new Blob(["data"]).stream(),
    };
  };

  const result = await get("private/customer.json", { access: "private" });

  assert.equal(await new Response(result.stream).text(), "data");
  assert.equal(result.blob.size, 4);
});

test("delete caps batch size", async () => {
  process.env.WORK_LOG_BLOB_MAX_DELETE_ITEMS = "1";

  await assert.rejects(
    del(["one", "two"], {}),
    /item ceiling/i,
  );
  assert.equal(calls.del.length, 0);
});

test("timeout aborts a stalled provider request", async () => {
  process.env.WORK_LOG_BLOB_TIMEOUT_MS = "10";
  putImpl = async (_pathname, _body, options) => {
    calls.put.push(options);
    return new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
    });
  };

  await assert.rejects(
    put("private/customer.json", "ok", { access: "private" }),
    /timeout|abort/i,
  );
  assert.equal(calls.put.length, 1);
});

test("telemetry excludes pathnames and tokens", async () => {
  const lines = [];
  const info = console.info;
  console.info = (line) => lines.push(String(line));
  try {
    await runWithRequestContext(
      {
        userId: "alice",
        route: "/api/profile",
        trigger: "authenticated-http",
      },
      () => put("private/customer.json", "payload", {
        access: "private",
        token: "do-not-log-this",
      }),
    );
  } finally {
    console.info = info;
  }

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "metered_provider_call");
  assert.equal(event.provider, "vercel_blob");
  assert.equal(event.operation, "put");
  assert.equal(event.route, "/api/profile");
  assert.equal(event.trigger, "authenticated-http");
  assert.equal(event.request_count, 1);
  assert.equal(event.outcome, "success");
  assert.doesNotMatch(lines[0], /customer\.json|do-not-log-this|payload/);
});
