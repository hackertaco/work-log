/**
 * Vercel serverless entry point.
 *
 * Imports the Hono app and exports it using Hono's Vercel adapter.
 * All API requests are routed through this handler.
 *
 * Environment variables expected at runtime (set in Vercel dashboard):
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob read/write token
 *   WORK_LOG_USERS_JSON              — Invite-only user/token mapping
 *
 * LLM credentials do not belong in Vercel. Production is collection/read-only;
 * local scheduled workers use the CLIProxy from ~/.codex/config.toml.
 */

// Node.js 런타임에서는 @hono/node-server 어댑터를 써야 한다.
// hono/vercel 은 Edge(fetch) 런타임용이라 Node 에서는 상대 URL이 그대로
// Hono 라우터에 들어와 모든 요청이 catch-all 로 빠지며 500이 난다.
import { handle } from "@hono/node-server/vercel";

import { createApp } from "../src/server.mjs";
import { ensureVercelRawBody } from "../src/lib/vercelRequestBody.mjs";

export const config = {
  runtime: "nodejs",
  // Vercel Node 런타임의 body 헬퍼가 요청 스트림을 먼저 소비하면
  // Hono 어댑터가 body를 영원히 기다린다 (POST 45초 행업).
  api: { bodyParser: false }
};

const app = createApp();
const honoHandler = handle(app);

export default async function vercelHandler(request, response) {
  await ensureVercelRawBody(request);
  return honoHandler(request, response);
}
