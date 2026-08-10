/**
 * Cost-safety boundary for every Vercel Blob SDK call.
 *
 * Keep provider calls in this module so production storage has one fail-closed
 * kill switch, one timeout policy, hard byte/item ceilings, zero SDK retries,
 * and metadata-only telemetry. Never log pathnames, tokens, or payloads here.
 */

import {
  del as rawDel,
  get as rawGet,
  list as rawList,
  put as rawPut,
} from "@vercel/blob";
import { getRequestContext } from "./requestContext.mjs";

const HARD_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  writeBytes: 20 * 1024 * 1024,
  readBytes: 20 * 1024 * 1024,
  listItems: 1_000,
  deleteItems: 100,
});

const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  writeBytes: HARD_LIMITS.writeBytes,
  readBytes: HARD_LIMITS.readBytes,
  listItems: 250,
  deleteItems: 100,
});

function boundedPositiveInteger(value, fallback, hardMaximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, hardMaximum);
}

function limits() {
  return {
    timeoutMs: boundedPositiveInteger(
      process.env.WORK_LOG_BLOB_TIMEOUT_MS,
      DEFAULT_LIMITS.timeoutMs,
      HARD_LIMITS.timeoutMs,
    ),
    writeBytes: boundedPositiveInteger(
      process.env.WORK_LOG_BLOB_MAX_WRITE_BYTES,
      DEFAULT_LIMITS.writeBytes,
      HARD_LIMITS.writeBytes,
    ),
    readBytes: boundedPositiveInteger(
      process.env.WORK_LOG_BLOB_MAX_READ_BYTES,
      DEFAULT_LIMITS.readBytes,
      HARD_LIMITS.readBytes,
    ),
    listItems: boundedPositiveInteger(
      process.env.WORK_LOG_BLOB_MAX_LIST_ITEMS,
      DEFAULT_LIMITS.listItems,
      HARD_LIMITS.listItems,
    ),
    deleteItems: boundedPositiveInteger(
      process.env.WORK_LOG_BLOB_MAX_DELETE_ITEMS,
      DEFAULT_LIMITS.deleteItems,
      HARD_LIMITS.deleteItems,
    ),
  };
}

function assertEnabled() {
  if (process.env.WORK_LOG_DISABLE_BLOB === "1") {
    throw new Error("Vercel Blob operations are disabled by WORK_LOG_DISABLE_BLOB");
  }
}

function byteLengthOf(body) {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  throw new TypeError("Blob uploads require a body with a measurable byte length");
}

function optionsWithTimeout(options, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = options?.abortSignal;
  const abortSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  return { ...(options ?? {}), abortSignal };
}

function emitTelemetry({ operation, startedAt, outcome, bytes = 0, items = 0, error }) {
  const context = getRequestContext();
  const event = {
    event: "metered_provider_call",
    provider: "vercel_blob",
    operation,
    route: context.route,
    trigger: context.trigger,
    request_count: 1,
    retry_count: 0,
    bytes,
    items,
    latency_ms: Math.max(0, Date.now() - startedAt),
    outcome,
    provider_request_id: null,
  };
  if (error) event.error_type = error?.constructor?.name || error?.name || "Error";
  console.info(JSON.stringify(event));
}

async function readBoundedStream(stream, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Blob read byte ceiling exceeded").catch(() => {});
        throw new RangeError(`Blob read exceeds the ${maximumBytes}-byte ceiling`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function runOperation(operation, execute, usage = () => ({})) {
  assertEnabled();
  // @vercel/blob defaults to ten retries. A metered boundary must not silently
  // multiply calls, so this is reasserted immediately before every SDK call.
  process.env.VERCEL_BLOB_RETRIES = "0";
  const startedAt = Date.now();
  try {
    const result = await execute();
    emitTelemetry({ operation, startedAt, outcome: "success", ...usage(result) });
    return result;
  } catch (error) {
    emitTelemetry({ operation, startedAt, outcome: "error", error, ...usage(null) });
    throw error;
  }
}

export async function put(pathname, body, options) {
  const policy = limits();
  if (options?.multipart === true) {
    throw new RangeError("Multipart Blob uploads are disabled at the metered boundary");
  }
  const bytes = byteLengthOf(body);
  if (bytes > policy.writeBytes) {
    throw new RangeError(`Blob write exceeds the ${policy.writeBytes}-byte ceiling`);
  }
  return runOperation(
    "put",
    () => rawPut(pathname, body, optionsWithTimeout({ ...(options ?? {}), multipart: false }, policy.timeoutMs)),
    () => ({ bytes, items: 1 }),
  );
}

export async function list(options = {}) {
  const policy = limits();
  const requestedLimit = Number.isFinite(options?.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : policy.listItems;
  const cappedOptions = {
    ...(options ?? {}),
    limit: Math.min(requestedLimit, policy.listItems),
  };
  return runOperation(
    "list",
    () => rawList(optionsWithTimeout(cappedOptions, policy.timeoutMs)),
    (result) => ({
      bytes: 0,
      items: result?.blobs?.length ?? 0,
    }),
  );
}

export async function get(pathname, options) {
  const policy = limits();
  return runOperation(
    "get",
    async () => {
      const result = await rawGet(pathname, optionsWithTimeout(options, policy.timeoutMs));
      if (!result || result.statusCode === 304) return result;
      if (result && (!Number.isSafeInteger(result?.blob?.size) || result.blob.size < 0)) {
        await result?.stream?.cancel?.().catch?.(() => {});
        throw new RangeError("Blob read response is missing a safe byte length");
      }
      const bytes = result?.blob?.size ?? 0;
      if (bytes > policy.readBytes) {
        await result?.stream?.cancel?.().catch?.(() => {});
        throw new RangeError(`Blob read exceeds the ${policy.readBytes}-byte ceiling`);
      }
      const body = await readBoundedStream(result.stream, policy.readBytes);
      return {
        ...result,
        stream: new Blob([body]).stream(),
        blob: { ...result.blob, size: body.byteLength },
      };
    },
    (result) => ({ bytes: Number(result?.blob?.size) || 0, items: result ? 1 : 0 }),
  );
}

export async function del(target, options) {
  const policy = limits();
  const items = Array.isArray(target) ? target.length : 1;
  if (items > policy.deleteItems) {
    throw new RangeError(`Blob delete exceeds the ${policy.deleteItems}-item ceiling`);
  }
  return runOperation(
    "delete",
    () => rawDel(target, optionsWithTimeout(options, policy.timeoutMs)),
    () => ({ items }),
  );
}

export const BLOB_COST_HARD_LIMITS = HARD_LIMITS;
