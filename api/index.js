/**
 * Vercel serverless entry point.
 *
 * Imports the Hono app and exports it using Hono's Vercel adapter.
 * All API requests are routed through this handler.
 *
 * Environment variables expected at runtime (set in Vercel dashboard):
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob read/write token
 *   RESUME_TOKEN           — Fixed token for /resume and /api/resume/* auth
 *   OPENAI_API_KEY         — OpenAI API key for summarization
 */

import { handle } from "hono/vercel";

import { createApp } from "../src/server.mjs";

export const config = {
  runtime: "nodejs"
};

const app = createApp();

export default handle(app);
