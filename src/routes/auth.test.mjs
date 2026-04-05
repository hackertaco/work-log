/**
 * Tests for POST /auth/login and POST /auth/logout endpoints.
 *
 * Run with: node --test src/routes/auth.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Hono } from "hono";

import { authRouter } from "./auth.mjs";

// Mount the authRouter under /auth so the full path matches the spec
function buildApp(resumeToken) {
  const app = new Hono();
  // Inject the RESUME_TOKEN into the environment for the duration of the test
  if (resumeToken !== undefined) {
    process.env.RESUME_TOKEN = resumeToken;
  } else {
    delete process.env.RESUME_TOKEN;
  }
  app.route("/auth", authRouter);
  return app;
}

// ─── POST /auth/login ────────────────────────────────────────────────────────

test("POST /auth/login - valid token issues HttpOnly cookie and returns 200", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "localhost:4310" },
      body: JSON.stringify({ token: "secret-token" }),
    })
  );

  assert.equal(res.status, 200);

  const body = await res.json();
  assert.deepEqual(body, { ok: true });

  const setCookie = res.headers.get("Set-Cookie");
  assert.ok(setCookie, "Set-Cookie header must be present");
  assert.match(setCookie, /resume_token=secret-token/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=\d+/);
  // Localhost → no Secure flag
  assert.ok(!setCookie.includes("Secure"), "Localhost should not have Secure flag");
});

test("POST /auth/login - valid token on non-localhost adds Secure flag", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://example.com/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "example.com" },
      body: JSON.stringify({ token: "secret-token" }),
    })
  );

  assert.equal(res.status, 200);
  const setCookie = res.headers.get("Set-Cookie");
  assert.match(setCookie, /Secure/i);
});

test("POST /auth/login - valid token on IPv6 loopback does not add Secure flag", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://[::1]/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "[::1]:4310" },
      body: JSON.stringify({ token: "secret-token" }),
    })
  );

  assert.equal(res.status, 200);
  const setCookie = res.headers.get("Set-Cookie");
  assert.ok(setCookie, "Set-Cookie header must be present");
  assert.ok(!setCookie.includes("Secure"), "IPv6 loopback should not have Secure flag");
});

test("POST /auth/login - invalid token returns 401", async () => {
  const app = buildApp("correct-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    })
  );

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "Invalid token");
  assert.ok(!res.headers.get("Set-Cookie"), "No cookie on failure");
});

test("POST /auth/login - missing token field returns 400", async () => {
  const app = buildApp("correct-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "token field is required");
});

test("POST /auth/login - empty token field returns 400", async () => {
  const app = buildApp("correct-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "" }),
    })
  );

  assert.equal(res.status, 400);
});

test("POST /auth/login - invalid JSON body returns 400", async () => {
  const app = buildApp("correct-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Invalid JSON body");
});

test("POST /auth/login - RESUME_TOKEN not set returns 500", async () => {
  const app = buildApp(undefined);

  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "any" }),
    })
  );

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /RESUME_TOKEN/);
});

// ─── POST /auth/logout ───────────────────────────────────────────────────────

test("POST /auth/logout - clears cookie and returns 200", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://localhost/auth/logout", {
      method: "POST",
      headers: { host: "localhost:4310" },
    })
  );

  assert.equal(res.status, 200);

  const body = await res.json();
  assert.deepEqual(body, { ok: true });

  const setCookie = res.headers.get("Set-Cookie");
  assert.ok(setCookie, "Set-Cookie header must be present on logout");
  assert.match(setCookie, /resume_token=/);
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /HttpOnly/i);
});

test("POST /auth/logout - returns 200 even without existing cookie", async () => {
  const app = buildApp("secret-token");

  // No Cookie header in the request — logout should still succeed
  const res = await app.fetch(
    new Request("http://localhost/auth/logout", {
      method: "POST",
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test("POST /auth/logout - non-localhost sets Secure flag on cleared cookie", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://example.com/auth/logout", {
      method: "POST",
      headers: { host: "example.com" },
    })
  );

  assert.equal(res.status, 200);
  const setCookie = res.headers.get("Set-Cookie");
  assert.match(setCookie, /Secure/i);
});

test("POST /auth/logout - IPv6 loopback does not set Secure flag on cleared cookie", async () => {
  const app = buildApp("secret-token");

  const res = await app.fetch(
    new Request("http://[::1]/auth/logout", {
      method: "POST",
      headers: { host: "[::1]:4310" },
    })
  );

  assert.equal(res.status, 200);
  const setCookie = res.headers.get("Set-Cookie");
  assert.ok(setCookie, "Set-Cookie header must be present on logout");
  assert.ok(!setCookie.includes("Secure"), "IPv6 loopback should not have Secure flag");
});
