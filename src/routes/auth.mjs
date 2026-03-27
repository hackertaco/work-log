import { Hono } from "hono";

const COOKIE_NAME = "resume_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

/**
 * Build a Set-Cookie header value.
 * Uses Secure only when not on localhost (detected via request host).
 */
function buildSetCookieHeader(value, maxAge, host) {
  const isLocalhost =
    host?.startsWith("localhost") || host?.startsWith("127.");
  const secure = isLocalhost ? "" : "; Secure";
  return `${COOKIE_NAME}=${value}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/**
 * Build a cookie-clearing Set-Cookie header.
 */
function buildClearCookieHeader(host) {
  const isLocalhost =
    host?.startsWith("localhost") || host?.startsWith("127.");
  const secure = isLocalhost ? "" : "; Secure";
  return `${COOKIE_NAME}=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`;
}

export const authRouter = new Hono();

/**
 * POST /auth/login
 *
 * Body: { "token": "<resume-token>" }
 *
 * Validates the submitted token against the RESUME_TOKEN environment variable.
 * On success, issues an HttpOnly cookie and returns 200.
 * On failure, returns 401.
 */
authRouter.post("/login", async (c) => {
  const resumeToken = process.env.RESUME_TOKEN;
  if (!resumeToken) {
    return c.json({ error: "Server misconfiguration: RESUME_TOKEN not set" }, 500);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { token } = body ?? {};
  if (typeof token !== "string" || token.length === 0) {
    return c.json({ error: "token field is required" }, 400);
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, resumeToken)) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const host = c.req.header("host") ?? "";
  c.header("Set-Cookie", buildSetCookieHeader(resumeToken, COOKIE_MAX_AGE, host));
  return c.json({ ok: true });
});

/**
 * POST /auth/logout
 *
 * Clears the HttpOnly resume_token cookie.
 * Always returns 200 regardless of whether the cookie was set.
 */
authRouter.post("/logout", (c) => {
  const host = c.req.header("host") ?? "";
  c.header("Set-Cookie", buildClearCookieHeader(host));
  return c.json({ ok: true });
});

/**
 * Naive constant-time string comparison.
 * Prevents early-exit timing attacks without requiring crypto.timingSafeEqual
 * (which only works on Buffers of equal length).
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Pad the shorter string so lengths always match before comparing bytes
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    const charA = a.charCodeAt(i) || 0;
    const charB = b.charCodeAt(i) || 0;
    mismatch |= charA ^ charB;
  }
  return mismatch === 0;
}
