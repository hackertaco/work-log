/**
 * Tests for resumeAppealPoints.mjs (Sub-AC 3-3, Sub-AC 4-1)
 *
 * 검색 결과 통합·랭킹 및 어필 포인트 생성 기능을 검증한다.
 *
 * Covers:
 *   mergeAndRankEvidence — 세 소스 병합·랭킹 로직
 *   buildEvidenceContext — LLM 프롬프트용 근거 텍스트 빌더 (rank 인덱스 + provenance 힌트 포함)
 *   generateAppealPoints — 어필 포인트 생성 (heuristic + LLM mock)
 *   sourceRefs           — AppealPoint 출처 메타데이터 역참조 (Sub-AC 4-1)
 *   inferCategory        — 어필 포인트 카테고리 추론 (achievement/contribution/capability)
 *   generateAppealPointsFromExploreResult — 탐색→추천 편의 함수
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/lib/resumeAppealPoints.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeAndRankEvidence,
  buildEvidenceContext,
  generateAppealPoints,
  inferCategory,
  generateAppealPointsFromExploreResult,
} from "./resumeAppealPoints.mjs";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const COMMIT_RECORD = {
  source: "commits",
  date: "2024-03-15",
  text: "my-repo: feat: add CI/CD pipeline for faster deployments",
  relevanceScore: 2,
  metadata: { repo: "my-repo", hash: "abc1234" },
};

const SLACK_RECORD = {
  source: "slack",
  date: "2024-03-14",
  text: "배포 자동화 완료, 팀 전체 공유했습니다",
  relevanceScore: 1,
  metadata: { channelId: "C001", ts: "1710000000.000" },
};

const SESSION_RECORD = {
  source: "session",
  date: "2024-03-13",
  text: "CI/CD 파이프라인 설계 검토 중 — GitHub Actions 활용",
  relevanceScore: 2,
  metadata: { sessionSource: "claude", cwd: "/project" },
};

// Sub-AC 4-1: provenance 필드가 포함된 픽스처 (실제 evidenceSearch 어댑터 출력 형태)
const COMMIT_RECORD_WITH_PROVENANCE = {
  source: "commits",
  date: "2024-03-15",
  text: "my-repo: feat: add CI/CD pipeline for faster deployments",
  relevanceScore: 2,
  matchedKeywords: ["CI/CD", "pipeline"],
  provenance: {
    sourceType: "commits",
    commitHash: "abc1234",
    repo: "my-repo",
    authoredAt: "2024-03-15T10:00:00+09:00",
    repoPath: "/code/my-repo",
  },
};

const SLACK_RECORD_WITH_PROVENANCE = {
  source: "slack",
  date: "2024-03-14",
  text: "배포 자동화 완료, 팀 전체 공유했습니다",
  relevanceScore: 1,
  matchedKeywords: ["배포"],
  provenance: {
    sourceType: "slack",
    messageId: "1710000000.000",
    channelId: "C001",
    permalink: "https://workspace.slack.com/archives/C001/p1710000000",
    context: ["이전 메시지"],
  },
};

const SESSION_RECORD_WITH_PROVENANCE = {
  source: "session",
  date: "2024-03-13",
  text: "CI/CD 파이프라인 설계 검토 중 — GitHub Actions 활용",
  relevanceScore: 2,
  matchedKeywords: ["CI/CD"],
  provenance: {
    sourceType: "session",
    sessionType: "claude",
    filePath: "/path/to/session.jsonl",
    cwd: "/code/my-repo",
    snippets: ["GitHub Actions 설정 검토", "워크플로 YAML 작성"],
  },
};

const EVIDENCE_RESULT = {
  commits: [COMMIT_RECORD],
  slack: [SLACK_RECORD],
  sessions: [SESSION_RECORD],
  totalCount: 3,
};

// ─── mergeAndRankEvidence ─────────────────────────────────────────────────────

test("mergeAndRankEvidence - 세 소스를 하나의 배열로 병합한다", () => {
  const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);

  assert.ok(Array.isArray(ranked), "결과는 배열이어야 한다");
  assert.equal(ranked.length, 3, "세 소스의 레코드가 모두 포함되어야 한다");
});

test("mergeAndRankEvidence - 각 레코드에 rank 와 rankScore 가 포함된다", () => {
  const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);

  for (const r of ranked) {
    assert.ok(typeof r.rank === "number", "rank 는 숫자여야 한다");
    assert.ok(r.rank >= 1, "rank 는 1 이상이어야 한다");
    assert.ok(typeof r.rankScore === "number", "rankScore 는 숫자여야 한다");
    assert.ok(r.rankScore >= 0, "rankScore 는 0 이상이어야 한다");
  }
});

test("mergeAndRankEvidence - rank 는 1 부터 시작하며 오름차순으로 할당된다", () => {
  const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
  const ranks = ranked.map((r) => r.rank);

  assert.equal(ranks[0], 1, "첫 번째 rank 는 1이어야 한다");
  for (let i = 1; i < ranks.length; i++) {
    assert.equal(ranks[i], i + 1, `rank[${i}] 는 ${i + 1} 이어야 한다`);
  }
});

test("mergeAndRankEvidence - relevanceScore 가 높은 레코드가 더 높은 순위를 받는다", () => {
  const highScore = {
    source: "commits",
    date: "2024-03-10",
    text: "high score commit",
    relevanceScore: 5,
    metadata: {},
  };
  const lowScore = {
    source: "commits",
    date: "2024-03-10",
    text: "low score commit",
    relevanceScore: 1,
    metadata: {},
  };

  const ranked = mergeAndRankEvidence({
    commits: [lowScore, highScore],
    slack: [],
    sessions: [],
    totalCount: 2,
  });

  assert.equal(ranked[0].text, "high score commit", "높은 점수가 먼저 와야 한다");
});

test("mergeAndRankEvidence - topN 옵션으로 결과 수를 제한한다", () => {
  const commits = Array.from({ length: 10 }, (_, i) => ({
    source: "commits",
    date: `2024-03-${String(i + 1).padStart(2, "0")}`,
    text: `commit ${i}`,
    relevanceScore: i,
    metadata: {},
  }));

  const ranked = mergeAndRankEvidence(
    { commits, slack: [], sessions: [], totalCount: 10 },
    { topN: 5 }
  );

  assert.equal(ranked.length, 5, "topN=5 이면 결과가 5건이어야 한다");
});

test("mergeAndRankEvidence - 빈 결과일 때 빈 배열을 반환한다", () => {
  const ranked = mergeAndRankEvidence({
    commits: [],
    slack: [],
    sessions: [],
    totalCount: 0,
  });

  assert.deepEqual(ranked, [], "모든 소스가 비어 있으면 빈 배열 반환");
});

test("mergeAndRankEvidence - 소스 다양성 보너스로 각 소스의 대표 레코드가 포함된다", () => {
  // 커밋만 점수가 높고 슬랙/세션은 점수가 낮더라도 각 소스가 상위에 있어야 한다
  const highCommit = {
    source: "commits",
    date: "2024-03-15",
    text: "high commit",
    relevanceScore: 10,
    metadata: {},
  };
  const lowSlack = {
    source: "slack",
    date: "2024-03-01",
    text: "low slack",
    relevanceScore: 1,
    metadata: {},
  };
  const lowSession = {
    source: "session",
    date: "2024-03-01",
    text: "low session",
    relevanceScore: 1,
    metadata: {},
  };

  const ranked = mergeAndRankEvidence({
    commits: [highCommit],
    slack: [lowSlack],
    sessions: [lowSession],
    totalCount: 3,
  });

  const sources = ranked.map((r) => r.source);
  assert.ok(sources.includes("commits"), "커밋 소스가 포함되어야 한다");
  assert.ok(sources.includes("slack") || sources.includes("session"),
    "슬랙 또는 세션 소스가 포함되어야 한다");
});

test("mergeAndRankEvidence - sessions 키 (searchAllSources 출력)를 허용한다", () => {
  // searchAllSources 는 sessions 키(복수)를 반환함
  const ranked = mergeAndRankEvidence({
    commits: [COMMIT_RECORD],
    slack: [SLACK_RECORD],
    sessions: [SESSION_RECORD],  // sessions 키
    totalCount: 3,
  });

  assert.equal(ranked.length, 3, "sessions 키로 전달된 레코드가 포함되어야 한다");
});

// ─── buildEvidenceContext ─────────────────────────────────────────────────────

test("buildEvidenceContext - 랭킹된 근거를 텍스트 블록으로 변환한다", () => {
  const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
  const context = buildEvidenceContext(ranked);

  assert.ok(typeof context === "string", "결과는 문자열이어야 한다");
  assert.ok(context.length > 0, "결과는 비어 있으면 안 된다");
  // 소스 레이블 확인
  assert.ok(context.includes("[커밋]") || context.includes("[슬랙]") || context.includes("[세션]"),
    "소스 레이블이 포함되어야 한다");
});

test("buildEvidenceContext - 각 줄에 날짜와 텍스트가 포함된다", () => {
  const records = [
    {
      ...COMMIT_RECORD,
      rank: 1,
      rankScore: 2.5,
    },
  ];
  const context = buildEvidenceContext(records);
  const lines = context.split("\n");

  assert.ok(lines.length >= 1, "최소 한 줄이 있어야 한다");
  assert.ok(lines[0].includes("2024-03-15"), "날짜가 포함되어야 한다");
  assert.ok(lines[0].includes("feat: add CI/CD"), "텍스트가 포함되어야 한다");
});

test("buildEvidenceContext - maxChars 제한을 초과하면 잘라낸다", () => {
  const manyRecords = Array.from({ length: 100 }, (_, i) => ({
    source: "commits",
    date: `2024-03-${String((i % 28) + 1).padStart(2, "0")}`,
    text: `commit message ${i} `.repeat(10),
    relevanceScore: 1,
    metadata: {},
    rank: i + 1,
    rankScore: 1,
  }));

  const maxChars = 500;
  const context = buildEvidenceContext(manyRecords, maxChars);

  assert.ok(context.length <= maxChars + 50, `결과가 maxChars(${maxChars}) 근처여야 한다`);
});

test("buildEvidenceContext - 빈 배열이면 빈 문자열을 반환한다", () => {
  assert.equal(buildEvidenceContext([]), "", "빈 배열이면 빈 문자열 반환");
  assert.equal(buildEvidenceContext(null), "", "null 이면 빈 문자열 반환");
});

// ─── generateAppealPoints (heuristic — WORK_LOG_DISABLE_OPENAI=1) ────────────

test("generateAppealPoints - OpenAI 비활성 시 heuristic fallback 결과를 반환한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
    const result = await generateAppealPoints("2024년 CI/CD 작업 찾아줘", ranked);

    assert.ok(result, "결과가 있어야 한다");
    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
    assert.ok(Array.isArray(result.dataGaps), "dataGaps 는 배열이어야 한다");
    assert.ok(Array.isArray(result.followUpQuestions), "followUpQuestions 는 배열이어야 한다");
    assert.ok(Array.isArray(result.evidenceUsed), "evidenceUsed 는 배열이어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints - heuristic fallback 시 appealPoints 에 id 필드가 있다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
    const result = await generateAppealPoints("CI/CD 찾아줘", ranked);

    for (const ap of result.appealPoints) {
      assert.ok(typeof ap.id === "string", "id 는 문자열이어야 한다");
      assert.ok(ap.id.startsWith("ap-"), "id 는 'ap-' 로 시작해야 한다");
      assert.ok(typeof ap.title === "string", "title 은 문자열이어야 한다");
      assert.ok(typeof ap.description === "string", "description 은 문자열이어야 한다");
      assert.ok(Array.isArray(ap.evidenceTexts), "evidenceTexts 는 배열이어야 한다");
      assert.ok(typeof ap.confidence === "number", "confidence 는 숫자여야 한다");
      assert.ok(ap.confidence >= 0 && ap.confidence <= 1, "confidence 는 0–1 범위여야 한다");
    }
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints - 근거 없을 때 followUpQuestions 를 반환한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const result = await generateAppealPoints("프로젝트 찾아줘", []);

    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
    assert.equal(result.appealPoints.length, 0, "근거 없으면 어필 포인트도 없어야 한다");
    assert.ok(result.followUpQuestions.length > 0, "보충 질문이 있어야 한다");
    assert.ok(result.dataGaps.length > 0, "데이터 갭이 있어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints - null evidence 일 때 에러 없이 처리된다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const result = await generateAppealPoints("질의", null);

    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
    assert.equal(result.appealPoints.length, 0, "null evidence 면 어필 포인트 없어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints - maxPoints 옵션으로 어필 포인트 수를 제한한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const manyRecords = Array.from({ length: 20 }, (_, i) => ({
      source: "commits",
      date: `2024-03-${String((i % 28) + 1).padStart(2, "0")}`,
      text: `commit ${i}`,
      relevanceScore: 1,
      metadata: {},
      rank: i + 1,
      rankScore: 1,
    }));

    const result = await generateAppealPoints("찾아줘", manyRecords, { maxPoints: 3 });

    assert.ok(result.appealPoints.length <= 3,
      "maxPoints=3 이면 어필 포인트가 3개 이하여야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

// ─── 통합: mergeAndRankEvidence → buildEvidenceContext → generateAppealPoints ──

test("통합 파이프라인: 검색 결과 병합 → 근거 컨텍스트 생성 → 어필 포인트 생성", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    // Step 1: 병합·랭킹
    const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
    assert.ok(ranked.length > 0, "랭킹된 근거가 있어야 한다");

    // Step 2: 근거 컨텍스트 생성
    const context = buildEvidenceContext(ranked);
    assert.ok(context.length > 0, "근거 컨텍스트가 있어야 한다");

    // Step 3: 어필 포인트 생성
    const result = await generateAppealPoints("CI/CD 관련 어필 포인트 찾아줘", ranked);
    assert.ok(result, "결과가 있어야 한다");
    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
    assert.ok(Array.isArray(result.evidenceUsed), "evidenceUsed 는 배열이어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("통합 파이프라인: 단일 소스(커밋만)에서도 정상 동작한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const commitsOnly = {
      commits: [COMMIT_RECORD],
      slack: [],
      sessions: [],
      totalCount: 1,
    };

    const ranked = mergeAndRankEvidence(commitsOnly);
    assert.equal(ranked.length, 1, "커밋만 있으면 1건이어야 한다");

    const result = await generateAppealPoints("커밋 찾아줘", ranked);
    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

// ─── Sub-AC 4-1: buildEvidenceContext rank 인덱스 및 provenance 힌트 ─────────

test("buildEvidenceContext (Sub-AC 4-1) - 각 줄에 [N] rank 인덱스가 포함된다", () => {
  const records = [
    { ...COMMIT_RECORD_WITH_PROVENANCE, rank: 1, rankScore: 3.0 },
    { ...SLACK_RECORD_WITH_PROVENANCE,  rank: 2, rankScore: 1.5 },
  ];

  const context = buildEvidenceContext(records);
  const lines = context.split("\n");

  assert.ok(lines[0].includes("[1]"), "첫 번째 줄에 [1] rank 인덱스가 있어야 한다");
  assert.ok(lines[1].includes("[2]"), "두 번째 줄에 [2] rank 인덱스가 있어야 한다");
});

test("buildEvidenceContext (Sub-AC 4-1) - 커밋 레코드에 hash와 repo 힌트가 포함된다", () => {
  const records = [
    { ...COMMIT_RECORD_WITH_PROVENANCE, rank: 1, rankScore: 3.0 },
  ];

  const context = buildEvidenceContext(records);

  assert.ok(context.includes("hash:abc1234"), "커밋 해시 힌트가 포함되어야 한다");
  assert.ok(context.includes("repo:my-repo"), "레포 이름 힌트가 포함되어야 한다");
});

test("buildEvidenceContext (Sub-AC 4-1) - 슬랙 레코드에 messageId와 channelId 힌트가 포함된다", () => {
  const records = [
    { ...SLACK_RECORD_WITH_PROVENANCE, rank: 1, rankScore: 2.0 },
  ];

  const context = buildEvidenceContext(records);

  assert.ok(context.includes("msgId:1710000000.000"), "슬랙 메시지 ID 힌트가 포함되어야 한다");
  assert.ok(context.includes("ch:C001"), "슬랙 채널 ID 힌트가 포함되어야 한다");
});

test("buildEvidenceContext (Sub-AC 4-1) - 세션 레코드에 sessionType 힌트가 포함된다", () => {
  const records = [
    { ...SESSION_RECORD_WITH_PROVENANCE, rank: 1, rankScore: 2.5 },
  ];

  const context = buildEvidenceContext(records);

  assert.ok(context.includes("tool:claude"), "세션 툴 타입 힌트가 포함되어야 한다");
});

test("buildEvidenceContext (Sub-AC 4-1) - provenance 없는 레코드는 힌트 없이 처리된다", () => {
  const records = [
    {
      source: "commits",
      date: "2024-03-15",
      text: "plain commit without provenance",
      relevanceScore: 1,
      rank: 1,
      rankScore: 1.0,
      // provenance 없음
    },
  ];

  // 오류 없이 실행되어야 한다
  const context = buildEvidenceContext(records);

  assert.ok(typeof context === "string", "결과는 문자열이어야 한다");
  assert.ok(context.includes("[1]"), "[1] rank 인덱스는 있어야 한다");
  assert.ok(!context.includes("hash:"), "provenance 없으면 hash 힌트가 없어야 한다");
});

// ─── Sub-AC 4-1: heuristic 모드 sourceRefs ────────────────────────────────────

test("generateAppealPoints (Sub-AC 4-1) - heuristic 모드에서 sourceRefs 가 배열로 포함된다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const evidenceResult = {
      commits: [COMMIT_RECORD_WITH_PROVENANCE],
      slack: [SLACK_RECORD_WITH_PROVENANCE],
      sessions: [SESSION_RECORD_WITH_PROVENANCE],
      totalCount: 3,
    };

    const ranked = mergeAndRankEvidence(evidenceResult);
    const result = await generateAppealPoints("CI/CD 찾아줘", ranked);

    for (const ap of result.appealPoints) {
      assert.ok(
        Array.isArray(ap.sourceRefs),
        `ap.sourceRefs 는 배열이어야 한다 (ap.id=${ap.id})`
      );
    }
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints (Sub-AC 4-1) - heuristic 모드에서 sourceRefs 가 비어 있지 않다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const evidenceResult = {
      commits: [COMMIT_RECORD_WITH_PROVENANCE],
      slack: [],
      sessions: [],
      totalCount: 1,
    };

    const ranked = mergeAndRankEvidence(evidenceResult);
    const result = await generateAppealPoints("커밋 찾아줘", ranked);

    assert.ok(result.appealPoints.length > 0, "어필 포인트가 있어야 한다");
    assert.ok(
      result.appealPoints[0].sourceRefs.length > 0,
      "첫 번째 어필 포인트에 sourceRefs 가 있어야 한다"
    );
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints (Sub-AC 4-1) - sourceRef 에 source, date, text, rank, provenance 가 있다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const evidenceResult = {
      commits: [COMMIT_RECORD_WITH_PROVENANCE],
      slack: [],
      sessions: [],
      totalCount: 1,
    };

    const ranked = mergeAndRankEvidence(evidenceResult);
    const result = await generateAppealPoints("커밋 찾아줘", ranked);

    const firstRef = result.appealPoints[0]?.sourceRefs?.[0];
    assert.ok(firstRef, "첫 번째 sourceRef 가 있어야 한다");
    assert.ok(
      typeof firstRef.source === "string",
      "sourceRef.source 는 문자열이어야 한다"
    );
    assert.ok(
      typeof firstRef.date === "string",
      "sourceRef.date 는 문자열이어야 한다"
    );
    assert.ok(
      typeof firstRef.text === "string",
      "sourceRef.text 는 문자열이어야 한다"
    );
    assert.ok(
      typeof firstRef.rank === "number",
      "sourceRef.rank 는 숫자여야 한다"
    );
    // provenance 는 커밋이므로 commitHash 가 있어야 한다
    assert.ok(firstRef.provenance, "sourceRef.provenance 가 있어야 한다");
    assert.equal(
      firstRef.provenance?.commitHash,
      "abc1234",
      "sourceRef.provenance.commitHash 가 'abc1234' 이어야 한다"
    );
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints (Sub-AC 4-1) - 슬랙 소스 sourceRef 에 messageId 와 channelId 가 있다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const evidenceResult = {
      commits: [],
      slack: [SLACK_RECORD_WITH_PROVENANCE],
      sessions: [],
      totalCount: 1,
    };

    const ranked = mergeAndRankEvidence(evidenceResult);
    const result = await generateAppealPoints("슬랙 찾아줘", ranked);

    assert.ok(result.appealPoints.length > 0, "어필 포인트가 있어야 한다");

    const slackRef = result.appealPoints[0]?.sourceRefs?.find(
      (r) => r.source === "slack"
    );
    assert.ok(slackRef, "슬랙 sourceRef 가 있어야 한다");
    assert.equal(
      slackRef.provenance?.messageId,
      "1710000000.000",
      "슬랙 messageId 가 맞아야 한다"
    );
    assert.equal(
      slackRef.provenance?.channelId,
      "C001",
      "슬랙 channelId 가 맞아야 한다"
    );
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints (Sub-AC 4-1) - 세션 sourceRef 에 sessionType 이 있다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const evidenceResult = {
      commits: [],
      slack: [],
      sessions: [SESSION_RECORD_WITH_PROVENANCE],
      totalCount: 1,
    };

    const ranked = mergeAndRankEvidence(evidenceResult);
    const result = await generateAppealPoints("세션 찾아줘", ranked);

    assert.ok(result.appealPoints.length > 0, "어필 포인트가 있어야 한다");

    const sessionRef = result.appealPoints[0]?.sourceRefs?.find(
      (r) => r.source === "session" || r.source === "sessions"
    );
    assert.ok(sessionRef, "세션 sourceRef 가 있어야 한다");
    assert.equal(
      sessionRef.provenance?.sessionType,
      "claude",
      "세션 sessionType 이 'claude' 이어야 한다"
    );
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

// ─── inferCategory (카테고리 추론) ──────────────────────────────────────────────

test("inferCategory - 성과 관련 텍스트에서 achievement 를 반환한다", () => {
  assert.equal(
    inferCategory("배포 자동화로 배포 주기를 50% 단축", "배포 자동화 개선"),
    "achievement"
  );
  assert.equal(
    inferCategory("API 응답 속도 30% 향상, 안정성 개선", "성능 최적화"),
    "achievement"
  );
  assert.equal(
    inferCategory("critical bug fix for production", "Bug Resolution"),
    "achievement"
  );
});

test("inferCategory - 기여 관련 텍스트에서 contribution 을 반환한다", () => {
  assert.equal(
    inferCategory("코드 리뷰 가이드 문서화하여 팀 전체에 공유", "코드 리뷰 프로세스"),
    "contribution"
  );
  assert.equal(
    inferCategory("신규 입사자 온보딩 자료 작성 및 멘토링 수행", "팀 온보딩"),
    "contribution"
  );
});

test("inferCategory - 역량 관련 텍스트에서 capability 를 반환한다", () => {
  assert.equal(
    inferCategory("마이크로서비스 아키텍처 설계 및 패턴 적용", "시스템 설계"),
    "capability"
  );
  assert.equal(
    inferCategory("복잡한 시스템 분석 및 진단 전략 수립", "기술 분석"),
    "capability"
  );
});

test("inferCategory - 혼합된 텍스트에서 가장 적합한 카테고리를 선택한다", () => {
  // 수치가 포함되면 achievement 가 우선
  const result = inferCategory("팀 프로세스 개선으로 배포 시간 40% 단축", "");
  assert.equal(result, "achievement", "수치+개선 조합은 achievement 가 우선");
});

test("inferCategory - 빈 텍스트에서 achievement 를 기본값으로 반환한다", () => {
  const result = inferCategory("", "");
  // 모든 점수가 0이면 첫 번째 조건(achievement >= others)이 참이므로 achievement
  assert.equal(result, "achievement");
});

// ─── category 필드 통합 테스트 ──────────────────────────────────────────────────

test("generateAppealPoints - heuristic 모드에서 category 필드가 포함된다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const ranked = mergeAndRankEvidence(EVIDENCE_RESULT);
    const result = await generateAppealPoints("CI/CD 찾아줘", ranked);

    for (const ap of result.appealPoints) {
      assert.ok(
        ["achievement", "contribution", "capability"].includes(ap.category),
        `category 는 유효한 값이어야 한다 (got: ${ap.category})`
      );
    }
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPoints - 배포 관련 커밋은 achievement 카테고리를 받는다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const deployRecord = {
      source: "commits",
      date: "2024-03-15",
      text: "feat: 배포 파이프라인 구축하여 배포 시간 단축",
      relevanceScore: 2,
      metadata: {},
    };

    const ranked = mergeAndRankEvidence({
      commits: [deployRecord],
      slack: [],
      sessions: [],
      totalCount: 1,
    });
    const result = await generateAppealPoints("배포 찾아줘", ranked);

    assert.ok(result.appealPoints.length > 0, "어필 포인트가 있어야 한다");
    assert.equal(
      result.appealPoints[0].category,
      "achievement",
      "배포 관련은 achievement 이어야 한다"
    );
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

// ─── generateAppealPointsFromExploreResult 편의 함수 ─────────────────────────────

test("generateAppealPointsFromExploreResult - exploreResult 에서 직접 어필 포인트를 생성한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const exploreResult = {
      commits: [COMMIT_RECORD],
      slack: [SLACK_RECORD],
      sessions: [SESSION_RECORD],
      totalCount: 3,
      sourceMeta: {
        commits: { searched: true, resultCount: 1, keywords: ["CI/CD"] },
        slack: { searched: true, resultCount: 1, keywords: ["배포"] },
        sessions: { searched: true, resultCount: 1, keywords: ["CI/CD"] },
      },
    };

    const result = await generateAppealPointsFromExploreResult(
      "CI/CD 관련 어필 포인트",
      exploreResult
    );

    assert.ok(result, "결과가 있어야 한다");
    assert.ok(Array.isArray(result.appealPoints), "appealPoints 는 배열이어야 한다");
    assert.ok(Array.isArray(result.rankedEvidence), "rankedEvidence 도 반환되어야 한다");
    assert.ok(result.rankedEvidence.length > 0, "랭킹된 근거가 있어야 한다");
    assert.ok(Array.isArray(result.dataGaps), "dataGaps 는 배열이어야 한다");
    assert.ok(Array.isArray(result.followUpQuestions), "followUpQuestions 는 배열이어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPointsFromExploreResult - topN 옵션을 전달할 수 있다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const manyCommits = Array.from({ length: 20 }, (_, i) => ({
      source: "commits",
      date: `2024-03-${String((i % 28) + 1).padStart(2, "0")}`,
      text: `commit ${i}: feat: feature implementation`,
      relevanceScore: i,
      metadata: {},
    }));

    const exploreResult = {
      commits: manyCommits,
      slack: [],
      sessions: [],
      totalCount: 20,
    };

    const result = await generateAppealPointsFromExploreResult(
      "기능 구현",
      exploreResult,
      { topN: 5, maxPoints: 3 }
    );

    assert.ok(result.rankedEvidence.length <= 5, "topN=5 이면 랭킹 결과가 5건 이하");
    assert.ok(result.appealPoints.length <= 3, "maxPoints=3 이면 어필 포인트가 3건 이하");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});

test("generateAppealPointsFromExploreResult - 빈 탐색 결과에서 안전하게 동작한다", async () => {
  const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  process.env.WORK_LOG_DISABLE_OPENAI = "1";

  try {
    const emptyResult = {
      commits: [],
      slack: [],
      sessions: [],
      totalCount: 0,
    };

    const result = await generateAppealPointsFromExploreResult("아무거나", emptyResult);

    assert.ok(result, "결과가 있어야 한다");
    assert.equal(result.appealPoints.length, 0, "근거 없으면 어필 포인트 없어야 한다");
    assert.ok(result.followUpQuestions.length > 0, "보충 질문이 있어야 한다");
    assert.deepEqual(result.rankedEvidence, [], "랭킹된 근거도 빈 배열이어야 한다");
  } finally {
    if (origDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  }
});
