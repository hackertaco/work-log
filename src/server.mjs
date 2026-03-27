import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { runDailyBatch } from "./lib/batch.mjs";
import { loadConfig } from "./lib/config.mjs";
import { cookieAuth } from "./middleware/auth.mjs";
import { buildProfileSummary, readProfileSummary } from "./lib/profile.mjs";
import { fileExists } from "./lib/utils.mjs";
import { authRouter } from "./routes/auth.mjs";
import { resumeRouter } from "./routes/resume.mjs";
import { registerLinkedInRoutes } from "./routes/linkedin.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Serve Preact+Vite build output from dist/ in production.
// During development, the Vite dev server (port 5173) handles the frontend;
// this path is only used by `npm run serve` and the Vercel serverless function.
const publicDir = path.resolve(__dirname, "../dist");

export function createApp() {
  const app = new Hono();

  // ---------- Auth routes: POST /auth/login, DELETE /auth/logout ----------
  // Mount at both /auth (legacy) and /api/auth (canonical API path)
  app.route("/auth", authRouter);
  app.route("/api/auth", authRouter);

  // ---------- Cookie auth guard — /resume page and /api/resume/* API routes only ----------
  // Exact /resume path: browser visitor is redirected to /login; API caller gets 401.
  app.use("/resume", cookieAuth());
  // Sub-paths under /resume (e.g. /resume/edit): same guard.
  app.use("/resume/*", cookieAuth());
  // Resume API routes: cookieAuth returns 401 JSON for unauthenticated callers.
  app.use("/api/resume/*", cookieAuth());
  // LinkedIn import routes (/api/linkedin/import): protected by cookie auth.
  // LinkedIn data collection is part of the resume onboarding flow and must
  // be behind the same auth boundary as the resume API.
  app.use("/api/linkedin/*", cookieAuth());

  // ---------- Resume API routes (protected by cookieAuth above) ----------
  app.route("/api/resume", resumeRouter);

  // LinkedIn fetch route: POST /api/resume/linkedin (protected by cookieAuth above)
  registerLinkedInRoutes(app);

  // ---------- API routes ----------
  app.get("/api/days", async (c) => {
    return c.json(await readAvailableDays());
  });

  app.get("/api/day/:date", async (c) => {
    const date = c.req.param("date");
    return c.json(await readDailySummary(date));
  });

  app.get("/api/profile", async (c) => {
    return c.json(await readOrBuildProfile());
  });

  app.post("/api/run-batch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await runDailyBatch(body?.date);
    return c.json(result);
  });

  // ---------- GET /login — Login page route ----------
  // cookieAuth() redirects unauthenticated browser visitors to /login.
  // Serve index.html (the Preact SPA shell); the client-side router renders
  // the LoginPage component for the /login pathname.
  app.get("/login", async (c) => {
    return serveStatic("/index.html", c);
  });

  // ---------- GET /resume — SPA page route ----------
  // Authenticated users (past cookieAuth guard above) get index.html so that
  // the Preact client-side router handles the /resume path.
  app.get("/resume", async (c) => {
    return serveStatic("/index.html", c);
  });

  // ---------- Static file fallback ----------
  // For known SPA routes (no file extension), serve index.html to allow
  // client-side routing.  For asset requests (.js, .css, etc.) try the file
  // directly and return 404 only when it genuinely does not exist.
  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    return serveStatic(pathname, c);
  });

  return app;
}

export async function startServer(port = 4310, host = "127.0.0.1") {
  // Ensure env is loaded before creating the app.
  await loadConfig();

  const app = createApp();
  const server = serve({ fetch: app.fetch, port, hostname: host });
  return server;
}

// ---------- Helpers ----------

async function readAvailableDays() {
  const config = await loadConfig();
  const dailyDir = path.join(config.dataDir, "daily");
  if (!(await fileExists(dailyDir))) return [];
  const entries = await fs.readdir(dailyDir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort()
    .reverse();
}

async function readDailySummary(date) {
  const config = await loadConfig();
  const filePath = path.join(config.dataDir, "daily", `${date}.json`);
  if (!(await fileExists(filePath))) {
    return { missing: true, date };
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readOrBuildProfile() {
  const config = await loadConfig();
  const profile = await readProfileSummary(config);
  if (profile.updatedAt) return profile;
  return (await buildProfileSummary(config)).profile;
}

async function serveStatic(pathname, c) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, target);

  if (!(await fileExists(filePath))) {
    // For extension-less paths (SPA routes like /login, /resume, /projects)
    // fall back to index.html so the Preact router handles navigation.
    // Asset requests (.js, .css, .png …) get a proper 404.
    const ext = path.extname(target);
    if (!ext) {
      const indexPath = path.join(publicDir, "index.html");
      if (await fileExists(indexPath)) {
        const content = await fs.readFile(indexPath);
        return new Response(content, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    }
    return c.text("Not found", 404);
  }

  const ext = path.extname(filePath);
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  const contentType = contentTypeMap[ext] ?? "text/plain; charset=utf-8";

  const content = await fs.readFile(filePath);
  return new Response(content, {
    headers: { "Content-Type": contentType }
  });
}
