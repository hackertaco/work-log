/**
 * Authentication middleware for Hono.
 *
 * cookieAuth() — guards page routes (/resume) and their API counterparts.
 *   • Validates the `resume_token` HttpOnly cookie against RESUME_TOKEN.
 *   • API paths (starting with /api/): returns 401 JSON on failure.
 *   • Page paths (e.g. /resume):       redirects to /login?next=<path> on failure.
 *
 * bearerAuth() — kept for non-resume API routes that still rely on the
 *   Authorization header (legacy). Uses RESUME_TOKEN (falls back to
 *   RESUME_AUTH_TOKEN for backward compatibility).
 *
 * Both use a naive constant-time comparison to prevent timing attacks.
 *
 * Usage:
 *   import { cookieAuth } from "./middleware/auth.mjs";
 *
 *   // Protect the /resume page — redirects browser to /login if unauthenticated
 *   app.use("/resume", cookieAuth());
 *   app.use("/resume/*", cookieAuth());
 *
 *   // Protect /api/resume/* — returns 401 JSON if unauthenticated
 *   app.use("/api/resume/*", cookieAuth());
 */

export const COOKIE_NAME = "resume_token";
const LOGIN_PATH = "/login";

/**
 * Parse a raw Cookie header string into a key→value map.
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

/**
 * Naive constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Cookie-based authentication middleware.
 *
 * Validates the `resume_token` HttpOnly cookie against process.env.RESUME_TOKEN.
 *
 * On authentication failure the response depends on the request path:
 *   - Paths under /api/ → 401 JSON  (programmatic callers)
 *   - All other paths  → 302 redirect to /login?next=<encoded-path>  (browser visitors)
 *
 * @returns {import("hono").MiddlewareHandler}
 */
export function cookieAuth() {
  return async (c, next) => {
    const expectedToken = process.env.RESUME_TOKEN;

    if (!expectedToken) {
      // Fail closed — RESUME_TOKEN must be set before using this middleware.
      return c.json({ error: "Server authentication not configured" }, 500);
    }

    const cookieHeader = c.req.header("cookie") ?? "";
    const cookies = parseCookies(cookieHeader);
    const token = cookies[COOKIE_NAME] ?? "";

    if (timingSafeEqual(token, expectedToken)) {
      // Valid cookie — continue to the next handler.
      await next();
      return;
    }

    // Unauthenticated request — choose the appropriate response.
    const pathname = new URL(c.req.url).pathname;

    if (pathname.startsWith("/api/")) {
      // API caller — return JSON 401 so fetch() callers can handle it.
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Browser page visitor — redirect to the login page.
    // Preserve the original destination so we can return after login.
    const next_ = encodeURIComponent(pathname);
    return c.redirect(`${LOGIN_PATH}?next=${next_}`, 302);
  };
}

/**
 * Bearer token authentication middleware.
 *
 * Validates the "Authorization: Bearer <token>" header.
 * Always returns 401 JSON on failure (never redirects — callers are API clients).
 *
 * Uses RESUME_TOKEN; falls back to RESUME_AUTH_TOKEN for backward compatibility.
 *
 * @returns {import("hono").MiddlewareHandler}
 */
export function bearerAuth() {
  return async (c, next) => {
    const expectedToken = process.env.RESUME_TOKEN ?? process.env.RESUME_AUTH_TOKEN;

    if (!expectedToken) {
      return c.json({ error: "Server authentication not configured" }, 500);
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token || !timingSafeEqual(token, expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
  };
}
