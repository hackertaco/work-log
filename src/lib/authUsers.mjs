export const DEFAULT_USER_ID = "default";

export function sanitizeUserId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return DEFAULT_USER_ID;
  const normalized = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || DEFAULT_USER_ID;
}

export function getAuthUsers() {
  const parsed = parseUsersJson(process.env.WORK_LOG_USERS_JSON);
  if (parsed.length) return parsed;

  const fallbackToken = process.env.RESUME_TOKEN ?? process.env.RESUME_AUTH_TOKEN ?? "";
  if (!fallbackToken) return [];

  return [{ id: DEFAULT_USER_ID, token: fallbackToken }];
}

export function findAuthUserByToken(token) {
  if (typeof token !== "string" || !token) return null;
  return getAuthUsers().find((user) => user.token === token) || null;
}

function parseUsersJson(raw) {
  if (!raw || typeof raw !== "string") return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const seen = new Set();
  const users = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const token = typeof item.token === "string" ? item.token.trim() : "";
    if (!token) continue;
    const id = sanitizeUserId(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    users.push({ id, token, name: typeof item.name === "string" ? item.name.trim() : undefined });
  }

  return users;
}
