import { saveSession, readSession } from "./blob.mjs";

export async function createSession(userId) {
  const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const session = {
    sessionId,
    userId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    messages: [],
    agentState: {
      pendingDiffs: [],
      pendingSuggestions: [],
      completedSuggestions: [],
      resumeVersion: 0,
    },
  };
  await saveSession(sessionId, session);
  return session;
}

export async function loadSession(sessionId) {
  const data = await readSession(sessionId);
  if (!data) return null;
  if (!data.sessionId || !Array.isArray(data.messages) || !data.agentState) {
    console.error(`[SessionStore] Corrupt session ${sessionId}, missing required fields`);
    await saveSession(`${sessionId}.corrupt`, data);
    return null;
  }
  return data;
}

export async function updateSession(sessionId, expectedVersion, mutator) {
  const session = await readSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.version !== expectedVersion) {
    throw new Error(
      `Version conflict: expected ${expectedVersion}, got ${session.version}. ` +
      `Another request may have modified this session.`
    );
  }
  mutator(session);
  session.version += 1;
  session.updatedAt = new Date().toISOString();
  await saveSession(sessionId, session);
  return session;
}
