/**
 * LinkedIn routes:
 *
 *   POST /api/resume/linkedin
 *   Body: { "url": "https://www.linkedin.com/in/username" }
 *   Attempts to retrieve a LinkedIn public profile page and extract
 *   structured data from JSON-LD and Open Graph meta tags.
 *
 *   POST /api/resume/linkedin/upload
 *   Body: multipart/form-data  field: "file"  (PDF export or data export ZIP)
 *   Parses a LinkedIn PDF profile export or data export ZIP file into
 *   structured ProfileData. Uses pdf-parse for PDFs and a built-in ZIP
 *   parser (node:zlib) for data export ZIPs.
 *
 *   POST /api/linkedin/import
 *   Body: multipart/form-data  field: "file"  (PDF export, data export ZIP, or JSON)
 *   Parses a LinkedIn file export into structured ProfileData organised by
 *   section (experience, education, skills, certifications), then persists the
 *   result to Vercel Blob at resume/linkedin-import.json for use during
 *   resume onboarding.  LinkedIn data is used ONE-SHOT at onboarding only;
 *   subsequent system operations do not re-read this file.
 *
 *   GET /api/linkedin/import
 *   Returns the stored LinkedIn import document, or 404 if not yet imported.
 *
 * Returns (POST /api/linkedin/import):
 *   201 { ok: true, source, data: ProfileData, importedAt, blobUrl }
 *                                                       – stored successfully
 *   200 { ok: false, error: "insufficient_data", message, partialData }
 *                                                       – too sparse, not stored
 *   400 { ok: false, error, message }                   – bad request
 *   415 { ok: false, error: "unsupported_format", message } – wrong file type
 *   500 / 502                                           – server-side error
 *
 * Returns (GET /api/linkedin/import):
 *   200 { ok: true, importedAt, source, data: ProfileData }
 *   404 { ok: false, error: "not_found", message }
 *
 * Returns (POST /api/resume/linkedin and POST /api/resume/linkedin/upload):
 *   200 { ok: true, source, data: ProfileData }         – usable data found
 *   200 { ok: false, error: "insufficient_data", message, partialData }
 *                                                       – too sparse
 *   400 { ok: false, error, message }                   – bad request
 *   415 { ok: false, error: "unsupported_format", message } – wrong file type
 *   500 / 502                                           – server-side error
 *
 * LinkedIn is used ONLY during initial onboarding (one-shot).
 * No external libraries beyond pdf-parse and Node.js built-ins.
 */

import https from "node:https";
import http from "node:http";

import { parseLinkedInFile } from "../lib/linkedinFileParser.mjs";
import { saveLinkedInImport, readLinkedInImport } from "../lib/blob.mjs";

// ─── public API ────────────────────────────────────────────────────────────

/**
 * @param {import("hono").Hono} app
 */
export function registerLinkedInRoutes(app) {
  app.post("/api/resume/linkedin", handleLinkedIn);
  app.post("/api/resume/linkedin/upload", handleLinkedInUpload);
  app.post("/api/linkedin/import", handleLinkedInImport);
  app.get("/api/linkedin/import", handleLinkedInImportGet);
}

// ─── handler ───────────────────────────────────────────────────────────────

/** @param {import("hono").Context} c */
async function handleLinkedIn(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "bad_request", message: "Request body must be JSON" }, 400);
  }

  const rawUrl = (body?.url ?? "").trim();

  const validation = validateLinkedInUrl(rawUrl);
  if (!validation.ok) {
    return c.json({ ok: false, error: "invalid_url", message: validation.message }, 400);
  }

  const normalizedUrl = validation.url;

  let html;
  try {
    html = await fetchPage(normalizedUrl);
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "fetch_failed",
        message: `Could not retrieve LinkedIn page: ${err.message}`,
        hint: "LinkedIn may block unauthenticated requests. Consider uploading your resume PDF instead.",
      },
      502
    );
  }

  const extracted = extractProfileData(html, normalizedUrl);

  if (!extracted.sufficient) {
    return c.json({
      ok: false,
      error: "insufficient_data",
      message:
        "LinkedIn returned too little public data. " +
        "Make sure your profile is set to public, or upload your resume PDF to continue.",
      hint: "If your LinkedIn profile is private, the PDF upload path will give better results.",
      partialData: extracted.data,
    });
  }

  return c.json({ ok: true, source: "linkedin", url: normalizedUrl, data: extracted.data });
}

// ─── Upload handler ──────────────────────────────────────────────────────────

/**
 * POST /api/resume/linkedin/upload
 *
 * Accept a multipart/form-data upload of:
 *   - A LinkedIn Profile PDF export  (.pdf — "Save to PDF" from your profile)
 *   - A LinkedIn Data Export ZIP     (.zip — from Settings → Data Privacy)
 *
 * Field name: "file"
 * Max size: 20 MB
 *
 * On success: 200 { ok: true, source: "linkedin_pdf"|"linkedin_zip", data: ProfileData }
 *
 * @param {import("hono").Context} c
 */
async function handleLinkedInUpload(c) {
  // ── 1. Parse multipart body ──────────────────────────────────────────────
  let body;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json(
      {
        ok: false,
        error: "bad_request",
        message: "multipart/form-data 형식으로 요청해 주세요.",
      },
      400
    );
  }

  // ── 2. Validate the "file" field ─────────────────────────────────────────
  const fileField = body["file"];

  if (!fileField) {
    return c.json(
      {
        ok: false,
        error: "missing_file",
        message: "file 필드가 없습니다. LinkedIn PDF 또는 ZIP 파일을 첨부해 주세요.",
      },
      400
    );
  }

  // Hono's parseBody returns a File-like object for uploaded files.
  if (
    typeof fileField === "string" ||
    !(
      fileField instanceof File ||
      (typeof fileField === "object" && typeof fileField.arrayBuffer === "function")
    )
  ) {
    return c.json(
      {
        ok: false,
        error: "invalid_file",
        message: "file 필드는 파일이어야 합니다.",
      },
      400
    );
  }

  const file = /** @type {File} */ (fileField);

  // ── 3. Size guard (20 MB) ────────────────────────────────────────────────
  const MAX_BYTES = 20 * 1024 * 1024;
  if (file.size && file.size > MAX_BYTES) {
    return c.json(
      {
        ok: false,
        error: "file_too_large",
        message: "파일 크기가 20 MB를 초과합니다.",
      },
      400
    );
  }

  // ── 4. Buffer the file ───────────────────────────────────────────────────
  let buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    console.error("[linkedin/upload] Failed to buffer uploaded file:", err);
    return c.json(
      {
        ok: false,
        error: "read_error",
        message: `파일을 읽을 수 없습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  if (buffer.length === 0) {
    return c.json(
      { ok: false, error: "empty_file", message: "빈 파일입니다." },
      400
    );
  }

  // ── 5. Parse the LinkedIn file ───────────────────────────────────────────
  let result;
  try {
    result = await parseLinkedInFile(buffer, file.name ?? "");
  } catch (err) {
    console.error("[linkedin/upload] parseLinkedInFile threw:", err);
    return c.json(
      {
        ok: false,
        error: "parse_error",
        message: `파일 파싱 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  // ── 6. Map result to HTTP response ───────────────────────────────────────
  if (result.source === "unsupported" || result.source === "unknown") {
    return c.json(
      {
        ok: false,
        error: "unsupported_format",
        message:
          result.error ??
          "지원하지 않는 파일 형식입니다. LinkedIn PDF 내보내기 또는 데이터 내보내기(.zip)를 업로드해 주세요.",
      },
      415
    );
  }

  if (!result.ok) {
    // Parsed but not enough data to proceed.
    return c.json({
      ok: false,
      error: "insufficient_data",
      message:
        result.error ??
        "파일에서 충분한 LinkedIn 데이터를 추출할 수 없었습니다. " +
          "프로필 공개 범위를 확인하거나 직접 이력서 PDF를 업로드해 주세요.",
      hint:
        result.source === "linkedin_pdf"
          ? "LinkedIn 프로필 PDF 대신 '데이터 내보내기'(.zip)를 시도해 보세요."
          : "LinkedIn Settings → Data Privacy → Get a copy of your data에서 ZIP 파일을 받으세요.",
      partialData: result.data,
    });
  }

  console.info(
    `[linkedin/upload] Parsed LinkedIn file` +
      ` source="${result.source}"` +
      ` name="${result.data.name ?? "(unknown)"}"` +
      ` exp=${result.data.experience.length}` +
      ` edu=${result.data.education.length}` +
      ` skills=${result.data.skills.length}` +
      ` certs=${result.data.certifications?.length ?? 0}`
  );

  return c.json({
    ok: true,
    source: result.source,
    data: result.data,
  });
}

// ─── /api/linkedin/import handlers ──────────────────────────────────────────

/**
 * POST /api/linkedin/import
 *
 * Accept a multipart/form-data upload of a LinkedIn export file:
 *   - LinkedIn Profile PDF  (.pdf — "Save to PDF" from your profile)
 *   - LinkedIn Data Export ZIP (.zip — from Settings → Data Privacy)
 *   - Pre-processed JSON export (.json — manually exported profile data)
 *
 * On success: parses the file into structured ProfileData sections and
 * persists the result to Vercel Blob at resume/linkedin-import.json.
 *
 * Field name: "file"
 * Max size: 20 MB
 *
 * On success:
 *   201 { ok: true, source, data: ProfileData, importedAt, blobUrl }
 *
 * @param {import("hono").Context} c
 */
async function handleLinkedInImport(c) {
  // ── 1. Parse multipart body ──────────────────────────────────────────────
  let body;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json(
      {
        ok: false,
        error: "bad_request",
        message: "multipart/form-data 형식으로 요청해 주세요.",
      },
      400
    );
  }

  // ── 2. Validate the "file" field ─────────────────────────────────────────
  const fileField = body["file"];

  if (!fileField) {
    return c.json(
      {
        ok: false,
        error: "missing_file",
        message: "file 필드가 없습니다. LinkedIn PDF, ZIP 또는 JSON 파일을 첨부해 주세요.",
      },
      400
    );
  }

  if (
    typeof fileField === "string" ||
    !(
      fileField instanceof File ||
      (typeof fileField === "object" && typeof fileField.arrayBuffer === "function")
    )
  ) {
    return c.json(
      {
        ok: false,
        error: "invalid_file",
        message: "file 필드는 파일이어야 합니다.",
      },
      400
    );
  }

  const file = /** @type {File} */ (fileField);

  // ── 3. Size guard (20 MB) ────────────────────────────────────────────────
  const MAX_BYTES = 20 * 1024 * 1024;
  if (file.size && file.size > MAX_BYTES) {
    return c.json(
      {
        ok: false,
        error: "file_too_large",
        message: "파일 크기가 20 MB를 초과합니다.",
      },
      400
    );
  }

  // ── 4. Buffer the file ───────────────────────────────────────────────────
  let buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    console.error("[linkedin/import] Failed to buffer uploaded file:", err);
    return c.json(
      {
        ok: false,
        error: "read_error",
        message: `파일을 읽을 수 없습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  if (buffer.length === 0) {
    return c.json(
      { ok: false, error: "empty_file", message: "빈 파일입니다." },
      400
    );
  }

  // ── 5. Handle JSON export format ─────────────────────────────────────────
  // If the file appears to be a JSON file (by magic byte '{' or by extension),
  // attempt to parse it directly as a ProfileData object.
  const filename = file.name ?? "";
  const isJsonFile =
    filename.toLowerCase().endsWith(".json") ||
    (buffer[0] === 0x7b /* '{' */ && !isPdfBuffer(buffer) && !isZipBuffer(buffer));

  if (isJsonFile) {
    return handleLinkedInJsonImport(c, buffer, filename);
  }

  // ── 6. Parse the LinkedIn PDF or ZIP file ────────────────────────────────
  let result;
  try {
    result = await parseLinkedInFile(buffer, filename);
  } catch (err) {
    console.error("[linkedin/import] parseLinkedInFile threw:", err);
    return c.json(
      {
        ok: false,
        error: "parse_error",
        message: `파일 파싱 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  // ── 7. Map parse result to response ─────────────────────────────────────
  if (result.source === "unsupported" || result.source === "unknown") {
    return c.json(
      {
        ok: false,
        error: "unsupported_format",
        message:
          result.error ??
          "지원하지 않는 파일 형식입니다. LinkedIn PDF 내보내기, 데이터 내보내기(.zip) 또는 JSON 파일을 업로드해 주세요.",
      },
      415
    );
  }

  if (!result.ok) {
    // Parsed but insufficient data — do NOT store.
    return c.json({
      ok: false,
      error: "insufficient_data",
      message:
        result.error ??
        "파일에서 충분한 LinkedIn 데이터를 추출할 수 없었습니다. " +
          "프로필 공개 범위를 확인하거나 다른 내보내기 방식을 시도해 주세요.",
      hint:
        result.source === "linkedin_pdf"
          ? "LinkedIn 프로필 PDF 대신 '데이터 내보내기'(.zip)를 시도해 보세요."
          : "LinkedIn Settings → Data Privacy → Get a copy of your data에서 ZIP 파일을 받으세요.",
      partialData: result.data,
    });
  }

  // ── 8. Persist to Vercel Blob ────────────────────────────────────────────
  let blobResult;
  try {
    blobResult = await saveLinkedInImport(result.data, result.source);
  } catch (err) {
    console.error("[linkedin/import] saveLinkedInImport failed:", err);
    return c.json(
      {
        ok: false,
        error: "storage_error",
        message: `LinkedIn 데이터 저장 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  const importedAt = new Date().toISOString();

  console.info(
    `[linkedin/import] Stored LinkedIn import` +
      ` source="${result.source}"` +
      ` name="${result.data.name ?? "(unknown)"}"` +
      ` exp=${result.data.experience.length}` +
      ` edu=${result.data.education.length}` +
      ` skills=${result.data.skills.length}` +
      ` certs=${result.data.certifications?.length ?? 0}`
  );

  return c.json(
    {
      ok: true,
      source: result.source,
      importedAt,
      blobUrl: blobResult.url,
      data: result.data,
    },
    201
  );
}

/**
 * Handle a raw JSON export upload for POST /api/linkedin/import.
 *
 * The JSON must conform to the ProfileData shape (at minimum: `name` and one
 * of `experience`, `education`, or `skills` must be non-empty).
 *
 * @param {import("hono").Context} c
 * @param {Buffer} buffer
 * @param {string} filename
 */
async function handleLinkedInJsonImport(c, buffer, filename) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "parse_error",
        message: `JSON 파일 파싱 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      400
    );
  }

  // Normalise to ProfileData shape with safe defaults.
  /** @type {import("../lib/linkedinFileParser.mjs").ProfileData} */
  const data = {
    name: typeof parsed.name === "string" ? parsed.name.trim() || null : null,
    headline: typeof parsed.headline === "string" ? parsed.headline.trim() || null : null,
    about: typeof parsed.about === "string" ? parsed.about.trim() || null : null,
    location: typeof parsed.location === "string" ? parsed.location.trim() || null : null,
    profileImageUrl:
      typeof parsed.profileImageUrl === "string" ? parsed.profileImageUrl.trim() || null : null,
    experience: Array.isArray(parsed.experience) ? parsed.experience : [],
    education: Array.isArray(parsed.education) ? parsed.education : [],
    skills: Array.isArray(parsed.skills)
      ? parsed.skills.filter((s) => typeof s === "string")
      : [],
    certifications: Array.isArray(parsed.certifications) ? parsed.certifications : [],
  };

  // Sufficiency check — same criteria as the PDF/ZIP path.
  const sufficient = Boolean(
    data.name && (data.headline || data.about || data.experience.length > 0)
  );

  if (!sufficient) {
    return c.json({
      ok: false,
      error: "insufficient_data",
      message:
        "JSON 파일에서 충분한 LinkedIn 데이터를 추출할 수 없었습니다. " +
        "name 필드와 experience, headline, 또는 about 중 하나 이상이 필요합니다.",
      partialData: data,
    });
  }

  // Persist to Vercel Blob.
  let blobResult;
  try {
    blobResult = await saveLinkedInImport(data, "linkedin_json");
  } catch (err) {
    console.error("[linkedin/import] saveLinkedInImport (json) failed:", err);
    return c.json(
      {
        ok: false,
        error: "storage_error",
        message: `LinkedIn JSON 데이터 저장 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  const importedAt = new Date().toISOString();

  console.info(
    `[linkedin/import] Stored LinkedIn JSON import` +
      ` name="${data.name ?? "(unknown)"}"` +
      ` exp=${data.experience.length}` +
      ` edu=${data.education.length}` +
      ` skills=${data.skills.length}`
  );

  return c.json(
    {
      ok: true,
      source: "linkedin_json",
      importedAt,
      blobUrl: blobResult.url,
      data,
    },
    201
  );
}

/**
 * GET /api/linkedin/import
 *
 * Returns the stored LinkedIn import document, or 404 when not yet imported.
 *
 * Response:
 *   200 { ok: true, importedAt, source, data: ProfileData }
 *   404 { ok: false, error: "not_found", message }
 *
 * @param {import("hono").Context} c
 */
async function handleLinkedInImportGet(c) {
  let doc;
  try {
    doc = await readLinkedInImport();
  } catch (err) {
    console.error("[linkedin/import GET] readLinkedInImport failed:", err);
    return c.json(
      {
        ok: false,
        error: "storage_error",
        message: `LinkedIn 임포트 데이터를 읽는 중 오류가 발생했습니다: ${err.message ?? String(err)}`,
      },
      500
    );
  }

  if (!doc) {
    return c.json(
      {
        ok: false,
        error: "not_found",
        message: "LinkedIn 임포트 데이터가 없습니다. 먼저 LinkedIn 파일을 업로드해 주세요.",
      },
      404
    );
  }

  return c.json({
    ok: true,
    importedAt: doc.importedAt,
    source: doc.source,
    data: doc.data,
  });
}

// ─── Buffer type helpers ─────────────────────────────────────────────────────

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isPdfBuffer(buf) {
  return buf.length >= 5 && buf.slice(0, 5).toString("ascii") === "%PDF-";
}

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isZipBuffer(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

// ─── URL validation ─────────────────────────────────────────────────────────

/**
 * Validates that the provided string is a LinkedIn public profile URL.
 *
 * Accepted forms:
 *   https://www.linkedin.com/in/<slug>
 *   https://linkedin.com/in/<slug>
 *   http://...  (normalised to https)
 *
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
function validateLinkedInUrl(raw) {
  if (!raw) {
    return { ok: false, message: "url is required" };
  }

  let parsed;
  try {
    // Normalise http → https
    const withScheme = raw.startsWith("http://")
      ? raw.replace("http://", "https://")
      : raw.startsWith("https://")
      ? raw
      : `https://${raw}`;
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, message: `"${raw}" is not a valid URL` };
  }

  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "linkedin.com") {
    return { ok: false, message: "URL must be a linkedin.com profile link" };
  }

  if (!parsed.pathname.startsWith("/in/")) {
    return {
      ok: false,
      message:
        'URL must be a personal profile link (path must start with "/in/"). ' +
        "Company and job pages are not supported.",
    };
  }

  // Strip query-string / fragment for a clean canonical URL
  const clean = `https://www.linkedin.com${parsed.pathname.replace(/\/$/, "")}`;
  return { ok: true, url: clean };
}

// ─── HTTP fetch ─────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches a URL and returns the response body as a string.
 * Only follows a single redirect. Throws on network errors or HTTP ≥ 400.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        // Mimic a real browser request to maximise public data returned
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity", // avoid gzip so we can read the body directly
        "Cache-Control": "no-cache",
      },
    };

    const req = mod.request(options, (res) => {
      // Handle redirect (301/302/307/308)
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        fetchPage(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }

      if (res.statusCode >= 400) {
        res.resume();
        const msg =
          res.statusCode === 999
            ? "LinkedIn blocked the request (HTTP 999). Profile data unavailable without authentication."
            : res.statusCode === 401 || res.statusCode === 403
            ? `LinkedIn requires authentication (HTTP ${res.statusCode}). Public profile data is unavailable.`
            : `HTTP ${res.statusCode} from LinkedIn`;
        reject(new Error(msg));
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        // Safety limit – LinkedIn pages can be large; 2 MB is plenty for meta
        if (body.length > 2_000_000) res.destroy();
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    });

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`));
    });

    req.on("error", reject);
    req.end();
  });
}

// ─── HTML parsing ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProfileData
 * @property {string|null} name
 * @property {string|null} headline
 * @property {string|null} about
 * @property {string|null} location
 * @property {string|null} profileImageUrl
 * @property {ExperienceEntry[]} experience
 * @property {EducationEntry[]} education
 * @property {string[]} skills
 */

/**
 * @typedef {Object} ExperienceEntry
 * @property {string} title
 * @property {string|null} company
 * @property {string|null} duration
 * @property {string|null} description
 */

/**
 * @typedef {Object} EducationEntry
 * @property {string} school
 * @property {string|null} degree
 * @property {string|null} field
 * @property {string|null} years
 */

/**
 * Attempts to extract structured profile data from a LinkedIn HTML page.
 * Uses JSON-LD (preferred) then Open Graph / meta tags as fallbacks.
 *
 * @param {string} html
 * @param {string} url
 * @returns {{ sufficient: boolean, data: ProfileData }}
 */
function extractProfileData(html, url) {
  const data = /** @type {ProfileData} */ ({
    name: null,
    headline: null,
    about: null,
    location: null,
    profileImageUrl: null,
    experience: [],
    education: [],
    skills: [],
  });

  // 1. JSON-LD – LinkedIn sometimes embeds schema.org/Person data
  tryExtractJsonLd(html, data);

  // 2. Open Graph + Twitter Card meta tags
  tryExtractMetaTags(html, data);

  // 3. Page title as last-resort name extraction
  if (!data.name) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      // LinkedIn title format: "Name - Headline | LinkedIn"
      const raw = decodeHtmlEntities(titleMatch[1]);
      const parts = raw.split(" - ");
      if (parts.length >= 2 && !raw.toLowerCase().includes("sign in")) {
        data.name = parts[0].trim();
        if (!data.headline) {
          const headlinePart = parts.slice(1).join(" - ").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
          if (headlinePart) data.headline = headlinePart;
        }
      }
    }
  }

  // 4. Determine whether we have enough data to be useful
  const sufficient = Boolean(data.name && (data.headline || data.about));

  return { sufficient, data };
}

/**
 * Looks for `<script type="application/ld+json">` blocks and extracts
 * Person schema data.
 *
 * @param {string} html
 * @param {ProfileData} data – mutated in place
 */
function tryExtractJsonLd(html, data) {
  const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }

    // May be an array or a single object
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item["@type"] === "Person" || item["@type"] === "ProfilePage") {
        const person = item["@type"] === "ProfilePage" ? item.mainEntity ?? item : item;

        if (!data.name && person.name) data.name = String(person.name).trim();
        if (!data.headline && person.jobTitle) data.headline = String(person.jobTitle).trim();
        if (!data.about && person.description)
          data.about = String(person.description).trim();
        if (!data.location && person.address?.addressLocality)
          data.location = String(person.address.addressLocality).trim();
        if (!data.profileImageUrl && person.image?.url)
          data.profileImageUrl = String(person.image.url);

        // Experience from worksFor / hasOccupation
        const works = toArray(person.worksFor ?? person.hasOccupation);
        for (const w of works) {
          if (w.name) {
            data.experience.push({
              title: String(w.name).trim(),
              company: w.organizationName ? String(w.organizationName).trim() : null,
              duration: null,
              description: w.description ? String(w.description).trim() : null,
            });
          }
        }

        // Education
        const edu = toArray(person.alumniOf);
        for (const e of edu) {
          if (e.name) {
            data.education.push({
              school: String(e.name).trim(),
              degree: e.roleName ? String(e.roleName).trim() : null,
              field: null,
              years: null,
            });
          }
        }

        // Skills
        const skills = toArray(person.knowsAbout ?? person.skills);
        for (const s of skills) {
          const label = typeof s === "string" ? s : s.name;
          if (label) data.skills.push(String(label).trim());
        }
      }
    }
  }
}

/**
 * Extracts data from Open Graph and Twitter Card meta tags.
 * These are typically visible even on public-profile pages returned to bots.
 *
 * @param {string} html
 * @param {ProfileData} data – mutated in place
 */
function tryExtractMetaTags(html, data) {
  const metaPattern = /<meta[^>]+>/gi;
  let match;
  while ((match = metaPattern.exec(html)) !== null) {
    const tag = match[0];

    const prop = extractAttr(tag, "property") ?? extractAttr(tag, "name");
    const content = extractAttr(tag, "content");
    if (!prop || !content) continue;

    const val = decodeHtmlEntities(content).trim();
    if (!val) continue;

    switch (prop.toLowerCase()) {
      case "og:title":
      case "twitter:title": {
        if (!data.name) {
          // "Name – Headline" or just "Name | LinkedIn"
          const clean = val.replace(/\s*\|\s*linkedin.*$/i, "").trim();
          const dashIdx = clean.search(/ [–—-] /);
          if (dashIdx !== -1) {
            data.name = clean.slice(0, dashIdx).trim();
            if (!data.headline) data.headline = clean.slice(dashIdx).replace(/^[\s–—-]+/, "").trim();
          } else {
            data.name = clean;
          }
        }
        break;
      }
      case "og:description":
      case "twitter:description": {
        if (!data.about) data.about = val;
        break;
      }
      case "og:image":
      case "twitter:image": {
        if (!data.profileImageUrl) data.profileImageUrl = val;
        break;
      }
      case "profile:first_name": {
        // Not always present; helps confirm name if og:title is ambiguous
        break;
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts the value of an HTML attribute from a tag string.
 * e.g. extractAttr('<meta content="foo">', "content") → "foo"
 *
 * @param {string} tag
 * @param {string} attr
 * @returns {string|null}
 */
function extractAttr(tag, attr) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*?)"|'([^']*?)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Decodes common HTML entities.
 *
 * @param {string} s
 * @returns {string}
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/**
 * Coerces a value to an array; returns [] for null/undefined.
 *
 * @param {unknown} val
 * @returns {unknown[]}
 */
function toArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}
