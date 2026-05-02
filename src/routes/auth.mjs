import { Hono } from "hono";

import { findAuthUserByToken } from "../lib/authUsers.mjs";
import { resolveRequestUser } from "../middleware/auth.mjs";

const COOKIE_NAME = "resume_token";
const USER_COOKIE_NAME = "worklog_user";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days in seconds

function isLocalDevelopmentHost(host = "") {
  const normalized = host.trim().toLowerCase();
  return (
    normalized.startsWith("localhost") ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized.startsWith("[::1]")
  );
}

/**
 * Build a Set-Cookie header value.
 * Uses Secure only when not on localhost (detected via request host).
 */
function buildSetCookieHeader(value, maxAge, host) {
  const isLocalhost = isLocalDevelopmentHost(host);
  const secure = isLocalhost ? "" : "; Secure";
  return `${COOKIE_NAME}=${value}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function buildUserCookieHeader(userId, maxAge, host) {
  const isLocalhost = isLocalDevelopmentHost(host);
  const secure = isLocalhost ? "" : "; Secure";
  return `${USER_COOKIE_NAME}=${userId}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/**
 * Build a cookie-clearing Set-Cookie header.
 */
function buildClearCookieHeader(host) {
  const isLocalhost = isLocalDevelopmentHost(host);
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
  const users = process.env.WORK_LOG_USERS_JSON || process.env.RESUME_TOKEN || process.env.RESUME_AUTH_TOKEN;
  if (!users) {
    return c.json({ error: "Server misconfiguration: authentication not configured" }, 500);
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

  const user = findAuthUserByToken(token);
  if (!user || !timingSafeEqual(token, user.token)) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const host = c.req.header("host") ?? "";
  c.header("Set-Cookie", buildSetCookieHeader(user.token, COOKIE_MAX_AGE, host), { append: true });
  c.header("Set-Cookie", buildUserCookieHeader(user.id, COOKIE_MAX_AGE, host), { append: true });
  return c.json({ ok: true, userId: user.id });
});

authRouter.get("/me", (c) => {
  const user = resolveRequestUser(c);
  const cookie = c.req.header("cookie") ?? "";
  const authenticated = /resume_token=/.test(cookie) && Boolean(user?.id && user.id !== "default" ? user.id : user?.id);
  return c.json({ authenticated: Boolean(user?.id && /resume_token=/.test(cookie)), userId: user?.id ?? null });
});

/**
 * POST /auth/logout
 *
 * Clears the HttpOnly resume_token cookie.
 * Always returns 200 regardless of whether the cookie was set.
 */
authRouter.post("/logout", (c) => {
  const host = c.req.header("host") ?? "";
  c.header("Set-Cookie", buildClearCookieHeader(host), { append: true });
  c.header("Set-Cookie", `${USER_COOKIE_NAME}=; HttpOnly${isLocalDevelopmentHost(host) ? "" : "; Secure"}; SameSite=Strict; Path=/; Max-Age=0`, { append: true });
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
