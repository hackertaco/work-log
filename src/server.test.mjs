import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "./server.mjs";

test("unknown /api/* routes return 404 instead of SPA HTML fallback", async () => {
  process.env.RESUME_TOKEN = "test-token";
  const app = createApp();

  const res = await app.fetch(
    new Request("http://localhost/api/resume/does-not-exist", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") || "", /text\/plain/i);
  assert.equal(await res.text(), "Not found");
});

test("/resume/analysis serves the SPA shell for authenticated users", async () => {
  process.env.RESUME_TOKEN = "test-token";
  const app = createApp();

  const res = await app.fetch(
    new Request("http://localhost/resume/analysis", {
      headers: { cookie: "resume_token=test-token" }
    })
  );

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/i);
});
