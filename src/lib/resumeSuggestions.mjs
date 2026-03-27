/**
 * Resume Suggestions — converts GapAnalysis results into storable Suggestion
 * objects that are compatible with the applySuggestionPatch helper in
 * src/routes/resume.mjs.
 *
 * A Suggestion object shape (stored in resume/suggestions.json):
 *   {
 *     id:          string      — stable unique identifier (crypto.randomUUID)
 *     type:        GapType     — 'missing_field' | 'discrepancy' | 'missing_entry' | 'missing_skills'
 *     section:     string      — resume section: contact | summary | experience | education | skills
 *     action:      string      — patch action type (see applySuggestionPatch in resume.mjs)
 *     description: string      — human-readable one-liner shown in the suggestion card
 *     detail:      string      — secondary text (message or duration)
 *     patch:       object      — action-specific payload (see applySuggestionPatch)
 *     source:      string      — always 'linkedin' for this module
 *     createdAt:   ISO string
 *     status:      'pending' | 'approved' | 'rejected'
 *   }
 *
 * No external dependencies.
 */

import { randomUUID } from "node:crypto";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert an array of GapItem objects (from resumeGapAnalysis.analyzeGaps)
 * into storable Suggestion objects.
 *
 * Gaps that cannot be converted into a meaningful actionable suggestion are
 * silently dropped (e.g. unknown section/type combinations).
 *
 * @param {import('./resumeGapAnalysis.mjs').GapItem[]} gaps
 * @returns {object[]}  Suggestion objects with status = 'pending'
 */
export function gapItemsToSuggestions(gaps) {
  if (!Array.isArray(gaps) || gaps.length === 0) return [];

  const now = new Date().toISOString();

  return gaps
    .map((gap) => {
      const base = {
        id: randomUUID(),
        type: gap.type,
        section: gap.section,
        source: "linkedin",
        createdAt: now,
        status: "pending"
      };

      switch (gap.type) {
        // ── missing_field: LinkedIn has a value; resume field is empty ─────
        case "missing_field": {
          if (!gap.linkedinValue) return null;

          if (gap.section === "summary" && gap.field === "summary") {
            return {
              ...base,
              action: "update_summary",
              description: `개요 추가: ${truncate(gap.linkedinValue, 60)}`,
              detail: gap.message,
              patch: { text: gap.linkedinValue }
            };
          }

          if (gap.section === "contact" && gap.field) {
            return {
              ...base,
              action: "update_field",
              description: `${fieldLabel(gap.field)} 추가: ${truncate(gap.linkedinValue, 50)}`,
              detail: gap.message,
              patch: { section: "contact", field: gap.field, value: gap.linkedinValue }
            };
          }

          return null;
        }

        // ── discrepancy: both have values but they differ significantly ────
        case "discrepancy": {
          if (!gap.linkedinValue) return null;

          if (gap.section === "contact" && gap.field) {
            return {
              ...base,
              action: "update_field",
              description: `${fieldLabel(gap.field)} 수정 → ${truncate(gap.linkedinValue, 50)}`,
              detail: gap.message,
              patch: { section: "contact", field: gap.field, value: gap.linkedinValue }
            };
          }

          // Experience title discrepancy: LinkedIn shows a different job title
          if (gap.section === "experience" && gap.field === "title") {
            const company = gap.context?.company ?? "";
            return {
              ...base,
              action: "update_experience_title",
              description: `직함 수정 (${truncate(company, 30)}): ${truncate(gap.linkedinValue, 40)}`,
              detail: gap.message,
              patch: {
                company,
                field: "title",
                value: gap.linkedinValue,
                previousValue: gap.resumeValue ?? null
              }
            };
          }

          return null;
        }

        // ── missing_entry: LinkedIn has experience / education absent from resume
        case "missing_entry": {
          const entry = gap.linkedinEntry ?? {};

          if (gap.section === "experience") {
            const label = [entry.title, entry.company]
              .filter(Boolean)
              .join(" @ ");
            if (!label) return null;

            return {
              ...base,
              action: "add_experience",
              description: label,
              detail: entry.duration ?? gap.message,
              patch: {
                entry: {
                  company: entry.company ?? "",
                  title: entry.title ?? "",
                  start_date: null,
                  end_date: null,
                  location: null,
                  bullets: entry.description ? [entry.description] : []
                }
              }
            };
          }

          if (gap.section === "education") {
            const label = [entry.degree, entry.school]
              .filter(Boolean)
              .join(" · ");
            if (!label) return null;

            return {
              ...base,
              action: "add_education",
              description: label,
              detail: entry.years ?? gap.message,
              patch: {
                entry: {
                  institution: entry.school ?? "",
                  degree: entry.degree ?? null,
                  field: entry.field ?? null,
                  start_date: null,
                  end_date: entry.years ?? null,
                  gpa: null
                }
              }
            };
          }

          if (gap.section === "certifications") {
            const label = [entry.name, entry.issuer]
              .filter(Boolean)
              .join(" · ");
            if (!label) return null;

            return {
              ...base,
              action: "add_certification",
              description: `자격증 추가: ${truncate(label, 60)}`,
              detail: entry.date ?? gap.message,
              patch: {
                entry: {
                  name: entry.name ?? "",
                  issuer: entry.issuer ?? null,
                  date: entry.date ?? null
                }
              }
            };
          }

          return null; // unknown section
        }

        // ── missing_skills: LinkedIn skills not in resume ─────────────────
        case "missing_skills": {
          const skills = gap.missingSkills ?? [];
          if (skills.length === 0) return null;

          const preview = skills.slice(0, 3).join(", ");
          const extra = skills.length > 3 ? ` 외 ${skills.length - 3}개` : "";

          return {
            ...base,
            action: "add_skills",
            description: `기술 추가: ${preview}${extra}`,
            detail: gap.message,
            patch: { skills }
          };
        }

        default:
          return null;
      }
    })
    .filter(Boolean);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Human-readable label for a contact field (Korean).
 *
 * @param {string} field
 * @returns {string}
 */
function fieldLabel(field) {
  const map = {
    name: "이름",
    email: "이메일",
    phone: "전화번호",
    location: "위치",
    website: "웹사이트",
    linkedin: "LinkedIn URL"
  };
  return map[field] ?? field;
}

/**
 * Truncate a string to at most `max` characters, appending "…" if needed.
 *
 * @param {string|null|undefined} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (!str) return "";
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
