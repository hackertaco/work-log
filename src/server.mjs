import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { runDailyBatch } from "./lib/batch.mjs";
import { loadConfig } from "./lib/config.mjs";
import {
  registerResumeBatchHook,
  registerGranularTriggers,
  emitWorkLogSaved,
  emitCommitCollected,
  emitSlackCollected,
  emitSessionCollected,
  WORK_LOG_EVENTS
} from "./lib/workLogEventBus.mjs";
import { cookieAuth, resolveRequestUser } from "./middleware/auth.mjs";
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
  // Worklog API routes are also user-scoped and must not leak the default workspace.
  app.use("/api/days", cookieAuth());
  app.use("/api/day/*", cookieAuth());
  app.use("/api/profile", cookieAuth());
  app.use("/api/run-batch", cookieAuth());

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
    const user = resolveRequestUser(c);
    return c.json(await readAvailableDays(user.id));
  });

  app.get("/api/day/:date", async (c) => {
    const user = resolveRequestUser(c);
    const date = c.req.param("date");
    return c.json(await readDailySummary(date, user.id));
  });

  app.get("/api/profile", async (c) => {
    const user = resolveRequestUser(c);
    const rawWindow = c.req.query("window");
    const windowDays = rawWindow === "all" || !rawWindow
      ? null
      : Number(rawWindow);
    return c.json(await readOrBuildProfile(windowDays, user.id));
  });

  app.post("/api/run-batch", async (c) => {
    const user = resolveRequestUser(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await runDailyBatch(body?.date, { userId: user.id });
    return c.json(result);
  });

  // ── Work-log event trigger (Sub-AC 2-1) ───────────────────────────────────
  //
  // POST /api/work-log/event
  //
  // Accepts an external work-log update event and triggers the registered hooks
  // (resumeBatchHook by default) without running the full batch pipeline.
  //
  // Use this endpoint when individual data sources are updated outside the
  // daily batch run — e.g., a git post-commit hook, a CI webhook, or a
  // manual trigger from the frontend.
  //
  // Request body:
  //   {
  //     "type":    "work_log_saved" | "commit_collected" | "slack_collected" | "session_collected"
  //     "date":    "YYYY-MM-DD"         (optional; defaults to today)
  //     "workLog": { ... }              (required for "work_log_saved")
  //   }
  //
  // Response:
  //   200 { triggered: true, event: <type>, date: <date>, hookResult: <CandidateHookResult> }
  //   400 { error: "..." } — missing required fields
  //
  // Authentication: protected by the /api/resume cookie-auth guard above.
  // (No separate guard needed — this endpoint sits under /api and has the
  //  same auth boundary as the rest of the authenticated API surface.)
  app.post("/api/work-log/event", cookieAuth(), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const eventType = body?.type ?? WORK_LOG_EVENTS.WORK_LOG_SAVED;
    const date = body?.date ?? new Date().toISOString().slice(0, 10);

    if (eventType === WORK_LOG_EVENTS.WORK_LOG_SAVED) {
      if (!body?.workLog) {
        return c.json({ error: "workLog is required for work_log_saved events" }, 400);
      }
      const user = resolveRequestUser(c);
      const hookResult = await emitWorkLogSaved(date, body.workLog, user.id);
      return c.json({ triggered: true, event: eventType, date, hookResult });
    }

    // For granular events (commit/slack/session), emit via the event bus so
    // that registered granular triggers can schedule a debounced background
    // batch run.  The granular triggers (registered at startup) coalesce
    // multiple events for the same date into a single batch run that builds
    // the full workLog summary and triggers resumeBatchHook.
    if (eventType === WORK_LOG_EVENTS.COMMIT_COLLECTED) {
      const user = resolveRequestUser(c);
      emitCommitCollected(date, body?.commits ?? [], user.id);
      return c.json({ triggered: true, event: eventType, date, backgroundBatchScheduled: true });
    }
    if (eventType === WORK_LOG_EVENTS.SLACK_COLLECTED) {
      const user = resolveRequestUser(c);
      emitSlackCollected(date, body?.contexts ?? [], user.id);
      return c.json({ triggered: true, event: eventType, date, backgroundBatchScheduled: true });
    }
    if (eventType === WORK_LOG_EVENTS.SESSION_COLLECTED) {
      const user = resolveRequestUser(c);
      emitSessionCollected(date, body?.sessions ?? [], user.id);
      return c.json({ triggered: true, event: eventType, date, backgroundBatchScheduled: true });
    }

    return c.json({ error: `Unknown event type: ${eventType}` }, 400);
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

export async function startServer(port = 4310, host = "localhost") {
  // Ensure env is loaded before creating the app.
  await loadConfig();

  // Register the resume batch hook so that emitWorkLogSaved() (called from
  // batch.mjs and POST /api/work-log/event) triggers runResumeCandidateHook.
  // Idempotent — safe to call multiple times (Sub-AC 2-1).
  await registerResumeBatchHook();

  // Register granular event triggers so that external data-source updates
  // (commit/slack/session collected via POST /api/work-log/event) schedule a
  // debounced background batch run → which builds the full workLog summary
  // and triggers resumeBatchHook via emitWorkLogSaved.
  registerGranularTriggers(runDailyBatch);

  const app = createApp();
  const server = serve({ fetch: app.fetch, port, hostname: host });
  return server;
}

// ---------- Helpers ----------

async function readAvailableDays(userId = "default") {
  const config = await loadConfig({ userId });
  const dailyDir = path.join(config.dataDir, "daily");
  if (!(await fileExists(dailyDir))) return [];
  const entries = await fs.readdir(dailyDir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort()
    .reverse();
}

async function readDailySummary(date, userId = "default") {
  const config = await loadConfig({ userId });
  const filePath = path.join(config.dataDir, "daily", `${date}.json`);
  if (!(await fileExists(filePath))) {
    return { missing: true, date };
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readOrBuildProfile(windowDays = null, userId = "default") {
  const config = await loadConfig({ userId });
  if (windowDays) {
    return readProfileSummary(config, { windowDays });
  }
  const profile = await readProfileSummary(config);
  if (profile.updatedAt) return profile;
  return (await buildProfileSummary(config)).profile;
}

async function serveStatic(pathname, c) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, target);

  if (!(await fileExists(filePath))) {
    // Unknown API paths must never fall back to the SPA shell.
    // Returning HTML here causes fetch(...).json() callers to fail with
    // opaque "Unexpected token '<'" errors.
    if (target.startsWith("/api/")) {
      return c.text("Not found", 404);
    }

    // For extension-less paths (SPA routes like /login, /resume, /projects)
    // fall back to index.html so the Preact router handles navigation.
    // Asset requests (.js, .css, .png …) get a proper 404.
    const ext = path.extname(target);
    if (!ext) {
      const indexPath = path.join(publicDir, "index.html");
      if (await fileExists(indexPath)) {
        let content = await fs.readFile(indexPath, "utf-8");
        content = injectRuntimeEnv(content);
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

  let content = await fs.readFile(filePath, ext === ".html" ? "utf-8" : undefined);
  if (ext === ".html") content = injectRuntimeEnv(content);
  return new Response(content, {
    headers: { "Content-Type": contentType }
  });
}

function injectRuntimeEnv(html) {
  const agentEnabled = process.env.RESUME_AGENT_ENABLED !== "0";
  const script = `<script>window.__RESUME_AGENT_ENABLED=${agentEnabled};</script>`;
  return html.replace("</head>", `${script}</head>`);
}
