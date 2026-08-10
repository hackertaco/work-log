/**
 * Materialize a Vercel Node request body for @hono/node-server.
 *
 * Depending on the Vercel runtime version, the body can arrive already parsed
 * on `request.body` or as an unread Node stream. Hono's Node adapter consumes
 * `request.rawBody` when present, so normalize both forms before dispatch.
 */
export async function ensureVercelRawBody(request) {
  const method = String(request?.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || Buffer.isBuffer(request?.rawBody)) return;

  if (request?.body !== undefined && request.body !== null) {
    request.rawBody = bodyToBuffer(request.body);
    return;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  request.rawBody = Buffer.concat(chunks);
}

function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(JSON.stringify(body));
}
