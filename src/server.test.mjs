import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "./server.mjs";

test("unknown /api/* routes return 404 instead of SPA HTML fallback", async () => {
  process.env.RESUME_TOKEN = "test-token";
  delete process.env.WORK_LOG_ENABLE_RESUME;
  const app = createApp();

  // Use a non-resume unknown path: /api/resume/* is intentionally handled by
  // a dedicated disabled-mode 404 JSON responder (see gating tests below),
  // so this test targets the generic catch-all instead to preserve its
  // original intent (unknown /api/* falls back to text/plain 404, not SPA HTML).
  const res = await app.fetch(
    new Request("http://localhost/api/nonexistent", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") || "", /text\/plain/i);
  assert.equal(await res.text(), "Not found");
});

test("/resume/analysis serves the SPA shell for authenticated users", async () => {
  process.env.RESUME_TOKEN = "test-token";
  process.env.WORK_LOG_ENABLE_RESUME = "1";
  const app = createApp();

  const res = await app.fetch(
    new Request("http://localhost/resume/analysis", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/i);

  delete process.env.WORK_LOG_ENABLE_RESUME;
});

test("resume disabled: GET /api/resume/anything returns 404", async () => {
  process.env.RESUME_TOKEN = "test-token";
  delete process.env.WORK_LOG_ENABLE_RESUME;
  const app = createApp();

  const res = await app.fetch(
    new Request("http://localhost/api/resume/anything", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.equal(res.status, 404);
});

test("resume disabled: GET /resume redirects to /", async () => {
  process.env.RESUME_TOKEN = "test-token";
  delete process.env.WORK_LOG_ENABLE_RESUME;
  const app = createApp();

  const res = await app.fetch(
    new Request("http://localhost/resume", {
      headers: { cookie: "resume_token=test-token" },
      redirect: "manual"
    })
  );

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
});

test("resume enabled: /api/resume/* is not 404'd by the disabled-mode gate", async () => {
  process.env.RESUME_TOKEN = "test-token";
  process.env.WORK_LOG_ENABLE_RESUME = "1";
  const app = createApp();

  // /api/resume/status is a real route on resumeRouter, so hitting it proves
  // the request reached the router instead of being short-circuited by the
  // disabled-mode `app.all("/api/resume/*", ... 404 json)` gate.
  const res = await app.fetch(
    new Request("http://localhost/api/resume/status", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.notEqual(res.status, 404);

  delete process.env.WORK_LOG_ENABLE_RESUME;
});


test("work log APIs now require auth", async () => {
  process.env.RESUME_TOKEN = "test-token";
  const app = createApp();

  const res = await app.fetch(new Request("http://localhost/api/days"));

  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") || "", /application\/json/i);
});
