/**
 * Unit tests for linkedinFileParser.mjs
 *
 * Validates LinkedIn PDF and ZIP parsing logic using Node.js built-in test
 * runner (node:test) — no external test dependencies required.
 *
 * Run:
 *   node --test src/lib/linkedinFileParser.test.mjs
 *
 * Coverage:
 *   - extractFromLinkedInPdfText  — PDF text heuristic parsing (English + Korean)
 *     - Header block: name, headline, location
 *     - Experience section (title, company, date range, description bullets)
 *     - Education section (school, degree, field, years)
 *     - Skills section (comma-separated and one-per-line)
 *     - Certifications section (name, issuer, date)
 *     - Summary / About section
 *   - parseLinkedInFile (ZIP path) — ZIP binary parsing via pure Node.js zlib
 *     - CSV extraction from deflated and stored ZIP entries
 *     - Profile.csv, Positions.csv, Education.csv, Skills.csv, Certifications.csv
 *   - parseLinkedInFile error cases
 *     - Empty buffer → ok: false
 *     - Unsupported format → source: "unsupported"
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { promisify } from "node:util";

import { parseLinkedInFile, extractFromLinkedInPdfText } from "./linkedinFileParser.mjs";

const deflate = promisify(zlib.deflateRaw);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal PKZIP archive from a map of filename → text content. */
async function buildZip(files) {
  const localHeaders = [];
  const centralDirEntries = [];
  let offset = 0;

  for (const [filename, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(filename, "utf8");
    const dataBytes = Buffer.from(content, "utf8");
    // Use "stored" compression (method 0) for simplicity in tests.
    // (deflated entries are tested via the CSV test below.)

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);   // Local file header signature
    localHeader.writeUInt16LE(20, 4);            // Version needed
    localHeader.writeUInt16LE(0, 6);             // General purpose bit flag
    localHeader.writeUInt16LE(0, 8);             // Compression method: stored
    localHeader.writeUInt16LE(0, 10);            // Last mod time
    localHeader.writeUInt16LE(0, 12);            // Last mod date
    localHeader.writeUInt32LE(0, 14);            // CRC-32 (unused in these tests)
    localHeader.writeUInt32LE(dataBytes.length, 18); // Compressed size
    localHeader.writeUInt32LE(dataBytes.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28);            // Extra field length
    nameBytes.copy(localHeader, 30);

    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);        // Central directory signature
    cdEntry.writeUInt16LE(20, 4);                // Version made by
    cdEntry.writeUInt16LE(20, 6);                // Version needed
    cdEntry.writeUInt16LE(0, 8);                 // Bit flag
    cdEntry.writeUInt16LE(0, 10);                // Compression method
    cdEntry.writeUInt16LE(0, 12);                // Last mod time
    cdEntry.writeUInt16LE(0, 14);                // Last mod date
    cdEntry.writeUInt32LE(0, 16);                // CRC-32
    cdEntry.writeUInt32LE(dataBytes.length, 20); // Compressed size
    cdEntry.writeUInt32LE(dataBytes.length, 24); // Uncompressed size
    cdEntry.writeUInt16LE(nameBytes.length, 28); // Filename length
    cdEntry.writeUInt16LE(0, 30);                // Extra field length
    cdEntry.writeUInt16LE(0, 32);                // File comment length
    cdEntry.writeUInt16LE(0, 34);                // Disk number start
    cdEntry.writeUInt16LE(0, 36);                // Internal attributes
    cdEntry.writeUInt32LE(0, 38);                // External attributes
    cdEntry.writeUInt32LE(offset, 42);           // Relative offset of local header
    nameBytes.copy(cdEntry, 46);

    localHeaders.push(localHeader, dataBytes);
    centralDirEntries.push(cdEntry);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDir = Buffer.concat(centralDirEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);             // EOCD signature
  eocd.writeUInt16LE(0, 4);                      // Disk number
  eocd.writeUInt16LE(0, 6);                      // Start disk
  eocd.writeUInt16LE(Object.keys(files).length, 8);  // Entries on disk
  eocd.writeUInt16LE(Object.keys(files).length, 10); // Total entries
  eocd.writeUInt32LE(centralDir.length, 12);     // Central dir size
  eocd.writeUInt32LE(offset, 16);                // Central dir offset
  eocd.writeUInt16LE(0, 20);                     // Comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

// ─── PDF text heuristic parsing — English ────────────────────────────────────

describe("extractFromLinkedInPdfText — English PDF", () => {
  const SAMPLE_EN = `Jane Doe
Senior Software Engineer
Seoul, South Korea | jane@example.com | +82-10-1234-5678

Summary
Experienced software engineer with 8+ years in distributed systems.
Built high-throughput data pipelines serving 100M+ users.

Experience
Senior Software Engineer
Kakao Corp · Full-time
Jan 2021 – Present · 3 yrs 2 mos
Seoul, South Korea
• Led design of real-time recommendation engine
• Reduced latency by 40% via algorithmic optimization
• Managed cross-functional team of 6 engineers

Software Engineer
Naver Corp
Mar 2016 – Dec 2020 · 4 yrs 9 mos
• Developed internal tooling used by 500+ developers
• Migrated monolith to microservices

Education
Seoul National University
Bachelor of Science, Computer Science
2012 – 2016

Skills
Python, TypeScript, Go
Kubernetes, Docker, AWS
Distributed Systems, System Design

Licenses & Certifications
AWS Certified Solutions Architect
Amazon Web Services · Credential ID: ABC123
Issued Nov 2022
`;

  test("extracts name", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.name, "Jane Doe");
  });

  test("extracts headline", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.headline, "Senior Software Engineer");
  });

  test("extracts location", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(profile.location?.includes("Seoul"), `location="${profile.location}"`);
  });

  test("extracts about/summary", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.about?.includes("distributed systems"),
      `about="${profile.about}"`
    );
  });

  test("extracts 2 experience entries", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.experience.length, 2, `experience=${JSON.stringify(profile.experience.map(e => e.title))}`);
  });

  test("first experience has correct title", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.experience[0].title, "Senior Software Engineer");
  });

  test("first experience has correct company", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.experience[0].company, "Kakao Corp");
  });

  test("first experience has duration", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.experience[0].duration?.includes("2021"),
      `duration="${profile.experience[0].duration}"`
    );
  });

  test("first experience description includes bullet content", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.experience[0].description?.includes("recommendation engine"),
      `desc="${profile.experience[0].description}"`
    );
  });

  test("second experience has correct company", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.experience[1].company, "Naver Corp");
  });

  test("extracts education entry", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.education.length, 1);
    assert.ok(profile.education[0].school.includes("Seoul National"), `school="${profile.education[0].school}"`);
  });

  test("education has degree", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.education[0].degree?.toLowerCase().includes("bachelor"),
      `degree="${profile.education[0].degree}"`
    );
  });

  test("education has field", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.education[0].field?.includes("Computer Science"),
      `field="${profile.education[0].field}"`
    );
  });

  test("extracts skills", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(profile.skills.length >= 3, `skills count=${profile.skills.length}`);
    assert.ok(profile.skills.some(s => s === "Python"), `skills=${JSON.stringify(profile.skills)}`);
  });

  test("extracts certification", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.equal(profile.certifications.length, 1);
    assert.ok(
      profile.certifications[0].name.includes("AWS Certified"),
      `cert name="${profile.certifications[0].name}"`
    );
  });

  test("certification has issuer", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_EN);
    assert.ok(
      profile.certifications[0].issuer?.includes("Amazon"),
      `issuer="${profile.certifications[0].issuer}"`
    );
  });
});

// ─── PDF text heuristic parsing — Korean ─────────────────────────────────────

describe("extractFromLinkedInPdfText — Korean PDF", () => {
  const SAMPLE_KO = `홍길동
시니어 소프트웨어 엔지니어
서울, 대한민국 | hong@example.com

요약
8년 이상의 분산 시스템 경험을 가진 소프트웨어 엔지니어입니다.

경력
시니어 엔지니어
카카오 · 정규직
2021년 1월 – 현재
서울, 대한민국
• 실시간 추천 엔진 설계 주도
• 알고리즘 최적화로 지연 시간 40% 단축

소프트웨어 엔지니어
네이버
2016년 3월 – 2020년 12월
• 내부 툴링 개발 및 유지보수

학력
서울대학교
이학사, 컴퓨터공학
2012 – 2016

스킬
Python, TypeScript, Go

자격증
AWS 공인 솔루션스 아키텍트
Amazon Web Services
발급일 2022년 11월
`;

  test("extracts Korean name", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.equal(profile.name, "홍길동");
  });

  test("extracts Korean headline", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.equal(profile.headline, "시니어 소프트웨어 엔지니어");
  });

  test("extracts Korean about section", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.ok(
      profile.about?.includes("소프트웨어 엔지니어"),
      `about="${profile.about}"`
    );
  });

  test("extracts Korean experience entries", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.ok(profile.experience.length >= 1, `exp count=${profile.experience.length}`);
  });

  test("extracts Korean education", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.ok(profile.education.length >= 1, `edu count=${profile.education.length}`);
    assert.ok(
      profile.education[0].school.includes("서울대학교"),
      `school="${profile.education[0].school}"`
    );
  });

  test("extracts Korean skills", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.ok(profile.skills.length >= 1, `skills count=${profile.skills.length}`);
    assert.ok(profile.skills.some(s => s === "Python"), `skills=${JSON.stringify(profile.skills)}`);
  });

  test("extracts Korean certifications", () => {
    const profile = extractFromLinkedInPdfText(SAMPLE_KO);
    assert.ok(profile.certifications.length >= 1, `certs count=${profile.certifications.length}`);
  });
});

// ─── PDF text heuristic parsing — edge cases ─────────────────────────────────

describe("extractFromLinkedInPdfText — edge cases", () => {
  test("empty string returns empty profile with empty arrays", () => {
    const profile = extractFromLinkedInPdfText("");
    assert.equal(profile.name, null);
    assert.deepEqual(profile.experience, []);
    assert.deepEqual(profile.education, []);
    assert.deepEqual(profile.skills, []);
    assert.deepEqual(profile.certifications, []);
  });

  test("profile with only name returns name", () => {
    const profile = extractFromLinkedInPdfText("Jane Doe\n");
    assert.equal(profile.name, "Jane Doe");
    assert.deepEqual(profile.experience, []);
  });

  test("contact-only lines are not mistaken for name", () => {
    const profile = extractFromLinkedInPdfText("jane@example.com\nJane Doe\nEngineer\n");
    // Contact line (email) is skipped; "Jane Doe" is the first non-contact line.
    assert.equal(profile.name, "Jane Doe");
  });

  test("skills section with one-per-line format", () => {
    const text = "Skills\nPython\nTypeScript\nKubernetes\n";
    const profile = extractFromLinkedInPdfText(text);
    assert.ok(
      profile.skills.includes("Python") &&
      profile.skills.includes("TypeScript") &&
      profile.skills.includes("Kubernetes"),
      `skills=${JSON.stringify(profile.skills)}`
    );
  });

  test("skills section with comma-separated format", () => {
    const text = "Skills\nPython, TypeScript, Kubernetes, Docker\n";
    const profile = extractFromLinkedInPdfText(text);
    assert.ok(
      profile.skills.includes("Python"),
      `skills=${JSON.stringify(profile.skills)}`
    );
    assert.ok(profile.skills.length >= 4);
  });

  test("experience with no description is still parsed", () => {
    const text = `John Smith
Engineer
Experience
Software Engineer
Google
2020 – Present
`;
    const profile = extractFromLinkedInPdfText(text);
    assert.ok(profile.experience.length >= 1);
    assert.equal(profile.experience[0].title, "Software Engineer");
    assert.equal(profile.experience[0].company, "Google");
  });

  test("education without degree keyword is still parsed", () => {
    const text = `Summary
A developer.

Education
MIT
2010 – 2014
`;
    const profile = extractFromLinkedInPdfText(text);
    assert.ok(profile.education.length >= 1);
    assert.ok(profile.education[0].school.includes("MIT"), `school="${profile.education[0].school}"`);
  });
});

// ─── ZIP file parsing ─────────────────────────────────────────────────────────

describe("parseLinkedInFile — LinkedIn Data Export ZIP", () => {
  test("parses Profile.csv and Positions.csv from ZIP", async () => {
    const profileCsv = [
      `First Name,Last Name,Headline,Summary,Geo Location`,
      `"Alice","Kim","Senior Engineer","Expert in distributed systems","Seoul, Korea"`,
    ].join("\n");

    // LinkedIn data export lists positions oldest-first.
    // parsePositionsCsv reverses the array so newest is at index 0.
    const positionsCsv = [
      `Company Name,Title,Description,Started On,Finished On`,
      `"Naver","Engineer","Built APIs","Mar 2016","Dec 2020"`,
      `"Kakao","Senior Engineer","Led backend services","Jan 2021","Present"`,
    ].join("\n");

    const zipBuf = await buildZip({
      "Profile.csv": profileCsv,
      "Positions.csv": positionsCsv,
    });

    const result = await parseLinkedInFile(zipBuf, "linkedin_data.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.ok(result.ok, `ok=${result.ok} error="${result.error}"`);
    assert.equal(result.data.name, "Alice Kim");
    assert.equal(result.data.headline, "Senior Engineer");
    assert.ok(result.data.location?.includes("Seoul"), `location="${result.data.location}"`);
    assert.ok(result.data.about?.includes("distributed"), `about="${result.data.about}"`);
    assert.equal(result.data.experience.length, 2, `exp=${JSON.stringify(result.data.experience.map(e => e.title))}`);
    assert.equal(result.data.experience[0].title, "Senior Engineer");
    assert.equal(result.data.experience[0].company, "Kakao");
    assert.equal(result.data.experience[1].company, "Naver");
  });

  test("parses Education.csv from ZIP", async () => {
    const educationCsv = [
      `School Name,Degree Name,Notes,Start Date,End Date`,
      `"Seoul National University","Bachelor of Science","Computer Science","2012","2016"`,
    ].join("\n");

    const zipBuf = await buildZip({ "Education.csv": educationCsv });
    const result = await parseLinkedInFile(zipBuf, "data.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.equal(result.data.education.length, 1);
    assert.ok(result.data.education[0].school.includes("Seoul National"));
    assert.ok(result.data.education[0].degree?.includes("Bachelor"));
    assert.equal(result.data.education[0].field, "Computer Science");
  });

  test("parses Skills.csv from ZIP", async () => {
    const skillsCsv = [
      `Name`,
      `Python`,
      `TypeScript`,
      `Kubernetes`,
    ].join("\n");

    const zipBuf = await buildZip({ "Skills.csv": skillsCsv });
    const result = await parseLinkedInFile(zipBuf, "data.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.ok(result.data.skills.includes("Python"), `skills=${JSON.stringify(result.data.skills)}`);
    assert.ok(result.data.skills.includes("TypeScript"));
    assert.ok(result.data.skills.includes("Kubernetes"));
  });

  test("parses Certifications.csv from ZIP", async () => {
    const certsCsv = [
      `Name,Authority,Started On`,
      `"AWS Certified Solutions Architect","Amazon Web Services","Nov 2022"`,
    ].join("\n");

    const zipBuf = await buildZip({ "Certifications.csv": certsCsv });
    const result = await parseLinkedInFile(zipBuf, "data.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.equal(result.data.certifications.length, 1);
    assert.ok(
      result.data.certifications[0].name.includes("AWS"),
      `cert="${result.data.certifications[0].name}"`
    );
    assert.ok(
      result.data.certifications[0].issuer?.includes("Amazon"),
      `issuer="${result.data.certifications[0].issuer}"`
    );
  });

  test("handles path-prefixed filenames in ZIP (e.g. LinkedIn Data Export_2024/Profile.csv)", async () => {
    const profileCsv = [
      `First Name,Last Name,Headline`,
      `"Bob","Lee","CTO"`,
    ].join("\n");

    const zipBuf = await buildZip({
      "LinkedIn Data Export_2024-01-01/Profile.csv": profileCsv,
    });

    const result = await parseLinkedInFile(zipBuf, "export.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.equal(result.data.name, "Bob Lee");
    assert.equal(result.data.headline, "CTO");
  });

  test("ok=false when ZIP has no recognizable LinkedIn CSVs", async () => {
    const zipBuf = await buildZip({ "unknown.csv": "col1,col2\na,b\n" });
    const result = await parseLinkedInFile(zipBuf, "unknown.zip");
    assert.equal(result.source, "linkedin_zip");
    // ok=false because name, experience, and skills are all empty
    assert.equal(result.ok, false);
  });
});

// ─── parseLinkedInFile — magic byte detection and error cases ────────────────

describe("parseLinkedInFile — error handling", () => {
  test("empty buffer → ok:false source:unknown", async () => {
    const result = await parseLinkedInFile(Buffer.alloc(0), "file.pdf");
    assert.equal(result.ok, false);
    assert.equal(result.source, "unknown");
    assert.ok(result.error, "should have an error message");
  });

  test("non-Buffer input → ok:false", async () => {
    // @ts-expect-error intentional wrong type
    const result = await parseLinkedInFile(null, "file.pdf");
    assert.equal(result.ok, false);
  });

  test("random bytes (not PDF/ZIP) → source:unsupported", async () => {
    const buf = Buffer.from("this is not a pdf or zip file at all 12345678", "utf8");
    const result = await parseLinkedInFile(buf, "unknown.bin");
    assert.equal(result.source, "unsupported");
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("지원하지 않는"), `error="${result.error}"`);
  });

  test("unsupported format error message includes .bin extension hint", async () => {
    const buf = Buffer.from("GARBAGE_DATA_12345", "utf8");
    const result = await parseLinkedInFile(buf, "file.bin");
    assert.ok(result.error?.includes(".bin") || result.error?.includes("지원하지 않는"), `error="${result.error}"`);
  });
});

// ─── ZIP with deflated (compressed) entries ───────────────────────────────────

describe("parseLinkedInFile — deflated ZIP entries", () => {
  test("parses Skills.csv compressed with deflate (method 8)", async () => {
    const skillsCsv = "Name\nPython\nJavaScript\nDocker\n";
    const nameBytes = Buffer.from("Skills.csv", "utf8");
    const dataBytes = Buffer.from(skillsCsv, "utf8");
    const compressed = await deflate(dataBytes);

    // Build a ZIP with compression method 8 (deflated).
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);          // method: deflated
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    const localOffset = 0;
    const totalLocalSize = localHeader.length + compressed.length;

    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(8, 10);             // method: deflated
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(0, 16);
    cdEntry.writeUInt32LE(compressed.length, 20);
    cdEntry.writeUInt32LE(dataBytes.length, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(localOffset, 42);
    nameBytes.copy(cdEntry, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdEntry.length, 12);
    eocd.writeUInt32LE(totalLocalSize, 16);
    eocd.writeUInt16LE(0, 20);

    const zipBuf = Buffer.concat([localHeader, compressed, cdEntry, eocd]);
    const result = await parseLinkedInFile(zipBuf, "export.zip");

    assert.equal(result.source, "linkedin_zip");
    assert.ok(
      result.data.skills.includes("Python"),
      `skills=${JSON.stringify(result.data.skills)}`
    );
    assert.ok(
      result.data.skills.includes("JavaScript"),
      `skills=${JSON.stringify(result.data.skills)}`
    );
    assert.ok(
      result.data.skills.includes("Docker"),
      `skills=${JSON.stringify(result.data.skills)}`
    );
  });
});
