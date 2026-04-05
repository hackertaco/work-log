/**
 * Unit tests for resumeTypes.mjs — factory/validation helpers.
 *
 * Run with:  node --test src/lib/resumeTypes.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_SOURCE_TYPES,
  CITATION_SNIPPET_MAX_LENGTH,
  isValidEvidenceSourceType,
  createCommitProvenance,
  createSlackProvenance,
  createSessionProvenance,
  createEvidenceCitation,
  normalizeToEvidenceItem,
  buildEvidenceSummary,
} from "./resumeTypes.mjs";

// ─── EVIDENCE_SOURCE_TYPES constant ──────────────────────────────────────────

describe("EVIDENCE_SOURCE_TYPES", () => {
  it("contains exactly three source types", () => {
    assert.deepStrictEqual([...EVIDENCE_SOURCE_TYPES], ["commits", "slack", "session"]);
  });
});

// ─── isValidEvidenceSourceType ───────────────────────────────────────────────

describe("isValidEvidenceSourceType", () => {
  it("returns true for valid types", () => {
    assert.ok(isValidEvidenceSourceType("commits"));
    assert.ok(isValidEvidenceSourceType("slack"));
    assert.ok(isValidEvidenceSourceType("session"));
  });

  it("returns false for invalid types", () => {
    assert.ok(!isValidEvidenceSourceType("unknown"));
    assert.ok(!isValidEvidenceSourceType(""));
    assert.ok(!isValidEvidenceSourceType("sessions")); // plural form is invalid
  });
});

// ─── createCommitProvenance ──────────────────────────────────────────────────

describe("createCommitProvenance", () => {
  it("creates a valid CommitProvenance with required fields", () => {
    const result = createCommitProvenance({ commitHash: "abc1234", repo: "work-log" });
    assert.deepStrictEqual(result, {
      sourceType: "commits",
      commitHash: "abc1234",
      repo: "work-log",
      authoredAt: null,
      repoPath: null,
    });
  });

  it("includes optional fields when provided", () => {
    const result = createCommitProvenance({
      commitHash: "abc1234",
      repo: "work-log",
      authoredAt: "2025-03-15T10:00:00Z",
      repoPath: "/Users/dev/work-log",
    });
    assert.equal(result.authoredAt, "2025-03-15T10:00:00Z");
    assert.equal(result.repoPath, "/Users/dev/work-log");
  });

  it("defaults non-string commitHash to empty string", () => {
    const result = createCommitProvenance({ commitHash: null, repo: "x" });
    assert.equal(result.commitHash, "");
  });
});

// ─── createSlackProvenance ───────────────────────────────────────────────────

describe("createSlackProvenance", () => {
  it("creates a valid SlackProvenance with required fields", () => {
    const result = createSlackProvenance({ messageId: "1234567890.123456", channelId: "C01ABCDEF" });
    assert.deepStrictEqual(result, {
      sourceType: "slack",
      messageId: "1234567890.123456",
      channelId: "C01ABCDEF",
      permalink: null,
      context: [],
    });
  });

  it("includes permalink and context when provided", () => {
    const result = createSlackProvenance({
      messageId: "ts123",
      channelId: "C01",
      permalink: "https://team.slack.com/archives/C01/p123",
      context: ["prev msg", "next msg"],
    });
    assert.equal(result.permalink, "https://team.slack.com/archives/C01/p123");
    assert.deepStrictEqual(result.context, ["prev msg", "next msg"]);
  });

  it("defaults non-array context to empty array", () => {
    const result = createSlackProvenance({ messageId: "ts", channelId: "C", context: "bad" });
    assert.deepStrictEqual(result.context, []);
  });
});

// ─── createSessionProvenance ─────────────────────────────────────────────────

describe("createSessionProvenance", () => {
  it("creates a valid SessionProvenance with defaults", () => {
    const result = createSessionProvenance();
    assert.deepStrictEqual(result, {
      sourceType: "session",
      sessionType: null,
      filePath: null,
      cwd: null,
      snippets: [],
    });
  });

  it("includes optional fields when provided", () => {
    const result = createSessionProvenance({
      sessionType: "claude",
      filePath: "/path/to/session.jsonl",
      cwd: "/dev/project",
      snippets: ["snippet1", "snippet2"],
    });
    assert.equal(result.sessionType, "claude");
    assert.equal(result.filePath, "/path/to/session.jsonl");
    assert.deepStrictEqual(result.snippets, ["snippet1", "snippet2"]);
  });

  it("caps snippets at 3 items", () => {
    const result = createSessionProvenance({
      snippets: ["a", "b", "c", "d", "e"],
    });
    assert.equal(result.snippets.length, 3);
  });
});

// ─── createEvidenceCitation ──────────────────────────────────────────────────

describe("createEvidenceCitation", () => {
  it("creates a valid EvidenceCitation", () => {
    const prov = createCommitProvenance({ commitHash: "abc1234", repo: "work-log" });
    const citation = createEvidenceCitation({
      sourceType: "commits",
      date: "2025-03-15",
      snippet: "feat: add resume chat",
      relevance: 0.85,
      provenance: prov,
    });
    assert.equal(citation.sourceType, "commits");
    assert.equal(citation.date, "2025-03-15");
    assert.equal(citation.snippet, "feat: add resume chat");
    assert.equal(citation.relevance, 0.85);
    assert.equal(citation.provenance.sourceType, "commits");
  });

  it("truncates long snippets", () => {
    const longText = "a".repeat(300);
    const prov = createSlackProvenance({ messageId: "ts", channelId: "C" });
    const citation = createEvidenceCitation({
      sourceType: "slack",
      date: "2025-01-01",
      snippet: longText,
      relevance: 0.5,
      provenance: prov,
    });
    assert.equal(citation.snippet.length, CITATION_SNIPPET_MAX_LENGTH);
    assert.ok(citation.snippet.endsWith("…"));
  });

  it("throws on invalid sourceType", () => {
    assert.throws(
      () => createEvidenceCitation({
        sourceType: "unknown",
        date: "",
        snippet: "",
        relevance: 0,
        provenance: {},
      }),
      /Invalid evidence source type/
    );
  });

  it("clamps relevance to 0–1 range", () => {
    const prov = createSessionProvenance();
    const c1 = createEvidenceCitation({ sourceType: "session", date: "", snippet: "", relevance: -5, provenance: prov });
    assert.equal(c1.relevance, 0);
    const c2 = createEvidenceCitation({ sourceType: "session", date: "", snippet: "", relevance: 99, provenance: prov });
    assert.equal(c2.relevance, 1);
  });
});

// ─── normalizeToEvidenceItem ─────────────────────────────────────────────────

describe("normalizeToEvidenceItem", () => {
  it("normalizes a commit evidence record", () => {
    const record = {
      source: "commits",
      date: "2025-03-15",
      text: "feat: add API",
      relevanceScore: 0.8,
      matchedKeywords: ["API"],
      provenance: {
        sourceType: "commits",
        commitHash: "abc1234",
        repo: "work-log",
        authoredAt: null,
        repoPath: null,
      },
    };
    const item = normalizeToEvidenceItem(record);
    assert.equal(item.source, "commits");
    assert.equal(item.repo, "work-log");
    assert.equal(item.hash, "abc1234");
    assert.equal(item.score, 0.8);
  });

  it("normalizes a slack evidence record", () => {
    const record = {
      source: "slack",
      date: "2025-03-15",
      text: "deployed new feature",
      relevanceScore: 0.6,
      matchedKeywords: [],
      provenance: {
        sourceType: "slack",
        messageId: "ts123",
        channelId: "C01",
        permalink: "https://slack.com/link",
        context: [],
      },
    };
    const item = normalizeToEvidenceItem(record);
    assert.equal(item.source, "slack");
    assert.equal(item.permalink, "https://slack.com/link");
    assert.equal(item.channelId, "C01");
  });

  it("normalizes a session evidence record", () => {
    const record = {
      source: "session",
      date: "2025-03-15",
      text: "refactored auth module",
      relevanceScore: 0.4,
      matchedKeywords: [],
      provenance: {
        sourceType: "session",
        sessionType: "codex",
        filePath: null,
        cwd: null,
        snippets: [],
      },
    };
    const item = normalizeToEvidenceItem(record);
    assert.equal(item.source, "session");
    assert.equal(item.sessionType, "codex");
  });

  it("handles null/undefined input gracefully", () => {
    const item = normalizeToEvidenceItem(null);
    assert.equal(item.source, "commits");
    assert.equal(item.text, "");
    assert.equal(item.score, 0);
  });

  it("handles record without provenance", () => {
    const item = normalizeToEvidenceItem({ source: "commits", date: "2025-01-01", text: "test", relevanceScore: 0.5 });
    assert.equal(item.source, "commits");
    assert.equal(item.score, 0.5);
    assert.equal(item.repo, undefined);
  });
});

// ─── buildEvidenceSummary ────────────────────────────────────────────────────

describe("buildEvidenceSummary", () => {
  it("returns zero counts for null evidence", () => {
    const summary = buildEvidenceSummary(null);
    assert.equal(summary.commitCount, 0);
    assert.equal(summary.slackCount, 0);
    assert.equal(summary.sessionCount, 0);
    assert.equal(summary.totalCount, 0);
    assert.deepStrictEqual(summary.repos, []);
    assert.deepStrictEqual(summary.dateRange, []);
  });

  it("counts records per source correctly", () => {
    const evidence = {
      commits: [
        { source: "commits", date: "2025-03-10", text: "a", provenance: { repo: "work-log" } },
        { source: "commits", date: "2025-03-12", text: "b", provenance: { repo: "other" } },
      ],
      slack: [
        { source: "slack", date: "2025-03-11", text: "c", provenance: {} },
      ],
      sessions: [
        { source: "session", date: "2025-03-13", text: "d", provenance: {} },
        { source: "session", date: "2025-03-14", text: "e", provenance: {} },
      ],
      totalCount: 5,
    };
    const summary = buildEvidenceSummary(evidence);
    assert.equal(summary.commitCount, 2);
    assert.equal(summary.slackCount, 1);
    assert.equal(summary.sessionCount, 2);
    assert.equal(summary.totalCount, 5);
  });

  it("collects unique repo names", () => {
    const evidence = {
      commits: [
        { date: "2025-01-01", provenance: { repo: "work-log" } },
        { date: "2025-01-02", provenance: { repo: "work-log" } },
        { date: "2025-01-03", provenance: { repo: "other" } },
      ],
      slack: [],
      sessions: [],
    };
    const summary = buildEvidenceSummary(evidence);
    assert.deepStrictEqual(summary.repos.sort(), ["other", "work-log"]);
  });

  it("computes date range from all sources", () => {
    const evidence = {
      commits: [{ date: "2025-03-15", provenance: {} }],
      slack: [{ date: "2025-03-10", provenance: {} }],
      sessions: [{ date: "2025-03-20", provenance: {} }],
    };
    const summary = buildEvidenceSummary(evidence);
    assert.deepStrictEqual(summary.dateRange, ["2025-03-10", "2025-03-20"]);
  });

  it("returns single-element dateRange when all dates are the same", () => {
    const evidence = {
      commits: [{ date: "2025-03-15", provenance: {} }],
      slack: [{ date: "2025-03-15", provenance: {} }],
      sessions: [],
    };
    const summary = buildEvidenceSummary(evidence);
    assert.deepStrictEqual(summary.dateRange, ["2025-03-15"]);
  });
});
