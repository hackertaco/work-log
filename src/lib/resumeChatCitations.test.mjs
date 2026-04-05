/**
 * Tests for resumeChatCitations.mjs — 채팅 응답 출처 정보 구성 유틸리티.
 *
 * Run with:
 *   node --test src/lib/resumeChatCitations.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChatCitations,
  buildCitationFromEvidence,
  buildCitationsFromEvidenceResult,
  buildSourceSummary,
} from "./resumeChatCitations.mjs";

// ─── 테스트 픽스처 ───────────────────────────────────────────────────────────

const commitRecord = {
  source: "commits",
  date: "2024-03-01",
  text: "my-project: feat: 프로젝트 기능 추가",
  relevanceScore: 2,
  matchedKeywords: ["프로젝트", "기능"],
  rank: 1,
  rankScore: 3.2,
  provenance: {
    sourceType: "commits",
    commitHash: "abc1234",
    repo: "my-project",
    authoredAt: "2024-03-01T10:00:00+09:00",
    repoPath: "/code/my-project",
  },
};

const slackRecord = {
  source: "slack",
  date: "2024-03-02",
  text: "프로젝트 배포 완료 알림",
  relevanceScore: 1,
  matchedKeywords: ["프로젝트"],
  rank: 2,
  rankScore: 2.5,
  provenance: {
    sourceType: "slack",
    messageId: "1709385600.000100",
    channelId: "C01ABCDEF",
    permalink: "https://myworkspace.slack.com/archives/C01ABCDEF/p1709385600000100",
    context: [],
  },
};

const sessionRecord = {
  source: "session",
  date: "2024-03-03",
  text: "프로젝트 기능 설계 논의 - API 엔드포인트 구조 결정",
  relevanceScore: 1,
  matchedKeywords: ["프로젝트"],
  rank: 3,
  rankScore: 1.8,
  provenance: {
    sourceType: "session",
    sessionType: "claude",
    filePath: "/path/to/session.jsonl",
    cwd: "/code/my-project",
    snippets: ["API 엔드포인트를 RESTful 방식으로 설계했다."],
  },
};

// ─── buildCitationFromEvidence ───────────────────────────────────────────────

describe("buildCitationFromEvidence", () => {
  it("커밋 레코드를 ChatCitation으로 변환한다", () => {
    const citation = buildCitationFromEvidence(commitRecord);

    assert.ok(citation, "citation should not be null");
    assert.equal(citation.source, "commits");
    assert.equal(citation.date, "2024-03-01");
    assert.equal(citation.text, "my-project: feat: 프로젝트 기능 추가");
    assert.equal(citation.rank, 1);
    assert.equal(citation.repo, "my-project");
    assert.equal(citation.hash, "abc1234");
    assert.ok(citation.id.startsWith("cite-commit-"));
    assert.ok(citation.provenance);
    assert.equal(citation.provenance.commitHash, "abc1234");
  });

  it("슬랙 레코드를 ChatCitation으로 변환한다", () => {
    const citation = buildCitationFromEvidence(slackRecord);

    assert.ok(citation);
    assert.equal(citation.source, "slack");
    assert.equal(citation.channelId, "C01ABCDEF");
    assert.equal(citation.permalink, "https://myworkspace.slack.com/archives/C01ABCDEF/p1709385600000100");
    assert.ok(citation.id.startsWith("cite-slack-"));
  });

  it("세션 레코드를 ChatCitation으로 변환한다", () => {
    const citation = buildCitationFromEvidence(sessionRecord);

    assert.ok(citation);
    assert.equal(citation.source, "session");
    assert.equal(citation.sessionType, "claude");
    assert.ok(citation.id.startsWith("cite-session-"));
  });

  it("source가 'sessions' (복수형)이면 'session' (단수형)으로 정규화한다", () => {
    const record = { ...sessionRecord, source: "sessions" };
    const citation = buildCitationFromEvidence(record);

    assert.ok(citation);
    assert.equal(citation.source, "session");
  });

  it("긴 텍스트를 200자로 잘라낸다", () => {
    const longText = "가".repeat(300);
    const record = { ...commitRecord, text: longText };
    const citation = buildCitationFromEvidence(record);

    assert.ok(citation);
    assert.ok(citation.text.length <= 200);
    assert.ok(citation.text.endsWith("…"));
  });

  it("null 또는 잘못된 입력에 대해 null을 반환한다", () => {
    assert.equal(buildCitationFromEvidence(null), null);
    assert.equal(buildCitationFromEvidence(undefined), null);
    assert.equal(buildCitationFromEvidence("string"), null);
    assert.equal(buildCitationFromEvidence({ source: "unknown" }), null);
  });

  it("provenance가 없어도 기본 citation을 생성한다", () => {
    const record = { source: "commits", date: "2024-01-01", text: "test commit" };
    const citation = buildCitationFromEvidence(record);

    assert.ok(citation);
    assert.equal(citation.source, "commits");
    assert.equal(citation.provenance, null);
    assert.equal(citation.repo, undefined);
  });

  it("relevance 점수를 0.0–1.0 범위로 정규화한다", () => {
    const citation = buildCitationFromEvidence(commitRecord);
    assert.ok(citation);
    assert.ok(citation.relevance >= 0 && citation.relevance <= 1);
  });
});

// ─── buildChatCitations ─────────────────────────────────────────────────────

describe("buildChatCitations", () => {
  it("랭킹된 근거를 ChatCitation[]으로 변환한다", () => {
    const ranked = [commitRecord, slackRecord, sessionRecord];
    const citations = buildChatCitations(ranked);

    assert.equal(citations.length, 3);
    assert.equal(citations[0].source, "commits");
    assert.equal(citations[0].rank, 1);
    assert.equal(citations[1].source, "slack");
    assert.equal(citations[2].source, "session");
  });

  it("중복 레코드를 제거한다", () => {
    const ranked = [commitRecord, commitRecord, slackRecord];
    const citations = buildChatCitations(ranked);

    assert.equal(citations.length, 2);
  });

  it("어필 포인트의 sourceRefs에서 추가 citation을 포함한다", () => {
    const ranked = [commitRecord];
    const appealPoints = {
      appealPoints: [
        {
          sourceRefs: [slackRecord, sessionRecord],
        },
      ],
    };
    const citations = buildChatCitations(ranked, appealPoints);

    assert.equal(citations.length, 3);
    // 커밋은 ranked에서, 슬랙과 세션은 sourceRefs에서 가져옴
    const sources = citations.map((c) => c.source);
    assert.ok(sources.includes("commits"));
    assert.ok(sources.includes("slack"));
    assert.ok(sources.includes("session"));
  });

  it("maxCitations 옵션으로 결과 수를 제한한다", () => {
    const ranked = [commitRecord, slackRecord, sessionRecord];
    const citations = buildChatCitations(ranked, null, { maxCitations: 2 });

    assert.equal(citations.length, 2);
  });

  it("빈 배열에서 빈 결과를 반환한다", () => {
    assert.deepEqual(buildChatCitations([]), []);
    assert.deepEqual(buildChatCitations(null), []);
  });

  it("rank 오름차순으로 정렬한다 (unranked=0은 뒤로)", () => {
    const unranked = { ...commitRecord, rank: 0, text: "unranked item" };
    const ranked = [unranked, slackRecord, commitRecord];
    const citations = buildChatCitations(ranked);

    assert.equal(citations[0].rank, 1); // commitRecord
    assert.equal(citations[1].rank, 2); // slackRecord
    assert.equal(citations[2].rank, 0); // unranked → 뒤로
  });
});

// ─── buildCitationsFromEvidenceResult ────────────────────────────────────────

describe("buildCitationsFromEvidenceResult", () => {
  it("ChatEvidenceResult를 직접 ChatCitation[]으로 변환한다", () => {
    const evidenceResult = {
      commits: [commitRecord],
      slack: [slackRecord],
      sessions: [sessionRecord],
      totalCount: 3,
    };
    const citations = buildCitationsFromEvidenceResult(evidenceResult);

    assert.equal(citations.length, 3);
    // relevanceScore 내림차순 정렬: commitRecord(2) > slackRecord(1) = sessionRecord(1)
    assert.equal(citations[0].source, "commits");
  });

  it("null 입력에 빈 배열을 반환한다", () => {
    assert.deepEqual(buildCitationsFromEvidenceResult(null), []);
  });

  it("비어있는 결과에 빈 배열을 반환한다", () => {
    const evidenceResult = { commits: [], slack: [], sessions: [], totalCount: 0 };
    assert.deepEqual(buildCitationsFromEvidenceResult(evidenceResult), []);
  });
});

// ─── buildSourceSummary ──────────────────────────────────────────────────────

describe("buildSourceSummary", () => {
  it("소스별 건수 요약을 정확히 생성한다", () => {
    const citations = [
      buildCitationFromEvidence(commitRecord),
      buildCitationFromEvidence(slackRecord),
      buildCitationFromEvidence(sessionRecord),
    ];
    const summary = buildSourceSummary(citations);

    assert.equal(summary.commits, 1);
    assert.equal(summary.slack, 1);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.repos, ["my-project"]);
    assert.equal(summary.dateRange.length, 2);
    assert.equal(summary.dateRange[0], "2024-03-01");
    assert.equal(summary.dateRange[1], "2024-03-03");
  });

  it("빈 배열에서 기본 요약을 반환한다", () => {
    const summary = buildSourceSummary([]);

    assert.equal(summary.total, 0);
    assert.deepEqual(summary.repos, []);
    assert.deepEqual(summary.dateRange, []);
  });

  it("null 입력에서 기본 요약을 반환한다", () => {
    const summary = buildSourceSummary(null);
    assert.equal(summary.total, 0);
  });

  it("같은 날짜만 있으면 dateRange가 1개 요소", () => {
    const citations = [
      buildCitationFromEvidence(commitRecord),
      buildCitationFromEvidence({ ...slackRecord, date: "2024-03-01" }),
    ];
    const summary = buildSourceSummary(citations);

    assert.equal(summary.dateRange.length, 1);
    assert.equal(summary.dateRange[0], "2024-03-01");
  });

  it("여러 repo를 중복 없이 수집한다", () => {
    const commit2 = {
      ...commitRecord,
      text: "other-repo: fix: 버그 수정",
      provenance: { ...commitRecord.provenance, repo: "other-repo", commitHash: "def5678" },
    };
    const citations = [
      buildCitationFromEvidence(commitRecord),
      buildCitationFromEvidence(commit2),
    ];
    const summary = buildSourceSummary(citations);

    assert.equal(summary.repos.length, 2);
    assert.ok(summary.repos.includes("my-project"));
    assert.ok(summary.repos.includes("other-repo"));
  });
});
