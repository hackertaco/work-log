/**
 * Resume Gap Analysis — rule-based comparison of LinkedIn data vs resume data.
 *
 * Compares a LinkedIn ProfileData object (from /api/resume/linkedin) against a
 * stored resume document and returns a structured list of gaps:
 *   - missing_field   : LinkedIn has a value; resume field is empty/null
 *   - discrepancy     : Both have values but they differ significantly
 *   - missing_entry   : LinkedIn has an experience/education/certification entry absent from resume
 *   - missing_skills  : LinkedIn skills not represented anywhere in the resume
 *
 * No LLM calls — purely deterministic rule-based logic.
 * No external dependencies beyond Node.js built-ins.
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {'missing_field'|'discrepancy'|'missing_entry'|'missing_skills'} GapType
 *
 * @typedef {Object} GapItem
 * @property {GapType}   type
 * @property {string}    section       — resume section: contact | summary | experience | education | skills | certifications
 * @property {string}    [field]       — specific field (for missing_field / discrepancy)
 * @property {string}    [linkedinValue]  — value from LinkedIn
 * @property {string}    [resumeValue]    — current value in resume (for discrepancy)
 * @property {object}    [linkedinEntry]  — full LinkedIn entry object (for missing_entry)
 * @property {string[]}  [missingSkills]  — list of skills (for missing_skills)
 * @property {object}    [context]        — additional context (e.g. { company } for experience discrepancies)
 * @property {string}    message
 */

/**
 * @typedef {Object} GapSummary
 * @property {number} total
 * @property {number} missing_fields
 * @property {number} discrepancies
 * @property {number} missing_entries
 * @property {number} missing_skills_count  — number of missing_skills gap items (each may list multiple skills)
 */

/**
 * @typedef {Object} GapAnalysisResult
 * @property {GapItem[]}   gaps
 * @property {GapSummary}  summary
 */

/**
 * Analyse gaps between LinkedIn profile data and the stored resume document.
 *
 * @param {object} linkedinData  ProfileData returned by /api/resume/linkedin
 * @param {object} resumeDoc     Full resume document stored in Vercel Blob
 * @returns {GapAnalysisResult}
 */
export function analyzeGaps(linkedinData, resumeDoc) {
  if (!linkedinData || typeof linkedinData !== "object") {
    return { gaps: [], summary: buildSummary([]) };
  }
  if (!resumeDoc || typeof resumeDoc !== "object") {
    return { gaps: [], summary: buildSummary([]) };
  }

  /** @type {GapItem[]} */
  const gaps = [];

  analyzeContactGaps(linkedinData, resumeDoc, gaps);
  analyzeSummaryGap(linkedinData, resumeDoc, gaps);
  analyzeExperienceGaps(linkedinData, resumeDoc, gaps);
  analyzeEducationGaps(linkedinData, resumeDoc, gaps);
  analyzeSkillsGaps(linkedinData, resumeDoc, gaps);
  analyzeCertificationGaps(linkedinData, resumeDoc, gaps);

  return { gaps, summary: buildSummary(gaps) };
}

// ─── Section analysers ─────────────────────────────────────────────────────────

/**
 * Compare contact-level fields: name and location.
 * Email, phone, website cannot be derived from LinkedIn public pages.
 *
 * @param {object} li    LinkedIn ProfileData
 * @param {object} rd    Resume document
 * @param {GapItem[]} out
 */
function analyzeContactGaps(li, rd, out) {
  const contact = rd.contact ?? {};

  // ── name ──────────────────────────────────────────────────────────────────
  const liName = normalizeStr(li.name);
  const rdName = normalizeStr(contact.name);

  if (liName && !rdName) {
    out.push({
      type: "missing_field",
      section: "contact",
      field: "name",
      linkedinValue: li.name,
      message: `LinkedIn has name "${li.name}" but resume contact name is empty.`
    });
  } else if (liName && rdName && !isSimilar(liName, rdName)) {
    out.push({
      type: "discrepancy",
      section: "contact",
      field: "name",
      linkedinValue: li.name,
      resumeValue: contact.name,
      message: `Name differs: LinkedIn "${li.name}" vs resume "${contact.name}".`
    });
  }

  // ── location ──────────────────────────────────────────────────────────────
  const liLoc = normalizeStr(li.location);
  const rdLoc = normalizeStr(contact.location);

  if (liLoc && !rdLoc) {
    out.push({
      type: "missing_field",
      section: "contact",
      field: "location",
      linkedinValue: li.location,
      message: `LinkedIn has location "${li.location}" but resume contact location is empty.`
    });
  } else if (liLoc && rdLoc && !isSimilar(liLoc, rdLoc)) {
    out.push({
      type: "discrepancy",
      section: "contact",
      field: "location",
      linkedinValue: li.location,
      resumeValue: contact.location,
      message: `Location differs: LinkedIn "${li.location}" vs resume "${contact.location}".`
    });
  }

  // ── linkedin URL ──────────────────────────────────────────────────────────
  // If the stored resume has no linkedin URL but we now have the profile URL
  // from the fetch request, flag it as a missing field so the caller can fill
  // in contact.linkedin.
  const rdLinkedin = normalizeStr(contact.linkedin);
  // The URL comes from the /api/resume/linkedin route response (stored in
  // meta.linkedin_url in the blob doc), not directly in ProfileData; surface
  // the meta value when contact.linkedin is absent.
  const metaLinkedinUrl = normalizeStr(rd.meta?.linkedin_url);
  if (!rdLinkedin && metaLinkedinUrl) {
    // Already stored in meta — just flag that contact.linkedin is not filled.
    out.push({
      type: "missing_field",
      section: "contact",
      field: "linkedin",
      linkedinValue: rd.meta.linkedin_url,
      message: `LinkedIn URL is known (${rd.meta.linkedin_url}) but contact.linkedin is empty.`
    });
  }
}

/**
 * Compare summary / about text.
 *
 * @param {object} li
 * @param {object} rd
 * @param {GapItem[]} out
 */
function analyzeSummaryGap(li, rd, out) {
  const liAbout = normalizeStr(li.about);
  const rdSummary = normalizeStr(rd.summary);

  if (liAbout && !rdSummary) {
    out.push({
      type: "missing_field",
      section: "summary",
      field: "summary",
      linkedinValue: li.about,
      message: "LinkedIn has an About section but the resume summary is empty."
    });
  }
  // We intentionally do not flag a discrepancy when both exist and differ —
  // summaries are reformulated by the LLM and will always look different.
  // A discrepancy here would produce unhelpful noise.
}

/**
 * Detect LinkedIn experience entries that are absent from the resume,
 * and flag title discrepancies for matched entries.
 *
 * Matching rule: a LinkedIn entry is considered "present" in the resume when
 * the resume contains an entry whose company name is similar enough.
 * Title similarity is checked as a secondary signal.
 *
 * When a match is found by company name, the job title is also compared.
 * A significant title difference is surfaced as a discrepancy so the user
 * can decide which version is correct.
 *
 * @param {object} li
 * @param {object} rd
 * @param {GapItem[]} out
 */
function analyzeExperienceGaps(li, rd, out) {
  const liExp = Array.isArray(li.experience) ? li.experience : [];
  const rdExp = Array.isArray(rd.experience) ? rd.experience : [];

  if (liExp.length === 0) return;

  for (const liEntry of liExp) {
    if (!liEntry || typeof liEntry !== "object") continue; // guard against null/undefined array slots
    const liCompany = normalizeStr(liEntry.company);
    const liTitle = normalizeStr(liEntry.title);

    if (!liCompany && !liTitle) continue; // no useful data to compare

    // ── Try to find a matching resume entry ───────────────────────────────
    let matchedEntry = null;

    // Primary: company name similarity
    if (liCompany) {
      matchedEntry =
        rdExp.find((rdEntry) => {
          const rdCompany = normalizeStr(rdEntry.company);
          return rdCompany && isSimilar(liCompany, rdCompany);
        }) ?? null;
    }

    // Secondary: title similarity (handles cases where company name varies, e.g. abbreviations)
    if (!matchedEntry && liTitle) {
      matchedEntry =
        rdExp.find((rdEntry) => {
          const rdTitle = normalizeStr(rdEntry.title);
          return rdTitle && isSimilar(liTitle, rdTitle);
        }) ?? null;
    }

    if (!matchedEntry) {
      // ── Missing entry — not found in resume at all ─────────────────────
      const label = [liEntry.title, liEntry.company].filter(Boolean).join(" @ ");
      out.push({
        type: "missing_entry",
        section: "experience",
        linkedinEntry: {
          title: liEntry.title ?? null,
          company: liEntry.company ?? null,
          duration: liEntry.duration ?? null,
          description: liEntry.description ?? null
        },
        message: `LinkedIn experience "${label}" not found in resume.`
      });
    } else {
      // ── Entry found — check for title discrepancy ──────────────────────
      const rdTitle = normalizeStr(matchedEntry.title ?? "");
      if (liTitle && rdTitle && !isSimilar(liTitle, rdTitle)) {
        const companyLabel = liEntry.company ?? matchedEntry.company ?? "";
        out.push({
          type: "discrepancy",
          section: "experience",
          field: "title",
          linkedinValue: liEntry.title,
          resumeValue: matchedEntry.title,
          context: { company: companyLabel },
          message: `Job title differs at "${companyLabel}": LinkedIn "${liEntry.title}" vs resume "${matchedEntry.title}".`
        });
      }

      // ── Entry found — check for duration / date discrepancy ───────────
      if (liEntry.duration) {
        const hasDurationDiscrepancy = detectDurationDiscrepancy(
          liEntry.duration,
          matchedEntry.start_date,
          matchedEntry.end_date
        );
        if (hasDurationDiscrepancy) {
          const companyLabel = liEntry.company ?? matchedEntry.company ?? "";
          const rdDurationStr =
            [matchedEntry.start_date, matchedEntry.end_date].filter(Boolean).join(" – ") ||
            null;
          out.push({
            type: "discrepancy",
            section: "experience",
            field: "duration",
            linkedinValue: liEntry.duration,
            resumeValue: rdDurationStr,
            context: { company: companyLabel },
            message: `Duration differs at "${companyLabel}": LinkedIn "${liEntry.duration}" vs resume "${rdDurationStr ?? "(no dates)"}".`
          });
        }
      }
    }
  }
}

/**
 * Detect LinkedIn education entries absent from the resume.
 *
 * Matching rule: match by school/institution name similarity.
 *
 * @param {object} li
 * @param {object} rd
 * @param {GapItem[]} out
 */
function analyzeEducationGaps(li, rd, out) {
  const liEdu = Array.isArray(li.education) ? li.education : [];
  const rdEdu = Array.isArray(rd.education) ? rd.education : [];

  if (liEdu.length === 0) return;

  for (const liEntry of liEdu) {
    const liSchool = normalizeStr(liEntry.school);
    if (!liSchool) continue;

    const matched = rdEdu.some((rdEntry) => {
      const rdInst = normalizeStr(rdEntry.institution);
      return rdInst && isSimilar(liSchool, rdInst);
    });

    if (!matched) {
      const label = [liEntry.degree, liEntry.field, liEntry.school]
        .filter(Boolean)
        .join(", ");
      out.push({
        type: "missing_entry",
        section: "education",
        linkedinEntry: {
          school: liEntry.school ?? null,
          degree: liEntry.degree ?? null,
          field: liEntry.field ?? null,
          years: liEntry.years ?? null
        },
        message: `LinkedIn education "${label}" not found in resume.`
      });
    }
  }
}

/**
 * Detect LinkedIn skills absent from every skill category and keyword list in
 * the resume.
 *
 * A skill is considered "present" when it appears (case-insensitive) in any of:
 *   resume.skills.technical, resume.skills.languages, resume.skills.tools,
 *   resume.strength_keywords
 *
 * @param {object} li
 * @param {object} rd
 * @param {GapItem[]} out
 */
function analyzeSkillsGaps(li, rd, out) {
  const liSkills = Array.isArray(li.skills) ? li.skills : [];
  if (liSkills.length === 0) return;

  // Build the full set of normalised resume skill strings for O(1) lookup.
  const rdSkillSet = buildResumeSkillSet(rd);

  const missingSkills = liSkills.filter((skill) => {
    const n = normalizeStr(skill);
    if (!n) return false;
    // Check for exact normalised match OR if any resume skill contains / is contained by this one.
    for (const rdSkill of rdSkillSet) {
      if (isSimilar(n, rdSkill)) return false;
    }
    return true;
  });

  if (missingSkills.length > 0) {
    out.push({
      type: "missing_skills",
      section: "skills",
      missingSkills,
      message: `${missingSkills.length} LinkedIn skill(s) not found in resume: ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? ` … (+${missingSkills.length - 5} more)` : ""}.`
    });
  }
}

/**
 * Detect LinkedIn certification entries absent from the resume.
 *
 * Matching rule: match by certification name similarity.
 *
 * @param {object} li
 * @param {object} rd
 * @param {GapItem[]} out
 */
function analyzeCertificationGaps(li, rd, out) {
  const liCerts = Array.isArray(li.certifications) ? li.certifications : [];
  const rdCerts = Array.isArray(rd.certifications) ? rd.certifications : [];

  if (liCerts.length === 0) return;

  for (const liCert of liCerts) {
    const liName = normalizeStr(liCert.name);
    if (!liName) continue;

    const matched = rdCerts.some((rdCert) => {
      const rdName = normalizeStr(rdCert.name);
      return rdName && isSimilar(liName, rdName);
    });

    if (!matched) {
      const label = [liCert.name, liCert.issuer].filter(Boolean).join(" · ");
      out.push({
        type: "missing_entry",
        section: "certifications",
        linkedinEntry: {
          name: liCert.name ?? null,
          issuer: liCert.issuer ?? null,
          date: liCert.date ?? null
        },
        message: `LinkedIn certification "${label}" not found in resume.`
      });
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a flat Set of normalised strings from all resume skill categories
 * and the strength_keywords array.
 *
 * @param {object} rd
 * @returns {Set<string>}
 */
function buildResumeSkillSet(rd) {
  const all = [];
  const skills = rd.skills ?? {};
  for (const category of ["technical", "languages", "tools"]) {
    if (Array.isArray(skills[category])) {
      for (const s of skills[category]) {
        const n = normalizeStr(s);
        if (n) all.push(n);
      }
    }
  }
  if (Array.isArray(rd.strength_keywords)) {
    for (const kw of rd.strength_keywords) {
      const n = normalizeStr(kw);
      if (n) all.push(n);
    }
  }
  return new Set(all);
}

/**
 * Build the summary counters from a list of gap items.
 *
 * @param {GapItem[]} gaps
 * @returns {GapSummary}
 */
function buildSummary(gaps) {
  return {
    total: gaps.length,
    missing_fields: gaps.filter((g) => g.type === "missing_field").length,
    discrepancies: gaps.filter((g) => g.type === "discrepancy").length,
    missing_entries: gaps.filter((g) => g.type === "missing_entry").length,
    missing_skills_count: gaps.filter((g) => g.type === "missing_skills").length
  };
}

/**
 * Normalise a string for comparison: lower-case, trim whitespace and
 * strip punctuation that varies across sources (e.g. "Inc." vs "Inc").
 *
 * @param {unknown} val
 * @returns {string}
 */
function normalizeStr(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-\u2013\u2014&]/g, " ") // treat common punctuation as word separators
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a LinkedIn duration string and extract the start and end year.
 *
 * Handles formats such as:
 *   "2021 – 2023", "Jan 2021 – Present", "2020–Present", "2019 - 2021"
 *
 * Does NOT parse relative durations like "5 years 2 months" — returns null.
 *
 * @param {string} duration  Raw LinkedIn duration string
 * @returns {{ start: string, end: string|null }|null}
 */
function parseDurationYears(duration) {
  const years = duration.match(/\b(19|20)\d{2}\b/g);
  if (!years || years.length === 0) return null;
  const isOngoing = /present|current|now/i.test(duration);
  const end = isOngoing ? null : (years[1] ?? null);
  return { start: years[0], end };
}

/**
 * Extract a 4-digit year string from a date field value.
 * Handles ISO dates ("2021-06"), plain years ("2021"), or null/undefined.
 *
 * @param {unknown} dateVal
 * @returns {string|null}
 */
function extractYear(dateVal) {
  if (!dateVal) return null;
  const m = String(dateVal).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : null;
}

/**
 * Detect a meaningful date discrepancy between a LinkedIn duration string
 * and a resume entry's start_date / end_date fields.
 *
 * Returns true when:
 *   - Both have a parseable start year AND they differ, OR
 *   - Both have explicit end years AND they differ.
 *
 * Does NOT flag when LinkedIn shows "Present" but resume end_date is null —
 * that is expected for a current role.
 *
 * @param {string}   liDuration  LinkedIn formatted duration (e.g. "2021 – 2023")
 * @param {unknown}  rdStart     Resume start_date field
 * @param {unknown}  rdEnd       Resume end_date field
 * @returns {boolean}
 */
function detectDurationDiscrepancy(liDuration, rdStart, rdEnd) {
  const li = parseDurationYears(liDuration);
  if (!li) return false; // unparseable duration → skip

  const rdStartYear = extractYear(rdStart);
  const rdEndYear = extractYear(rdEnd);

  // Start year discrepancy
  if (li.start && rdStartYear && li.start !== rdStartYear) return true;

  // End year discrepancy (only when both sides have an explicit end year)
  if (li.end && rdEndYear && li.end !== rdEndYear) return true;

  return false;
}

/**
 * Return true when two normalised strings are considered similar enough to
 * be treated as the same entity.
 *
 * Similarity rules (in order):
 *   1. Exact match after normalisation
 *   2. One string contains the other (handles sub-strings like "Meta" / "Meta Platforms")
 *   3. Either string is an acronym of the other (e.g. "AI" in "Artificial Intelligence")
 *
 * @param {string} a  Already normalised
 * @param {string} b  Already normalised
 * @returns {boolean}
 */
function isSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Acronym check: one is a short all-alpha token and it matches initials of the other
  if (a.length <= 5 && isAcronymOf(a, b)) return true;
  if (b.length <= 5 && isAcronymOf(b, a)) return true;
  return false;
}

/**
 * Return true when `acronym` matches the initial letters of `phrase`'s words.
 *
 * Example: isAcronymOf("ai", "artificial intelligence") → true
 *
 * @param {string} acronym  Normalised short token
 * @param {string} phrase   Normalised multi-word phrase
 * @returns {boolean}
 */
function isAcronymOf(acronym, phrase) {
  const letters = acronym.replace(/\s/g, "");
  if (!/^[a-z]+$/.test(letters)) return false; // only alpha acronyms
  const initials = phrase
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  return initials === letters;
}
