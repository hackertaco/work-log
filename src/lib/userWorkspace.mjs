import path from "node:path";
import { DEFAULT_USER_ID, sanitizeUserId } from "./authUsers.mjs";

export function isDefaultUserId(userId) {
  return sanitizeUserId(userId) === DEFAULT_USER_ID;
}

export function scopeLocalDir(baseDir, userId) {
  if (isDefaultUserId(userId)) return baseDir;
  return path.join(baseDir, "users", sanitizeUserId(userId));
}
