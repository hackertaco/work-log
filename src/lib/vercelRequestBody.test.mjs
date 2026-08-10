import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { ensureVercelRawBody } from "./vercelRequestBody.mjs";

test("copies a Vercel-parsed JSON body into rawBody", async () => {
  const request = { method: "POST", body: { token: "test-token" } };

  await ensureVercelRawBody(request);

  assert.ok(Buffer.isBuffer(request.rawBody));
  assert.equal(request.rawBody.toString(), '{"token":"test-token"}');
});

test("materializes an unread Node request stream", async () => {
  const request = Readable.from(['{"date":', '"2026-08-10"}']);
  request.method = "POST";

  await ensureVercelRawBody(request);

  assert.equal(request.rawBody.toString(), '{"date":"2026-08-10"}');
});

test("leaves GET requests and existing rawBody untouched", async () => {
  const getRequest = { method: "GET", body: { ignored: true } };
  await ensureVercelRawBody(getRequest);
  assert.equal(getRequest.rawBody, undefined);

  const existing = Buffer.from("existing");
  const postRequest = { method: "POST", rawBody: existing, body: { ignored: true } };
  await ensureVercelRawBody(postRequest);
  assert.equal(postRequest.rawBody, existing);
});
