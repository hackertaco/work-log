/**
 * Resume Agent SSE endpoint.
 *
 * POST /api/resume/agent — handles 5 actions via SSE streaming:
 *   init, message, approve_diff, reject_diff, revise_diff
 *
 * Streaming actions (init, message, revise_diff) use raw ReadableStream
 * to push Server-Sent Events.  Non-streaming actions (approve_diff,
 * reject_diff) return plain JSON.
 */

import { Hono } from "hono";
import { createSession, loadSession, updateSession } from "../lib/resumeSessionStore.mjs";
import { runAgentLoop } from "../lib/resumeAgent.mjs";
import { readResumeData } from "../lib/blob.mjs";

export const agentRouter = new Hono();

const VALID_ACTIONS = new Set([
  "init",
  "message",
  "approve_diff",
  "reject_diff",
  "revise_diff",
]);

agentRouter.post("/agent", async (c) => {
  const body = await c.req.json();
  const { action, sessionId, text, messageId } = body;

  // ── Validate action ──────────────────────────────────────────────────────
  if (!action) {
    return c.json({ error: "Missing action" }, 400);
  }
  if (!VALID_ACTIONS.has(action)) {
    return c.json({ error: `Unknown action: ${action}` }, 400);
  }

  // ── Non-init actions require sessionId ────────────────────────────────────
  if (action !== "init" && !sessionId) {
    return c.json({ error: "Missing sessionId" }, 400);
  }

  // ── message requires text ────────────────────────────────────────────────
  if (action === "message" && !text) {
    return c.json({ error: "Missing text" }, 400);
  }

  // ── approve/reject/revise require messageId ──────────────────────────────
  if (
    (action === "approve_diff" ||
      action === "reject_diff" ||
      action === "revise_diff") &&
    !messageId
  ) {
    return c.json({ error: "Missing messageId" }, 400);
  }

  // ── approve_diff (non-streaming) ─────────────────────────────────────────
  if (action === "approve_diff") {
    const session = await loadSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const pending = session.agentState.pendingDiffs || [];
    const idx = pending.findIndex((d) => d.messageId === messageId);
    if (idx === -1) {
      return c.json({ error: "No pending diff for this messageId" }, 404);
    }

    const diff = pending[idx];

    // Check TTL (5 min default)
    const TTL_MS = 5 * 60 * 1000;
    if (diff.createdAt && Date.now() - new Date(diff.createdAt).getTime() > TTL_MS) {
      return c.json({ error: "Diff expired" }, 410);
    }

    // Check baseVersion
    if (
      body.baseVersion !== undefined &&
      diff.baseVersion !== undefined &&
      body.baseVersion !== diff.baseVersion
    ) {
      return c.json({ error: "Version mismatch" }, 409);
    }

    // Remove from pending
    await updateSession(sessionId, session.version, (s) => {
      s.agentState.pendingDiffs = s.agentState.pendingDiffs.filter(
        (d) => d.messageId !== messageId,
      );
    });

    return c.json({ ok: true, diff });
  }

  // ── reject_diff (non-streaming) ──────────────────────────────────────────
  if (action === "reject_diff") {
    const session = await loadSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await updateSession(sessionId, session.version, (s) => {
      s.agentState.pendingDiffs = (s.agentState.pendingDiffs || []).filter(
        (d) => d.messageId !== messageId,
      );
    });

    return c.json({ ok: true });
  }

  // ── Streaming actions: init, message, revise_diff ────────────────────────
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        try {
          let session;

          if (action === "init") {
            // Create new session
            const userId = body.userId || "anonymous";
            session = await createSession(userId);
            send({ type: "session", sessionId: session.sessionId });

            // Load resume summary for context
            let resumeSummary = "";
            try {
              const resume = await readResumeData();
              if (resume?.contact?.name) {
                resumeSummary = `이름: ${resume.contact.name}`;
              }
            } catch {
              // Resume may not exist yet — that's fine
            }

            const initMessage = {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: text || "이력서 개선을 시작합니다. 현재 이력서를 분석해주세요.",
                },
              ],
            };
            session.messages.push(initMessage);

            await runAgentLoop({
              messages: session.messages,
              resumeSummary,
              onEvent: send,
            });

            // Save session after agent loop
            await updateSession(session.sessionId, session.version, (s) => {
              s.messages = session.messages;
            });
          } else if (action === "message") {
            session = await loadSession(sessionId);
            if (!session) {
              send({ type: "error", error: "Session not found" });
              controller.close();
              return;
            }

            const userMessage = {
              role: "user",
              content: [{ type: "input_text", text }],
            };
            session.messages.push(userMessage);

            let resumeSummary = "";
            try {
              const resume = await readResumeData();
              if (resume?.contact?.name) {
                resumeSummary = `이름: ${resume.contact.name}`;
              }
            } catch {
              // ok
            }

            await runAgentLoop({
              messages: session.messages,
              resumeSummary,
              onEvent: send,
            });

            await updateSession(sessionId, session.version, (s) => {
              s.messages = session.messages;
            });
          } else if (action === "revise_diff") {
            session = await loadSession(sessionId);
            if (!session) {
              send({ type: "error", error: "Session not found" });
              controller.close();
              return;
            }

            const revisionText =
              text || `messageId ${messageId}의 diff를 수정해주세요.`;
            const revisionMessage = {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `[Revision request for diff ${messageId}] ${revisionText}`,
                },
              ],
            };
            session.messages.push(revisionMessage);

            let resumeSummary = "";
            try {
              const resume = await readResumeData();
              if (resume?.contact?.name) {
                resumeSummary = `이름: ${resume.contact.name}`;
              }
            } catch {
              // ok
            }

            await runAgentLoop({
              messages: session.messages,
              resumeSummary,
              onEvent: send,
            });

            await updateSession(sessionId, session.version, (s) => {
              s.messages = session.messages;
            });
          }

          send({ type: "done" });
        } catch (err) {
          send({ type: "error", error: err.message });
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});
