/** Durable, fail-closed idempotency guard for the production collection cron. */

import { get, put } from "./meteredBlob.mjs";
import { sanitizeUserId } from "./authUsers.mjs";

const COLLECTION_LEASE_PREFIX = "worklog/leases/collect/";

export async function claimCollectionLease({ userId = "default", date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) {
    throw new TypeError("Collection lease date must use YYYY-MM-DD");
  }

  const scopedUser = sanitizeUserId(userId);
  const pathname = `${COLLECTION_LEASE_PREFIX}${date}/${scopedUser}.json`;
  const marker = JSON.stringify({ schemaVersion: 1, date, acquiredAt: new Date().toISOString() });

  try {
    await put(pathname, marker, {
      access: "private",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { acquired: true };
  } catch (error) {
    // The SDK documents no-overwrite semantics but not one stable error class
    // for pathname collisions. Confirm the marker with an origin-consistent
    // read; only observed durable state is accepted as a duplicate.
    try {
      const existing = await get(pathname, {
        access: "private",
        useCache: false,
        ...(process.env.BLOB_READ_WRITE_TOKEN
          ? { token: process.env.BLOB_READ_WRITE_TOKEN }
          : {}),
      });
      if (existing) {
        await existing.stream?.cancel?.().catch?.(() => {});
        return { acquired: false, reason: "already_collected" };
      }
    } catch {
      // Preserve the original create failure below. Lease acquisition must be
      // fail-closed whenever the provider state cannot be confirmed.
    }
    throw error;
  }
}
