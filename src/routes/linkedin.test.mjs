/**
 * Unit tests for src/routes/linkedin.mjs
 *
 * Tests the HTTP handler logic of:
 *   POST /api/resume/linkedin        — URL fetch & profile extraction
 *   POST /api/linkedin/import        — request-validation path (returns early
 *                                       before calling Vercel Blob)
 *
 * Full end-to-end import tests that require Blob mocking live in
 * src/routes/linkedin.import.test.mjs (run with --experimental-test-module-mocks).
 *
 * Uses Hono's built-in app.request() to send requests against a real Hono
 * instance without spinning up a TCP server.  Network calls in fetchPage()
 * are monkey-patched on the module's https/http imports via a test-local
 * mock so no real requests are made.
 *
 * Run:
 *   node --test src/routes/linkedin.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { registerLinkedInRoutes } from "./linkedin.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a Hono app with the LinkedIn routes registered. */
function buildApp() {
  const app = new Hono();
  registerLinkedInRoutes(app);
  return app;
}

/**
 * Send a POST /api/resume/linkedin request and return the parsed JSON body.
 *
 * @param {Hono} app
 * @param {unknown} body
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function postLinkedIn(app, body) {
  const res = await app.request("/api/resume/linkedin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ─── Mock https.request ──────────────────────────────────────────────────────
//
// fetchPage() in linkedin.mjs uses Node.js https.request internally.
// We monkey-patch https.request so tests run without network access.

let _mockResponse = null; // { statusCode, body } | { throw: Error }

const _originalRequest = https.request.bind(https);

function installMock() {
  https.request = function mockRequest(options, callback) {
    if (_mockResponse?.throw) {
      // Simulate a network-level error (e.g. ECONNREFUSED)
      const emitter = new EventEmitter();
      emitter.destroy = () => {};
      emitter.setTimeout = () => {};
      emitter.end = () => {
        // Emit the error asynchronously so the caller has time to set up listeners.
        setImmediate(() => emitter.emit("error", _mockResponse.throw));
      };
      return emitter;
    }

    const { statusCode, body, location } = _mockResponse ?? { statusCode: 200, body: "" };

    // Build a minimal mock IncomingMessage-like object.
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.headers = location ? { location } : {};
    response.setEncoding = () => {};
    response.resume = () => {};

    if (callback) callback(response);

    if (statusCode >= 300 && statusCode < 400) {
      // Redirect — don't emit data; fetchPage will recurse via the location.
      return { setTimeout: () => {}, on: () => {}, end: () => {} };
    }

    // Emit body data asynchronously.
    const req = {
      setTimeout: () => {},
      on: () => {},
      end() {
        setImmediate(() => {
          if (statusCode < 400) {
            response.emit("data", body ?? "");
          }
          response.emit("end");
        });
      },
      destroy(err) {
        if (err) response.emit("error", err);
      },
    };
    return req;
  };
}

function restoreMock() {
  https.request = _originalRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/resume/linkedin — URL validation", () => {
  const app = buildApp();

  test("400 when body is not JSON", async () => {
    const res = await app.request("/api/resume/linkedin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{",
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "bad_request");
  });

  test("400 when url is missing", async () => {
    const { status, body } = await postLinkedIn(app, {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_url");
  });

  test("400 when url is empty string", async () => {
    const { status, body } = await postLinkedIn(app, { url: "" });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_url");
  });

  test("400 when url is not a linkedin.com domain", async () => {
    const { status, body } = await postLinkedIn(app, { url: "https://example.com/in/test" });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_url");
    assert.ok(body.message?.includes("linkedin.com"), `message="${body.message}"`);
  });

  test("400 when url is a LinkedIn company page (not /in/ path)", async () => {
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/company/acme",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_url");
    assert.ok(body.message?.includes("/in/"), `message="${body.message}"`);
  });

  test("400 when url is a LinkedIn jobs page", async () => {
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/jobs/view/12345",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_url");
  });

  test("400 when url is not a valid URL at all", async () => {
    const { status, body } = await postLinkedIn(app, { url: "not-a-url-at-all" });
    // "not-a-url-at-all" has no /in/ path after normalisation attempt
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });
});

describe("POST /api/resume/linkedin — URL normalisation", () => {
  before(installMock);
  after(restoreMock);

  test("accepts http:// LinkedIn URL and normalises to https://", async () => {
    // Provide a minimal HTML page with enough data to pass the sufficient check.
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <title>Jane Doe - Engineer | LinkedIn</title>
        <meta property="og:title" content="Jane Doe - Senior Engineer" />
        <meta property="og:description" content="Experienced engineer at Acme Corp." />
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "http://www.linkedin.com/in/janedoe",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // Normalised URL should use https and www subdomain.
    assert.ok(
      body.url?.startsWith("https://www.linkedin.com/in/"),
      `url="${body.url}"`
    );
  });

  test("strips query-string and fragment from LinkedIn URL", async () => {
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <meta property="og:title" content="Alice Kim - CTO" />
        <meta property="og:description" content="Tech leader with 15 years experience." />
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/alicekim?trk=nav_responsive_tab_profile#experience",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(!body.url?.includes("?"), `url should not contain query string: "${body.url}"`);
    assert.ok(!body.url?.includes("#"), `url should not contain fragment: "${body.url}"`);
  });
});

describe("POST /api/resume/linkedin — network errors", () => {
  before(installMock);
  after(restoreMock);

  test("502 when LinkedIn returns HTTP 999 (bot block)", async () => {
    _mockResponse = { statusCode: 999, body: "" };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error, "fetch_failed");
    assert.ok(body.message?.includes("999") || body.message?.includes("blocked"), `msg="${body.message}"`);
  });

  test("502 when LinkedIn returns HTTP 403", async () => {
    _mockResponse = { statusCode: 403, body: "" };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error, "fetch_failed");
    assert.ok(body.message?.includes("403") || body.message?.includes("authentication"), `msg="${body.message}"`);
  });

  test("502 when LinkedIn returns HTTP 401", async () => {
    _mockResponse = { statusCode: 401, body: "" };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error, "fetch_failed");
  });

  test("502 includes hint about PDF upload fallback on fetch failure", async () => {
    _mockResponse = { statusCode: 999, body: "" };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 502);
    assert.ok(body.hint, "should include a hint about PDF upload");
  });

  test("502 when network error occurs (e.g. ECONNREFUSED)", async () => {
    _mockResponse = { throw: new Error("connect ECONNREFUSED") };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error, "fetch_failed");
    assert.ok(body.message?.includes("ECONNREFUSED"), `msg="${body.message}"`);
  });
});

describe("POST /api/resume/linkedin — data sufficiency", () => {
  before(installMock);
  after(restoreMock);

  test("200 ok:false with insufficient_data when page returns sign-in wall", async () => {
    // LinkedIn redirects unauthenticated users to a sign-in page that lacks
    // structured profile data.
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <title>Sign in | LinkedIn</title>
        <meta property="og:title" content="LinkedIn: Log In or Sign Up" />
      </head><body>sign in</body></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/privateperson",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, "insufficient_data");
    assert.ok(body.partialData, "should include partialData");
    assert.ok(body.hint, "should include a hint");
  });

  test("200 ok:false with insufficient_data when page has name but no headline/about", async () => {
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <title>Jane Doe | LinkedIn</title>
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/janedoe",
    });

    // name only (no headline, no about) → insufficient
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, "insufficient_data");
  });

  test("200 ok:true when page has name and headline via og:title", async () => {
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <meta property="og:title" content="Jane Doe - Senior Engineer" />
        <meta property="og:description" content="10+ years in distributed systems." />
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/janedoe",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.source, "linkedin");
    assert.ok(body.data, "should include data");
    assert.ok(body.data.name?.includes("Jane"), `name="${body.data.name}"`);
  });

  test("200 ok:true when page has name and about via JSON-LD Person schema", async () => {
    const jsonLd = JSON.stringify({
      "@type": "Person",
      name: "Bob Kim",
      jobTitle: "Staff Engineer",
      description: "Building scalable systems at Startup Inc.",
    });

    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <script type="application/ld+json">${jsonLd}</script>
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/bobkim",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.name, "Bob Kim");
    assert.equal(body.data.headline, "Staff Engineer");
    assert.ok(body.data.about?.includes("scalable"), `about="${body.data.about}"`);
  });

  test("response data includes source=linkedin and normalised url", async () => {
    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <meta property="og:title" content="Test User - Developer" />
        <meta property="og:description" content="A developer." />
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/testuser",
    });

    assert.equal(status, 200);
    assert.equal(body.source, "linkedin");
    assert.equal(body.url, "https://www.linkedin.com/in/testuser");
  });
});

describe("POST /api/resume/linkedin — JSON-LD experience and education extraction", () => {
  before(installMock);
  after(restoreMock);

  test("extracts experience entries from worksFor in JSON-LD", async () => {
    const jsonLd = JSON.stringify({
      "@type": "Person",
      name: "Alice Park",
      jobTitle: "Principal Engineer",
      description: "Full-stack developer.",
      worksFor: [
        {
          name: "Senior Engineer",
          organizationName: "Kakao",
          description: "Built recommendation systems.",
        },
      ],
    });

    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <script type="application/ld+json">${jsonLd}</script>
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/alicepark",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.data.experience.length >= 1, `exp count=${body.data.experience.length}`);
    assert.equal(body.data.experience[0].company, "Kakao");
  });

  test("extracts education entries from alumniOf in JSON-LD", async () => {
    const jsonLd = JSON.stringify({
      "@type": "Person",
      name: "Chris Lee",
      jobTitle: "ML Engineer",
      description: "ML practitioner.",
      alumniOf: [
        {
          name: "Seoul National University",
          roleName: "Bachelor of Science",
        },
      ],
    });

    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <script type="application/ld+json">${jsonLd}</script>
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/chrislee",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.data.education.length >= 1, `edu count=${body.data.education.length}`);
    assert.ok(
      body.data.education[0].school.includes("Seoul National"),
      `school="${body.data.education[0].school}"`
    );
  });

  test("extracts skills from knowsAbout in JSON-LD", async () => {
    const jsonLd = JSON.stringify({
      "@type": "Person",
      name: "Dana Choi",
      jobTitle: "Backend Engineer",
      description: "Building APIs.",
      knowsAbout: ["Python", "Go", "Kubernetes"],
    });

    _mockResponse = {
      statusCode: 200,
      body: `<html><head>
        <script type="application/ld+json">${jsonLd}</script>
      </head></html>`,
    };

    const app = buildApp();
    const { status, body } = await postLinkedIn(app, {
      url: "https://www.linkedin.com/in/danachoi",
    });

    assert.equal(status, 200);
    assert.ok(body.data.skills.includes("Python"), `skills=${JSON.stringify(body.data.skills)}`);
    assert.ok(body.data.skills.includes("Go"));
    assert.ok(body.data.skills.includes("Kubernetes"));
  });
});

// ─── POST /api/linkedin/import — early-exit request validation ────────────────
//
// These tests exercise paths that return before any Vercel Blob call is made,
// so no blob mocking is required.  Full integration tests that cover the blob
// storage path live in src/routes/linkedin.import.test.mjs and are run with
// --experimental-test-module-mocks.

describe("POST /api/linkedin/import — request validation (no blob)", () => {
  test("400 when no file field is provided", async () => {
    const app = buildApp();
    const formData = new FormData();
    const res = await app.request("/api/linkedin/import", {
      method: "POST",
      body: formData,
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "missing_file");
  });

  test("400 when a string value is sent instead of a file", async () => {
    const app = buildApp();
    const formData = new FormData();
    formData.append("file", "not-a-file");
    const res = await app.request("/api/linkedin/import", {
      method: "POST",
      body: formData,
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    // Hono's parseBody treats a plain string field as a string, so
    // the handler branches on typeof fileField === "string" → missing_file or invalid_file.
    assert.ok(
      body.error === "missing_file" || body.error === "invalid_file",
      `error="${body.error}"`
    );
  });

  test("400 when an empty file is uploaded", async () => {
    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([], "empty.json", { type: "application/json" }));
    const res = await app.request("/api/linkedin/import", {
      method: "POST",
      body: formData,
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "empty_file");
  });

  test("200 ok:false with insufficient_data when JSON has no name (no blob needed)", async () => {
    // Insufficient data → handler returns before calling saveLinkedInImport.
    const profileJson = JSON.stringify({
      experience: [{ title: "Engineer", company: "TestCo" }],
      skills: ["Go"],
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append(
      "file",
      new File([profileJson], "profile.json", { type: "application/json" })
    );
    const res = await app.request("/api/linkedin/import", {
      method: "POST",
      body: formData,
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, "insufficient_data");
    assert.ok(body.partialData, "partialData should be included");
  });

  test("400 when the JSON file contains invalid JSON (no blob needed)", async () => {
    const app = buildApp();
    const formData = new FormData();
    formData.append(
      "file",
      new File(["{invalid json{{"], "bad.json", { type: "application/json" })
    );
    const res = await app.request("/api/linkedin/import", {
      method: "POST",
      body: formData,
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, "parse_error");
  });
});
