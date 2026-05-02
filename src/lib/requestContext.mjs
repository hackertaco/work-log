import { AsyncLocalStorage } from 'node:async_hooks';

import { DEFAULT_USER_ID, sanitizeUserId } from './authUsers.mjs';

const storage = new AsyncLocalStorage();

export function runWithRequestContext(context, fn) {
  return storage.run(normalizeContext(context), fn);
}

export function getRequestContext() {
  return storage.getStore() || { userId: DEFAULT_USER_ID };
}

export function getCurrentUserId() {
  return getRequestContext().userId || DEFAULT_USER_ID;
}

function normalizeContext(context) {
  return {
    userId: sanitizeUserId(context?.userId),
  };
}
