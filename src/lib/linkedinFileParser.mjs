/**
 * LinkedIn file parser for the work-log Living Resume system.
 *
 * Accepts two LinkedIn export formats and returns structured ProfileData:
 *
 *   1. LinkedIn Profile PDF  (.pdf)
 *      Downloaded from your LinkedIn profile via the "Save to PDF" button.
 *      Text is extracted via pdf-parse and parsed heuristically using
 *      LinkedIn's known PDF layout (English and Korean).
 *
 *   2. LinkedIn Data Export  (.zip)
 *      Downloaded from Settings → Data Privacy → Get a copy of your data.
 *      The ZIP is parsed with Node.js built-in zlib (no external library).
 *      Extracts: Profile.csv, Positions.csv, Education.csv, Skills.csv,
 *      Certifications.csv.
 *
 * Returns a ProfileData object compatible with the existing
 * POST /api/resume/linkedin URL-fetch endpoint, extended with a
 * `certifications` array.
 *
 * Dependencies: pdf-parse (project dep), node:zlib, node:util (built-ins).
 */

import zlib from "node:zlib";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const inflateRaw = promisify(zlib.inflateRaw);

// ─── Types (JSDoc) ───────────────────────────────────────────────────────────

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
 * @property {CertificationEntry[]} certifications  — extension (not in URL-fetch ProfileData)
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
 * @typedef {Object} CertificationEntry
 * @property {string} name
 * @property {string|null} issuer
 * @property {string|null} date
 */

/**
 * @typedef {Object} ParseResult
 * @property {boolean}      ok       Whether sufficient data was extracted.
 * @property {string}       source   "linkedin_pdf" | "linkedin_zip" | "unsupported"
 * @property {ProfileData}  data
 * @property {string}       [error]  Human-readable error message (Korean).
 */

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Dispatch to the appropriate parser based on magic bytes.
 *
 * @param {Buffer} buffer    File content.
 * @param {string} filename  Original file name (used as a secondary hint).
 * @returns {Promise<ParseResult>}
 */
export async function parseLinkedInFile(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, source: "unknown", data: emptyProfile(), error: "빈 파일입니다." };
  }

  // Detect by magic bytes — more reliable than MIME type or extension.
  const isPdf = buffer.length >= 5 && buffer.slice(0, 5).toString("ascii") === "%PDF-";
  // ZIP magic: PK\x03\x04 (local file header) at the start
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;

  if (isPdf) {
    try {
      const data = await parseLinkedInPdf(buffer);
      const sufficient = Boolean(
        data.name && (data.headline || data.about || data.experience.length > 0)
      );
      return { ok: sufficient, source: "linkedin_pdf", data };
    } catch (err) {
      return {
        ok: false,
        source: "linkedin_pdf",
        data: emptyProfile(),
        error: `PDF 파싱 오류: ${err.message}`,
      };
    }
  }

  if (isZip) {
    try {
      const data = await parseLinkedInZip(buffer);
      const sufficient = Boolean(
        data.name || data.experience.length > 0 || data.skills.length > 0
      );
      return { ok: sufficient, source: "linkedin_zip", data };
    } catch (err) {
      return {
        ok: false,
        source: "linkedin_zip",
        data: emptyProfile(),
        error: `ZIP 파싱 오류: ${err.message}`,
      };
    }
  }

  const ext = (filename || "").toLowerCase().split(".").pop() || "unknown";
  return {
    ok: false,
    source: "unsupported",
    data: emptyProfile(),
    error:
      `지원하지 않는 파일 형식입니다 (.${ext}). ` +
      "LinkedIn PDF 내보내기(.pdf) 또는 데이터 내보내기(.zip)를 업로드해 주세요.",
  };
}

// ─── PDF Parser ──────────────────────────────────────────────────────────────

/**
 * Extract text from a LinkedIn Profile PDF using pdf-parse, then parse
 * the structured sections from the text output.
 *
 * @param {Buffer} buffer
 * @returns {Promise<ProfileData>}
 */
async function parseLinkedInPdf(buffer) {
  const pdfParseModule = _require("pdf-parse");

  if (typeof pdfParseModule === "function") {
    const result = await pdfParseModule(buffer);
    return extractFromLinkedInPdfText(result.text || "");
  }

  if (typeof pdfParseModule?.default === "function") {
    const result = await pdfParseModule.default(buffer);
    return extractFromLinkedInPdfText(result.text || "");
  }

  if (typeof pdfParseModule?.PDFParse === "function") {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return extractFromLinkedInPdfText(result?.text || "");
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  throw new Error("Unsupported pdf-parse module shape");
}

/**
 * Parse LinkedIn PDF text into structured ProfileData.
 *
 * LinkedIn's PDF layout:
 *   1. Name (first non-contact line)
 *   2. Headline / current position
 *   3. Contact line(s): location | email | phone | LinkedIn URL
 *   4. Named sections: Summary, Experience, Education, Skills,
 *      Licenses & Certifications, Languages, etc.
 *
 * Exported for unit testing. Not intended for external callers — use
 * parseLinkedInFile() instead.
 *
 * @param {string} rawText
 * @returns {ProfileData}
 */
export function extractFromLinkedInPdfText(rawText) {
  const profile = emptyProfile();

  // Normalise: trim each line, drop truly blank lines.
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return profile;

  // ── 1. Find all section boundaries ─────────────────────────────────────────
  /** @type {{ type: string, idx: number }[]} */
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const type = detectSectionHeader(lines[i]);
    if (type) sections.push({ type, idx: i });
  }

  // ── 2. Parse header block (before first section) ────────────────────────────
  const firstSectionIdx = sections.length > 0 ? sections[0].idx : lines.length;
  extractPdfHeaderInfo(lines.slice(0, firstSectionIdx), profile);

  // ── 3. Parse each section ───────────────────────────────────────────────────
  for (let si = 0; si < sections.length; si++) {
    const { type, idx } = sections[si];
    const endIdx = si + 1 < sections.length ? sections[si + 1].idx : lines.length;
    const sectionLines = lines.slice(idx + 1, endIdx);

    switch (type) {
      case "summary":
        profile.about = sectionLines.join(" ").trim() || null;
        break;
      case "experience":
        profile.experience = parseExperiencePdfSection(sectionLines);
        break;
      case "education":
        profile.education = parseEducationPdfSection(sectionLines);
        break;
      case "skills":
        profile.skills = parseSkillsPdfSection(sectionLines);
        break;
      case "certifications":
        profile.certifications = parseCertificationsPdfSection(sectionLines);
        break;
      // "languages" and others are intentionally ignored (not in ProfileData schema)
    }
  }

  return profile;
}

/**
 * Extract name, headline, and location from the PDF header block
 * (all lines before the first named section).
 *
 * @param {string[]} lines
 * @param {ProfileData} profile  Mutated in place.
 */
function extractPdfHeaderInfo(lines, profile) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Name: first line that isn't contact info.
    if (!profile.name && !isContactLine(line) && line.length >= 2) {
      profile.name = line;
      continue;
    }

    // Headline: first meaningful non-contact, non-location line after name.
    // Checked BEFORE location so that "Senior Software Engineer" (no comma)
    // is captured as headline rather than mistakenly treated as a location.
    if (
      profile.name &&
      !profile.headline &&
      !isContactLine(line) &&
      !looksLikeLocation(line) &&
      line.length > 5
    ) {
      profile.headline = line;
      continue;
    }

    // Location: standalone "City, Country" line.
    if (profile.name && !profile.location && looksLikeLocation(line)) {
      // Line may contain "City, Country | email | phone"; take the location part.
      profile.location = extractLocationFromLine(line);
      continue;
    }

    // Location embedded in a combined contact line:
    //   "Seoul, South Korea | jane@example.com | +82-10-1234-5678"
    // The first pipe-segment often holds the location in LinkedIn PDFs.
    if (profile.name && !profile.location && isContactLine(line)) {
      const firstSeg = line.split("|")[0].trim();
      if (
        firstSeg.includes(",") &&
        !firstSeg.includes("@") &&
        !/^(https?:\/\/|www\.)/i.test(firstSeg)
      ) {
        profile.location = firstSeg;
      }
    }
  }
}

// ── Section header detection ──────────────────────────────────────────────────

/**
 * Detect whether a line is a LinkedIn section header.
 * Handles English and Korean.
 *
 * @param {string} line
 * @returns {string|null}  Section type key, or null.
 */
function detectSectionHeader(line) {
  const t = line.trim();

  // ── English ──
  if (/^(summary|about|professional summary)$/i.test(t)) return "summary";
  if (
    /^(experience|work experience|professional experience|employment history)$/i.test(t)
  )
    return "experience";
  if (/^(education|educational background|education and training)$/i.test(t))
    return "education";
  if (/^(skills|top skills|technical skills|core competencies)$/i.test(t))
    return "skills";
  if (
    /^(licenses\s*&\s*certifications?|licenses?\s+and\s+certifications?|certifications?|certificates?)$/i.test(
      t
    )
  )
    return "certifications";
  if (/^languages$/i.test(t)) return "languages";

  // ── Korean ──
  if (/^(요약|자기소개|소개|프로필 요약)$/.test(t)) return "summary";
  if (/^(경력|경력사항|경험|직장 경력|업무 경력|경력 및 업무)$/.test(t)) return "experience";
  if (/^(학력|학력사항|교육|학업|교육 및 훈련)$/.test(t)) return "education";
  if (/^(스킬|기술|역량|핵심 역량|기술 스택)$/.test(t)) return "skills";
  if (/^(자격증|자격|면허|라이선스|인증|라이선스 및 자격증)$/.test(t)) return "certifications";
  if (/^(언어|외국어)$/.test(t)) return "languages";

  return null;
}

// ── Line-type helpers ─────────────────────────────────────────────────────────

/** Return true if a line looks like a contact info line (email, phone, URL). */
function isContactLine(line) {
  return (
    line.includes("@") ||
    /^\+?\d[\d\s\-().+]{5,}$/.test(line) ||
    /^(https?:\/\/|www\.)/i.test(line) ||
    /linkedin\.com/i.test(line) ||
    // A line with multiple "|" separators is typically a contact aggregate.
    (line.split("|").length > 2 && line.length < 250)
  );
}

/** Return true if a line looks like a city / location string. */
function looksLikeLocation(line) {
  if (line.length > 120) return false;
  if (isContactLine(line)) return false;
  if (/^\+?\d/.test(line)) return false;
  // "City, Country" or "City, State" pattern — require a comma.
  // The former "short title-case line" heuristic was intentionally removed
  // because it incorrectly classified job titles (e.g. "Senior Software Engineer")
  // as locations.  A comma is the reliable discriminator in LinkedIn PDFs.
  if (line.includes(",")) return true;
  return false;
}

/**
 * Pull the location segment out of a combined contact line like
 * "Seoul, Korea | john@example.com | +82-10-...".
 */
function extractLocationFromLine(line) {
  const parts = line.split("|").map((p) => p.trim());
  for (const part of parts) {
    if (!isContactLine(part) && looksLikeLocation(part)) return part;
  }
  return line.trim();
}

// ── Experience section parser ─────────────────────────────────────────────────

/**
 * Parse the Experience section from PDF lines.
 *
 * LinkedIn experience layout:
 *   Title
 *   Company Name · Employment Type (e.g. "Full-time")
 *   Date range · Duration  (e.g. "Jan 2020 – Present · 4 yrs 3 mos")
 *   [Location]
 *   [Description or bullet lines]
 *
 * @param {string[]} lines
 * @returns {ExperienceEntry[]}
 */
function parseExperiencePdfSection(lines) {
  /** @type {Array<ExperienceEntry & { _phase: string }>} */
  const entries = [];
  let current = null;
  let descBuf = [];

  function flush() {
    if (!current) return;
    current.description = descBuf.join(" ").trim() || null;
    const { _phase, ...entry } = current; // eslint-disable-line no-unused-vars
    entries.push(entry);
    current = null;
    descBuf = [];
  }

  for (const line of lines) {
    if (isDateRangeLine(line)) {
      if (current) {
        // Extract the date part (drop the "· X yrs Y mos" suffix)
        current.duration = line.replace(/\s*·\s*[\d\w\s]+$/, "").trim();
        current._phase = "post_date";
      }
      continue;
    }

    // Company line: "Company Name · Full-time" or just "Company Name"
    if (current && current._phase === "title" && !current.company) {
      current.company = line.split(" · ")[0].trim();
      current._phase = "company";
      continue;
    }

    // Location line (short, after date)
    if (current && current._phase === "post_date" && looksLikeLocation(line)) {
      current._phase = "post_location";
      continue; // skip location — not in ExperienceEntry schema
    }

    // Description / bullet lines (after company has been set).
    //
    // Once a date range has been recorded (current.duration is set), we
    // distinguish between description bullets and the next entry's title:
    //   • Lines that start with a bullet marker     → description content
    //   • Non-bullet lines after a date range seen   → new entry title
    //
    // This relies on LinkedIn's convention of using bullet markers (•, ·, ▪ …)
    // for description items in the PDF export.  Plain-paragraph descriptions
    // without bullet markers are uncommon in LinkedIn's "Save to PDF" output.
    if (current && current.company) {
      const isBullet = /^[•·‣▪▸▹►◆◈]/.test(line);

      if (current.duration && !isBullet) {
        // Non-bullet line after date-range → start of the next experience entry.
        flush();
        current = {
          title: line,
          company: null,
          duration: null,
          description: null,
          _phase: "title",
        };
        continue;
      }

      descBuf.push(line.replace(/^[•·‣▪▸▹►◆◈]\s*/, "").trim());
      continue;
    }

    // New entry — this line is the job title.
    flush();
    current = {
      title: line,
      company: null,
      duration: null,
      description: null,
      _phase: "title",
    };
  }

  flush();
  return entries;
}

/**
 * Return true if a line is a LinkedIn date-range line.
 *
 * English examples: "Jan 2020 – Present · 4 yrs 3 mos", "2018 – 2022"
 * Korean examples:  "2019년 3월 – 현재", "2020년 1월 – 2023년 12월"
 */
function isDateRangeLine(line) {
  if (
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b.*[–—-]/i.test(line)
  )
    return true;
  if (/^\d{4}\s*[–—-]\s*(\d{4}|present|현재)$/i.test(line)) return true;
  if (/\d{4}년.*[–—-]/.test(line)) return true;
  return false;
}

// ── Education section parser ──────────────────────────────────────────────────

/**
 * Parse the Education section from PDF lines.
 *
 * LinkedIn education layout:
 *   School Name
 *   Degree Name, Field of Study  (comma-separated, or "Degree Name" only)
 *   Date range
 *   [Activities, Grade, etc. — ignored]
 *
 * @param {string[]} lines
 * @returns {EducationEntry[]}
 */
function parseEducationPdfSection(lines) {
  const entries = [];
  let current = null;

  function flush() {
    if (current) entries.push(current);
    current = null;
  }

  for (const line of lines) {
    if (isDateRangeLine(line)) {
      if (current) current.years = line.replace(/\s*·.*$/, "").trim();
      continue;
    }

    // Skip common ancillary lines.
    if (/^(activities|grade|gpa|score|성적|학점|활동)/i.test(line)) continue;

    // Degree line: contains a degree keyword or follows school+comma pattern.
    if (
      current &&
      !current.degree &&
      /\b(bachelor|master|phd|doctor|associate|diploma|certificate|학사|석사|박사|전문학사|학위|degree|b\.s|m\.s|b\.a|m\.a)\b/i.test(
        line
      )
    ) {
      const parts = line.split(",").map((p) => p.trim());
      current.degree = parts[0] || null;
      current.field = parts[1] || null;
      continue;
    }

    // Comma-separated "Degree, Field" when no keyword matched.
    if (current && !current.degree && line.includes(",")) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length === 2 && parts[0].length < 80 && parts[1].length < 80) {
        current.degree = parts[0];
        current.field = parts[1];
        continue;
      }
    }

    // New school entry.
    flush();
    current = { school: line, degree: null, field: null, years: null };
  }

  flush();
  return entries;
}

// ── Skills section parser ─────────────────────────────────────────────────────

/**
 * Parse Skills section.
 * LinkedIn PDFs list skills either comma-separated or one per line (bullet).
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function parseSkillsPdfSection(lines) {
  const skills = new Set();

  for (const line of lines) {
    // Skip proficiency labels that appear in the Languages section (just in case).
    if (
      /^(native|bilingual|full professional|elementary|limited working|professional working|기본|업무|원어민|이중언어)/i.test(
        line
      )
    )
      continue;

    if (line.includes(",")) {
      for (const part of line.split(",")) {
        const s = part.replace(/^[•·‣▪▸▹►◆◈]\s*/, "").trim();
        if (s && s.length < 80) skills.add(s);
      }
    } else {
      const s = line.replace(/^[•·‣▪▸▹►◆◈]\s*/, "").trim();
      if (s && s.length < 80) skills.add(s);
    }
  }

  return [...skills];
}

// ── Certifications section parser ─────────────────────────────────────────────

/**
 * Parse Certifications/Licenses section.
 *
 * LinkedIn certifications layout:
 *   Certificate Name
 *   Issuer · Credential ID: XXX  (or just "Issuer")
 *   Issued Month Year · Expires Month Year
 *
 * @param {string[]} lines
 * @returns {CertificationEntry[]}
 */
function parseCertificationsPdfSection(lines) {
  const certs = [];
  let current = null;

  function flush() {
    if (current && current.name) certs.push(current);
    current = null;
  }

  for (const line of lines) {
    // Date / expiry line
    if (
      isDateRangeLine(line) ||
      /^(issued|expires|발급일|만료일)/i.test(line)
    ) {
      if (current) {
        current.date = line
          .replace(/\s*·.*$/, "")
          .replace(/^(issued\s*|발급일\s*:?\s*)/i, "")
          .trim();
      }
      continue;
    }

    // Issuer line: follows cert name, often contains " · " separator
    if (current && !current.issuer && line.includes(" · ")) {
      current.issuer = line.split(" · ")[0].trim();
      continue;
    }

    // Skip "Credential ID: ..." lines
    if (/^credential id/i.test(line)) continue;

    // New certification entry.
    flush();
    current = { name: line, issuer: null, date: null };
  }

  flush();
  return certs;
}

// ─── ZIP Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a LinkedIn data export ZIP and extract structured ProfileData.
 *
 * LinkedIn data export CSVs used:
 *   Profile.csv          — name, headline, location, summary
 *   Positions.csv        — work experience
 *   Education.csv        — education
 *   Skills.csv           — skills list
 *   Certifications.csv   — certifications / licenses
 *
 * @param {Buffer} buffer
 * @returns {Promise<ProfileData>}
 */
async function parseLinkedInZip(buffer) {
  const files = await extractZipFiles(buffer);

  const profile = emptyProfile();

  // Profile.csv → name, headline, location, about
  const profileCsv = findZipFile(files, [
    "Profile.csv",
    "profile.csv",
    "Basic_Info.csv",
    "basic_info.csv",
  ]);
  if (profileCsv) {
    applyProfileCsv(parseCSV(profileCsv), profile);
  }

  // Positions.csv → experience
  const positionsCsv = findZipFile(files, ["Positions.csv", "positions.csv"]);
  if (positionsCsv) {
    profile.experience = parsePositionsCsv(parseCSV(positionsCsv));
  }

  // Education.csv → education
  const educationCsv = findZipFile(files, ["Education.csv", "education.csv"]);
  if (educationCsv) {
    profile.education = parseEducationCsv(parseCSV(educationCsv));
  }

  // Skills.csv → skills
  const skillsCsv = findZipFile(files, ["Skills.csv", "skills.csv"]);
  if (skillsCsv) {
    profile.skills = parseSkillsCsv(parseCSV(skillsCsv));
  }

  // Certifications.csv → certifications
  const certsCsv = findZipFile(files, [
    "Certifications.csv",
    "certifications.csv",
    "Licenses_And_Certifications.csv",
    "licenses_and_certifications.csv",
    "Licenses And Certifications.csv",
  ]);
  if (certsCsv) {
    profile.certifications = parseCertificationsCsv(parseCSV(certsCsv));
  }

  return profile;
}

/** Find a file in the ZIP map by trying exact name and path-suffix variants. */
function findZipFile(files, names) {
  for (const name of names) {
    if (files[name]) return files[name];
    // Handle path prefixes like "LinkedIn Data Export_2024-01-01/Profile.csv"
    for (const key of Object.keys(files)) {
      if (key.endsWith("/" + name)) return files[key];
    }
  }
  return null;
}

// ── CSV application helpers ───────────────────────────────────────────────────

/**
 * Apply the first row of Profile.csv to the profile object.
 *
 * LinkedIn Profile.csv columns (may vary by export version):
 *   First Name, Last Name, Maiden Name, Address, Birth Date, Headline,
 *   Summary, Industry, Zip Code, Geo Location, Twitter Handles,
 *   Websites, Instant Messengers
 */
function applyProfileCsv(rows, profile) {
  if (rows.length === 0) return;
  const r = rows[0];

  const firstName = nullStr(r["First Name"] ?? r["first name"]) ?? "";
  const lastName = nullStr(r["Last Name"] ?? r["last name"]) ?? "";
  if (firstName || lastName) {
    profile.name = [firstName, lastName].filter(Boolean).join(" ");
  }

  profile.headline = nullStr(r["Headline"] ?? r["headline"]);
  profile.about = nullStr(r["Summary"] ?? r["summary"]);

  const loc =
    r["Geo Location"] ?? r["geo location"] ?? r["Address"] ?? r["address"] ?? "";
  if (loc.trim()) profile.location = loc.trim();
}

/** Parse Positions.csv rows into ExperienceEntry[]. */
function parsePositionsCsv(rows) {
  return rows
    .filter((r) => (r["Company Name"] ?? r["company name"] ?? r["Title"] ?? r["title"]))
    .map((r) => {
      const company = nullStr(r["Company Name"] ?? r["company name"]);
      const title = nullStr(r["Title"] ?? r["title"]) ?? "";
      const start = nullStr(
        r["Started On"] ?? r["started on"] ?? r["Start Date"] ?? r["start date"]
      );
      const end = nullStr(
        r["Finished On"] ?? r["finished on"] ?? r["End Date"] ?? r["end date"]
      );
      const description = nullStr(r["Description"] ?? r["description"]);

      let duration = null;
      if (start && end) duration = `${start} – ${end}`;
      else if (start) duration = `${start} – Present`;

      return { title, company, duration, description };
    })
    .reverse(); // LinkedIn exports in oldest-first order; reverse to newest-first.
}

/** Parse Education.csv rows into EducationEntry[]. */
function parseEducationCsv(rows) {
  return rows
    .filter((r) => r["School Name"] ?? r["school name"])
    .map((r) => {
      const school = nullStr(r["School Name"] ?? r["school name"]) ?? "";
      const degree = nullStr(r["Degree Name"] ?? r["degree name"]);
      // LinkedIn puts field of study in "Notes" column.
      const field = nullStr(r["Notes"] ?? r["notes"]);
      const start = nullStr(r["Start Date"] ?? r["start date"]);
      const end = nullStr(r["End Date"] ?? r["end date"]);

      let years = null;
      if (start && end) years = `${start} – ${end}`;
      else if (start) years = start;
      else if (end) years = end;

      return { school, degree, field, years };
    });
}

/** Parse Skills.csv rows into string[]. */
function parseSkillsCsv(rows) {
  return rows
    .map((r) => nullStr(r["Name"] ?? r["name"]))
    .filter(Boolean);
}

/** Parse Certifications.csv rows into CertificationEntry[]. */
function parseCertificationsCsv(rows) {
  return rows
    .filter((r) => r["Name"] ?? r["name"])
    .map((r) => {
      const name = nullStr(r["Name"] ?? r["name"]) ?? "";
      const issuer = nullStr(
        r["Authority"] ?? r["authority"] ?? r["Issuer"] ?? r["issuer"]
      );
      const date = nullStr(
        r["Started On"] ??
          r["started on"] ??
          r["Issued On"] ??
          r["issued on"] ??
          r["Date"] ??
          r["date"]
      );
      return { name, issuer, date };
    });
}

// ─── ZIP Binary Parser ────────────────────────────────────────────────────────
//
// Implements a minimal ZIP reader that uses only Node.js built-in modules.
// Spec reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
//
// Supports:
//   Compression method 0 — stored (no compression)
//   Compression method 8 — deflated (zlib.inflateRaw)
//
// Does not support ZIP64. LinkedIn data exports are always small (< 30 MB),
// so ZIP64 is not a practical concern.

const CENTRAL_DIR_SIG = 0x02014b50; // PK\x01\x02
const EOCD_SIG = 0x06054b50; // PK\x05\x06

/** Read an unsigned 16-bit little-endian integer. */
function readU16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

/** Read an unsigned 32-bit little-endian integer. */
function readU32(buf, off) {
  return (
    ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>>
      0)
  );
}

/**
 * Locate the End of Central Directory (EOCD) record.
 * Scans backward from the end; the .ZIP comment can be up to 65,535 bytes.
 *
 * @param {Buffer} buf
 * @returns {number}  Byte offset of the EOCD signature, or -1 if not found.
 */
function findEOCD(buf) {
  const minEocdSize = 22;
  const maxCommentLen = 65535;
  const searchFrom = Math.max(0, buf.length - minEocdSize - maxCommentLen);

  for (let i = buf.length - minEocdSize; i >= searchFrom; i--) {
    if (readU32(buf, i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Extract CSV files from a ZIP buffer using the Central Directory.
 * Skips non-CSV entries without decompressing them.
 *
 * @param {Buffer} buf
 * @returns {Promise<Record<string, string>>}  filename → UTF-8 text content
 */
async function extractZipFiles(buf) {
  const eocdOff = findEOCD(buf);
  if (eocdOff === -1) throw new Error("ZIP End of Central Directory not found");

  // EOCD layout:
  //   +0  signature (4)
  //   +4  disk number (2)
  //   +6  start disk (2)
  //   +8  entries on disk (2)
  //   +10 total entries (2)
  //   +12 CD size (4)
  //   +16 CD offset (4)
  //   +20 comment length (2)
  const numEntries = readU16(buf, eocdOff + 10);
  const cdOffset = readU32(buf, eocdOff + 16);

  /** @type {Record<string, string>} */
  const files = {};

  let pos = cdOffset;

  for (let i = 0; i < numEntries; i++) {
    if (pos + 46 > buf.length) break;
    if (readU32(buf, pos) !== CENTRAL_DIR_SIG) break;

    // Central Directory entry layout:
    //   +0  signature (4)
    //   +4  version made by (2)
    //   +6  version needed (2)
    //   +8  general purpose bit flag (2)
    //   +10 compression method (2)       ← we need this
    //   +12 last mod time (2)
    //   +14 last mod date (2)
    //   +16 CRC-32 (4)
    //   +20 compressed size (4)          ← we need this
    //   +24 uncompressed size (4)
    //   +28 filename length (2)          ← we need this
    //   +30 extra field length (2)       ← we need this
    //   +32 file comment length (2)      ← we need this
    //   +34 disk number start (2)
    //   +36 internal attributes (2)
    //   +38 external attributes (4)
    //   +42 relative offset of local header (4) ← we need this
    //   +46 filename (n bytes)

    const compressionMethod = readU16(buf, pos + 10);
    const compressedSize = readU32(buf, pos + 20);
    const filenameLen = readU16(buf, pos + 28);
    const extraLen = readU16(buf, pos + 30);
    const commentLen = readU16(buf, pos + 32);
    const localHeaderOffset = readU32(buf, pos + 42);

    const filename = buf.slice(pos + 46, pos + 46 + filenameLen).toString("utf8");

    // Advance to the next Central Directory entry now (before any continue)
    const cdEntrySize = 46 + filenameLen + extraLen + commentLen;

    if (filename.toLowerCase().endsWith(".csv")) {
      await extractSingleZipEntry(
        buf,
        filename,
        localHeaderOffset,
        compressionMethod,
        compressedSize,
        files
      );
    }

    pos += cdEntrySize;
  }

  return files;
}

/**
 * Decompress and store a single ZIP entry.
 *
 * Local File Header layout:
 *   +0  signature (4)
 *   +4  version needed (2)
 *   +6  general purpose bit flag (2)
 *   +8  compression method (2)
 *   +10 last mod time (2)
 *   +12 last mod date (2)
 *   +14 CRC-32 (4)
 *   +18 compressed size (4)
 *   +22 uncompressed size (4)
 *   +26 filename length (2)
 *   +28 extra field length (2)
 *   +30 filename (n bytes)
 *   +30+n extra field (m bytes)
 *   +30+n+m file data
 */
async function extractSingleZipEntry(
  buf,
  filename,
  localHeaderOffset,
  compressionMethod,
  compressedSize,
  files
) {
  const lhPos = localHeaderOffset;
  if (lhPos + 30 > buf.length) return;

  const lhFilenameLen = readU16(buf, lhPos + 26);
  const lhExtraLen = readU16(buf, lhPos + 28);
  const dataStart = lhPos + 30 + lhFilenameLen + lhExtraLen;

  if (dataStart + compressedSize > buf.length) return;

  const compressedData = buf.slice(dataStart, dataStart + compressedSize);

  try {
    let textData;
    if (compressionMethod === 0) {
      // Stored — no decompression needed.
      textData = compressedData.toString("utf8");
    } else if (compressionMethod === 8) {
      // Deflated — use zlib.inflateRaw (raw DEFLATE, no zlib header).
      const decompressed = await inflateRaw(compressedData);
      textData = decompressed.toString("utf8");
    } else {
      // Unsupported compression (e.g. bzip2, lzma) — skip.
      return;
    }
    files[filename] = textData;
  } catch {
    // Decompression or encoding error — skip this entry.
  }
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────
//
// RFC 4180-compliant CSV parser.
// Handles: quoted fields, doubled-quote escaping (""), CRLF and LF line endings.

/**
 * Parse a CSV string into an array of row objects keyed by header names.
 *
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
function parseCSV(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = splitCSVRows(normalized);
  if (rows.length === 0) return [];

  const headers = parseCSVRow(rows[0]);
  const result = [];

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw.trim()) continue;
    const values = parseCSVRow(raw);
    /** @type {Record<string, string>} */
    const obj = {};
    headers.forEach((h, j) => {
      obj[h.trim()] = (values[j] ?? "").trim();
    });
    result.push(obj);
  }

  return result;
}

/**
 * Split CSV text into logical rows, respecting quoted fields that contain
 * embedded newlines.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitCSVRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if (ch === "\n" && !inQuotes) {
      rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

/**
 * Parse a single CSV row into an array of field strings.
 * Strips surrounding quotes from quoted fields and un-escapes doubled quotes.
 *
 * @param {string} row
 * @returns {string[]}
 */
function parseCSVRow(row) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

/** Create an empty ProfileData object with all required fields. */
function emptyProfile() {
  return {
    name: null,
    headline: null,
    about: null,
    location: null,
    profileImageUrl: null,
    experience: [],
    education: [],
    skills: [],
    certifications: [],
  };
}

/**
 * Coerce a value to a trimmed string, or null if empty.
 *
 * @param {unknown} val
 * @returns {string|null}
 */
function nullStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}
