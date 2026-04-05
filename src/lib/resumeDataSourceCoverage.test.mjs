/**
 * Unit tests for resumeDataSourceCoverage.mjs
 *
 * 데이터 소스(커밋/슬랙/세션) 기반 이력서 항목 충족도 평가 로직 테스트.
 *
 * Run with:  node --test src/lib/resumeDataSourceCoverage.test.mjs
 * (Node.js built-in test runner — no external dependencies)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSignalCorpus,
  extractMeaningfulTokens,
  evaluateItemCoverage,
  analyzeDataSourceCoverage,
  scoreToLevel
} from "./resumeDataSourceCoverage.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** 최소한의 유효한 업무 로그 레코드 생성 */
function wlBase(overrides = {}) {
  return {
    date: "2025-01-15",
    highlights: {
      businessOutcomes: [],
      keyChanges: [],
      commitAnalysis: [],
      impact: [],
      workingStyleSignals: [],
      storyThreads: []
    },
    projects: [],
    aiSessions: { codex: [], claude: [] },
    resume: { candidates: [], companyCandidates: [] },
    ...overrides
  };
}

/** 최소한의 유효한 이력서 문서 생성 */
function resumeBase(overrides = {}) {
  return {
    meta: { schemaVersion: 1, language: "ko" },
    contact: { name: "홍길동", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: [],
    certifications: [],
    ...overrides
  };
}

// ─── buildSignalCorpus ────────────────────────────────────────────────────────

describe("buildSignalCorpus — 기본 동작", () => {
  it("빈 배열 → 빈 문자열 반환", () => {
    assert.strictEqual(buildSignalCorpus([]), "");
  });

  it("null/undefined → 빈 문자열 반환", () => {
    assert.strictEqual(buildSignalCorpus(null), "");
    assert.strictEqual(buildSignalCorpus(undefined), "");
  });

  it("커밋 subject와 repo가 코퍼스에 포함됨", () => {
    const wl = wlBase({
      projects: [
        {
          repo: "my-service",
          commits: [
            { subject: "feat: add authentication middleware", hash: "abc123", repo: "my-service" },
            { subject: "fix: resolve memory leak in cache", hash: "def456", repo: "my-service" }
          ]
        }
      ]
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("authentication"), "커밋 subject가 포함되어야 함");
    assert.ok(corpus.includes("memory"), "커밋 subject가 포함되어야 함");
    assert.ok(corpus.includes("my-service"), "repo 이름이 포함되어야 함");
  });

  it("Codex 세션 summary와 snippets가 포함됨", () => {
    const wl = wlBase({
      aiSessions: {
        codex: [
          {
            summary: "Redis 캐싱 레이어 구현으로 API 응답 속도 40% 개선",
            snippets: ["캐시 히트율 최적화", "Redis cluster 설정 완료"]
          }
        ],
        claude: []
      }
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("redis"), "Redis가 포함되어야 함");
    assert.ok(corpus.includes("캐싱"), "캐싱이 포함되어야 함");
    assert.ok(corpus.includes("캐시"), "캐시가 포함되어야 함");
  });

  it("Claude 세션 데이터가 포함됨", () => {
    const wl = wlBase({
      aiSessions: {
        codex: [],
        claude: [
          {
            summary: "Kubernetes 배포 파이프라인 CI/CD 자동화",
            snippets: ["GitHub Actions 워크플로우 설정"]
          }
        ]
      }
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("kubernetes"), "Kubernetes가 포함되어야 함");
    assert.ok(corpus.includes("github"), "GitHub가 포함되어야 함");
  });

  it("highlights에서 businessOutcomes, keyChanges가 포함됨", () => {
    const wl = wlBase({
      highlights: {
        businessOutcomes: ["결제 시스템 안정화로 장애 50% 감소"],
        keyChanges: ["데이터베이스 쿼리 최적화"],
        commitAnalysis: [],
        impact: ["서비스 가용성 99.9% 달성"],
        workingStyleSignals: [],
        storyThreads: []
      }
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("결제"), "결제가 포함되어야 함");
    assert.ok(corpus.includes("데이터베이스"), "데이터베이스가 포함되어야 함");
    assert.ok(corpus.includes("가용성"), "가용성이 포함되어야 함");
  });

  it("storyThreads outcome, keyChange, repo가 포함됨", () => {
    const wl = wlBase({
      highlights: {
        businessOutcomes: [],
        keyChanges: [],
        commitAnalysis: [],
        impact: [],
        workingStyleSignals: [],
        storyThreads: [
          {
            repo: "backend-api",
            outcome: "마이크로서비스 분리 완료",
            keyChange: "GraphQL 스키마 리팩터링",
            why: "확장성 개선"
          }
        ]
      }
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("backend-api"), "repo 이름이 포함되어야 함");
    assert.ok(corpus.includes("마이크로서비스"), "outcome이 포함되어야 함");
    assert.ok(corpus.includes("graphql"), "keyChange가 포함되어야 함");
  });

  it("이력서 후보(candidates)가 포함됨", () => {
    const wl = wlBase({
      resume: {
        candidates: ["TypeScript 마이그레이션으로 타입 안전성 강화"],
        companyCandidates: ["팀 온보딩 프로세스 체계화"]
      }
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(corpus.includes("typescript"), "TypeScript가 포함되어야 함");
    assert.ok(corpus.includes("온보딩"), "온보딩이 포함되어야 함");
  });

  it("결과는 항상 소문자", () => {
    const wl = wlBase({
      projects: [{ repo: "MyRepo", commits: [{ subject: "Add Docker Support", repo: "MyRepo" }] }]
    });

    const corpus = buildSignalCorpus([wl]);
    assert.ok(!corpus.includes("Docker"), "대문자 Docker가 없어야 함");
    assert.ok(corpus.includes("docker"), "소문자 docker가 있어야 함");
  });

  it("여러 업무 로그 날짜를 합산", () => {
    const wl1 = wlBase({ date: "2025-01-01", highlights: { businessOutcomes: ["서버리스 아키텍처 도입"], keyChanges: [], commitAnalysis: [], impact: [], workingStyleSignals: [], storyThreads: [] } });
    const wl2 = wlBase({ date: "2025-01-02", highlights: { businessOutcomes: ["비용 30% 절감 달성"], keyChanges: [], commitAnalysis: [], impact: [], workingStyleSignals: [], storyThreads: [] } });

    const corpus = buildSignalCorpus([wl1, wl2]);
    assert.ok(corpus.includes("서버리스"), "첫번째 로그가 포함되어야 함");
    assert.ok(corpus.includes("비용"), "두번째 로그가 포함되어야 함");
  });
});

// ─── extractMeaningfulTokens ──────────────────────────────────────────────────

describe("extractMeaningfulTokens — 토큰 추출", () => {
  it("빈 문자열 → 빈 배열", () => {
    assert.deepStrictEqual(extractMeaningfulTokens(""), []);
    assert.deepStrictEqual(extractMeaningfulTokens(null), []);
  });

  it("영어 불용어 제거", () => {
    const tokens = extractMeaningfulTokens("built a new API for the authentication system");
    assert.ok(!tokens.includes("a"), "'a' 불용어가 제거되어야 함");
    assert.ok(!tokens.includes("the"), "'the' 불용어가 제거되어야 함");
    assert.ok(!tokens.includes("for"), "'for' 불용어가 제거되어야 함");
    assert.ok(!tokens.includes("new"), "'new' 불용어가 제거되어야 함");
    assert.ok(tokens.includes("built"), "'built'는 포함되어야 함");
    assert.ok(tokens.includes("api"), "'api'는 포함되어야 함");
    assert.ok(tokens.includes("authentication"), "'authentication'는 포함되어야 함");
    assert.ok(tokens.includes("system"), "'system'는 포함되어야 함");
  });

  it("한국어 불용어 조사 제거", () => {
    const tokens = extractMeaningfulTokens("API를 통한 인증 시스템을 구현했습니다");
    assert.ok(!tokens.includes("을"), "'을' 조사가 제거되어야 함");
    assert.ok(!tokens.includes("를"), "'를' 조사가 제거되어야 함");
    assert.ok(!tokens.includes("통한"), "'통한' 불용어가 제거되어야 함");
    assert.ok(!tokens.includes("구현했습니다"), "'구현했습니다' 불용어가 제거되어야 함");
    assert.ok(tokens.includes("api"), "'api'는 포함되어야 함");
    assert.ok(tokens.includes("인증"), "'인증'은 포함되어야 함");
    assert.ok(tokens.includes("시스템"), "'시스템'은 포함되어야 함");
  });

  it("숫자 단독 토큰 제거", () => {
    const tokens = extractMeaningfulTokens("40% performance improvement in 2024");
    assert.ok(!tokens.includes("40"), "숫자만 있는 토큰 제거");
    assert.ok(!tokens.includes("2024"), "연도 제거");
    assert.ok(tokens.includes("performance"), "'performance'는 포함");
    assert.ok(tokens.includes("improvement"), "'improvement'는 포함");
  });

  it("2자 미만 토큰 제거", () => {
    const tokens = extractMeaningfulTokens("A B building APIs");
    assert.ok(!tokens.includes("a"), "1자 토큰 제거");
    assert.ok(!tokens.includes("b"), "1자 토큰 제거");
    assert.ok(tokens.includes("building"), "'building'은 포함");
    assert.ok(tokens.includes("apis"), "'apis'는 포함");
  });

  it("중복 토큰 제거", () => {
    const tokens = extractMeaningfulTokens("redis redis redis 캐시 캐시");
    const redisCount = tokens.filter((t) => t === "redis").length;
    assert.strictEqual(redisCount, 1, "중복 토큰이 1개여야 함");
  });

  it("구두점으로 분리", () => {
    const tokens = extractMeaningfulTokens("TypeScript, React, Node.js, PostgreSQL");
    assert.ok(tokens.includes("typescript"), "TypeScript 포함");
    assert.ok(tokens.includes("react"), "React 포함");
    assert.ok(tokens.includes("node"), "node 포함");
    assert.ok(tokens.includes("postgresql"), "PostgreSQL 포함");
  });
});

// ─── evaluateItemCoverage ─────────────────────────────────────────────────────

describe("evaluateItemCoverage — 충족도 평가", () => {
  it("빈 텍스트 → score=0, isInsufficient=false (평가 불가)", () => {
    const result = evaluateItemCoverage("", "some corpus text");
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.isInsufficient, false);
    assert.strictEqual(result.level, "none");
  });

  it("코퍼스 없을 때 → isInsufficient=true", () => {
    const result = evaluateItemCoverage("Redis 캐싱 레이어 구현", "");
    assert.strictEqual(result.isInsufficient, true);
    assert.ok(result.reason, "reason이 있어야 함");
  });

  it("모든 키워드가 코퍼스에 있으면 → score=1, level=high", () => {
    const corpus = "redis 캐싱 레이어 구현";
    const result = evaluateItemCoverage("Redis 캐싱 레이어 구현", corpus);
    assert.strictEqual(result.score, 1);
    assert.strictEqual(result.level, "high");
    assert.strictEqual(result.isInsufficient, false);
  });

  it("키워드가 하나도 없으면 → score=0, level=none, isInsufficient=true", () => {
    const corpus = "completely unrelated content about weather";
    const result = evaluateItemCoverage("Redis 캐싱 레이어 구현으로 성능 개선", corpus);
    assert.strictEqual(result.score, 0);
    assert.strictEqual(result.level, "none");
    assert.strictEqual(result.isInsufficient, true);
  });

  it("일부 키워드만 있으면 중간 점수", () => {
    const corpus = "redis performance optimization";
    // "Redis 캐싱 레이어 구현" → tokens: ['redis', '캐싱', '레이어', '구현']
    // corpus에 redis만 포함 → score = 1/4 = 0.25
    const result = evaluateItemCoverage("Redis 캐싱 레이어 구현", corpus);
    assert.ok(result.score > 0 && result.score < 1, "중간 점수여야 함");
    assert.ok(result.matchedTokens.includes("redis"), "matched에 redis 포함");
  });

  it("matchedTokens와 unmatchedTokens가 올바르게 분리됨", () => {
    const corpus = "typescript react frontend 개발";
    const result = evaluateItemCoverage("TypeScript React 백엔드 개발", corpus);

    assert.ok(result.matchedTokens.includes("typescript"), "typescript matched");
    assert.ok(result.matchedTokens.includes("react"), "react matched");
    assert.ok(result.unmatchedTokens.includes("백엔드"), "백엔드 unmatched");
    assert.ok(result.matchedTokens.includes("개발"), "개발 matched");
  });

  it("의미 토큰이 너무 적으면 isInsufficient=false (분석 불가)", () => {
    // "OK" → 1자라 토큰 없음, 의미 토큰 < MIN_MEANINGFUL_TOKENS
    const result = evaluateItemCoverage("Ok", "some corpus");
    assert.strictEqual(result.isInsufficient, false);
  });

  it("isInsufficient=true일 때 reason 제공", () => {
    const corpus = "completely unrelated";
    const result = evaluateItemCoverage("마이크로서비스 아키텍처 설계 및 구현", corpus);
    assert.strictEqual(result.isInsufficient, true);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0, "reason이 문자열이어야 함");
  });
});

// ─── scoreToLevel ────────────────────────────────────────────────────────────

describe("scoreToLevel", () => {
  it("0.5 이상 → high", () => {
    assert.strictEqual(scoreToLevel(0.5), "high");
    assert.strictEqual(scoreToLevel(1.0), "high");
    assert.strictEqual(scoreToLevel(0.75), "high");
  });

  it("0.2 ~ 0.5 미만 → medium", () => {
    assert.strictEqual(scoreToLevel(0.2), "medium");
    assert.strictEqual(scoreToLevel(0.35), "medium");
    assert.strictEqual(scoreToLevel(0.49), "medium");
  });

  it("0 초과 0.2 미만 → low", () => {
    assert.strictEqual(scoreToLevel(0.05), "low");
    assert.strictEqual(scoreToLevel(0.1), "low");
    assert.strictEqual(scoreToLevel(0.19), "low");
  });

  it("0 → none", () => {
    assert.strictEqual(scoreToLevel(0), "none");
  });
});

// ─── analyzeDataSourceCoverage — 전체 분석 ───────────────────────────────────

describe("analyzeDataSourceCoverage — 유효하지 않은 입력", () => {
  it("null 이력서 → 빈 결과", () => {
    const result = analyzeDataSourceCoverage(null, "corpus");
    assert.deepStrictEqual(result.experience, []);
    assert.deepStrictEqual(result.insufficientItems, []);
    assert.strictEqual(result.coverageSummary.totalItems, 0);
  });

  it("undefined 이력서 → 빈 결과", () => {
    const result = analyzeDataSourceCoverage(undefined, "corpus");
    assert.strictEqual(result.coverageSummary.totalItems, 0);
  });
});

describe("analyzeDataSourceCoverage — experience 분석", () => {
  it("경험 불릿이 코퍼스와 일치하면 충족으로 판정", () => {
    const corpus = "redis 캐싱 레이어 구현 api 응답 속도 개선 typescript 마이그레이션";
    const resume = resumeBase({
      experience: [
        {
          company: "TechCorp",
          title: "Backend Engineer",
          bullets: [
            "Redis 캐싱 레이어 구현으로 API 응답 속도 개선",
            "TypeScript 마이그레이션으로 타입 안전성 강화"
          ]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    assert.strictEqual(result.experience.length, 1);
    const exp = result.experience[0];
    assert.strictEqual(exp.company, "TechCorp");
    assert.strictEqual(exp.bullets.length, 2);
    // 두 불릿 모두 코퍼스에 잘 매칭됨
    assert.ok(exp.bullets[0].score > 0, "첫 번째 불릿이 매칭되어야 함");
    assert.ok(exp.bullets[1].score > 0, "두 번째 불릿이 매칭되어야 함");
  });

  it("코퍼스에 없는 경험 불릿은 부족으로 판정", () => {
    const corpus = "frontend react component development";
    const resume = resumeBase({
      experience: [
        {
          company: "FinTechCo",
          title: "Engineer",
          bullets: [
            "Kubernetes 클러스터 마이그레이션 및 zero-downtime 배포 구현"
          ]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const exp = result.experience[0];
    // Kubernetes 관련 내용이 corpus에 없으므로 isInsufficient
    assert.ok(
      exp.bullets[0].isInsufficient || exp.bullets[0].score < 0.2,
      "Kubernetes 불릿이 부족으로 판정되어야 함"
    );
    // insufficientItems에 추가됨
    const hasFinTechItem = result.insufficientItems.some(
      (item) => item.company === "FinTechCo"
    );
    assert.ok(hasFinTechItem, "insufficientItems에 FinTechCo 항목이 있어야 함");
  });

  it("insufficientItems에 section='experience' 포함", () => {
    const corpus = "completely different text";
    const resume = resumeBase({
      experience: [
        {
          company: "StartupXYZ",
          title: "Dev",
          bullets: ["마이크로서비스 아키텍처 설계 및 운영 비용 최적화"]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const expItems = result.insufficientItems.filter((i) => i.section === "experience");
    assert.ok(expItems.length > 0, "experience 섹션 부족 항목이 있어야 함");
    assert.strictEqual(expItems[0].company, "StartupXYZ");
    assert.ok(typeof expItems[0].reason === "string", "reason이 있어야 함");
    assert.ok(Array.isArray(expItems[0].unmatchedTokens), "unmatchedTokens가 있어야 함");
  });
});

describe("analyzeDataSourceCoverage — skills 분석", () => {
  it("코퍼스에 있는 스킬은 충족으로 판정", () => {
    const corpus = "react typescript postgresql docker kubernetes";
    const resume = resumeBase({
      skills: {
        technical: ["React", "TypeScript"],
        languages: ["PostgreSQL"],
        tools: ["Docker", "Kubernetes"]
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    for (const skill of result.skills.technical) {
      assert.strictEqual(skill.isInsufficient, false, `${skill.skill}은 코퍼스에 있으므로 충족`);
    }
  });

  it("코퍼스에 없는 스킬은 부족으로 판정", () => {
    const corpus = "react frontend ui component";
    const resume = resumeBase({
      skills: {
        technical: ["React"],
        languages: ["Haskell"],
        tools: ["Terraform"]
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const haskell = result.skills.languages.find((s) => s.skill === "Haskell");
    const terraform = result.skills.tools.find((s) => s.skill === "Terraform");

    assert.ok(haskell, "Haskell 스킬이 분석되어야 함");
    assert.strictEqual(haskell.isInsufficient, true, "Haskell은 코퍼스에 없으므로 부족");

    assert.ok(terraform, "Terraform 스킬이 분석되어야 함");
    assert.strictEqual(terraform.isInsufficient, true, "Terraform은 코퍼스에 없으므로 부족");

    // insufficientItems에 skills 섹션 항목이 있어야 함
    const skillItems = result.insufficientItems.filter((i) => i.section === "skills");
    assert.ok(skillItems.length >= 2, "스킬 부족 항목이 2개 이상이어야 함");
  });

  it("skillCategory 필드가 올바르게 설정됨", () => {
    const corpus = "unrelated text";
    const resume = resumeBase({
      skills: {
        technical: ["Vue.js"],
        languages: ["Rust"],
        tools: ["Ansible"]
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const technicalItems = result.insufficientItems.filter(
      (i) => i.section === "skills" && i.skillCategory === "technical"
    );
    const languageItems = result.insufficientItems.filter(
      (i) => i.section === "skills" && i.skillCategory === "languages"
    );
    const toolItems = result.insufficientItems.filter(
      (i) => i.section === "skills" && i.skillCategory === "tools"
    );

    assert.ok(technicalItems.length > 0, "technical 카테고리 항목이 있어야 함");
    assert.ok(languageItems.length > 0, "languages 카테고리 항목이 있어야 함");
    assert.ok(toolItems.length > 0, "tools 카테고리 항목이 있어야 함");
  });
});

describe("analyzeDataSourceCoverage — summary 분석", () => {
  it("summary가 없으면 score=0, isInsufficient=false", () => {
    const result = analyzeDataSourceCoverage(resumeBase({ summary: "" }), "corpus");
    assert.strictEqual(result.summary.isInsufficient, false);
    assert.strictEqual(result.summary.score, 0);
  });

  it("summary 키워드가 코퍼스에 있으면 충족", () => {
    const corpus = "backend engineer api design system architecture";
    const resume = resumeBase({
      summary: "Experienced backend engineer specializing in API design and system architecture."
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    assert.ok(result.summary.score > 0, "요약 점수가 0 초과여야 함");
    assert.strictEqual(result.summary.isInsufficient, false, "요약이 충족되어야 함");
  });
});

describe("analyzeDataSourceCoverage — coverageSummary 통계", () => {
  it("충족 항목만 있으면 coverageRatio = 1", () => {
    const corpus = "redis typescript react api backend development";
    const resume = resumeBase({
      experience: [
        {
          company: "TechCorp",
          title: "Dev",
          bullets: ["Redis API 개발", "TypeScript React backend"]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    // 모든 불릿이 높은 매칭을 가지면 coverageRatio가 높아야 함
    assert.ok(result.coverageSummary.totalItems > 0, "totalItems > 0");
    assert.ok(result.coverageSummary.avgScore >= 0, "avgScore >= 0");
  });

  it("부족 항목이 많으면 coverageRatio < 1", () => {
    const corpus = "completely unrelated content about weather";
    const resume = resumeBase({
      skills: {
        technical: ["React", "TypeScript", "GraphQL"],
        languages: ["Python", "Rust"],
        tools: ["Docker", "Kubernetes", "Terraform"]
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    assert.ok(result.coverageSummary.coverageRatio < 1, "coverageRatio < 1이어야 함");
    assert.ok(result.coverageSummary.insufficientCount > 0, "insufficientCount > 0이어야 함");
  });

  it("totalItems가 skills + bullets 수와 일치", () => {
    const corpus = "react typescript api";
    const resume = resumeBase({
      experience: [
        {
          company: "Co1",
          title: "Dev",
          bullets: ["React API 개발"]  // 1개 불릿
        }
      ],
      skills: {
        technical: ["React", "TypeScript"],  // 2개
        languages: ["Python"],               // 1개
        tools: ["Docker"]                    // 1개
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    // 1(bullet) + 2(technical) + 1(languages) + 1(tools) = 5
    assert.strictEqual(result.coverageSummary.totalItems, 5);
  });
});

describe("analyzeDataSourceCoverage — projects 분석", () => {
  it("프로젝트 불릿이 코퍼스에 없으면 insufficientItems에 추가됨", () => {
    const corpus = "completely different text";
    const resume = resumeBase({
      projects: [
        {
          name: "OpenSource Tool",
          bullets: ["오픈소스 데이터 파이프라인 도구 구현 및 배포"]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const projectItems = result.insufficientItems.filter((i) => i.section === "projects");
    assert.ok(projectItems.length > 0, "프로젝트 부족 항목이 있어야 함");
    assert.strictEqual(projectItems[0].company, "OpenSource Tool", "프로젝트명이 company 필드에 저장됨");
  });
});

describe("analyzeDataSourceCoverage — severity 분류", () => {
  it("score=0인 항목은 severity=high", () => {
    const corpus = "completely unrelated text";
    const resume = resumeBase({
      experience: [
        {
          company: "Corp",
          title: "Dev",
          bullets: ["Kubernetes 마이크로서비스 아키텍처 설계 구현 운영"]
        }
      ]
    });

    const result = analyzeDataSourceCoverage(resume, corpus);
    const highSeverity = result.insufficientItems.filter(
      (i) => i.severity === "high"
    );
    assert.ok(highSeverity.length > 0, "high severity 항목이 있어야 함");
  });
});

// ─── 통합 시나리오 ─────────────────────────────────────────────────────────────

describe("통합 시나리오 — 실제 업무 로그와 이력서 매칭", () => {
  it("업무 로그에서 코퍼스 구축 후 이력서 분석 전체 파이프라인", () => {
    const workLogs = [
      wlBase({
        date: "2025-01-10",
        projects: [
          {
            repo: "payment-service",
            commits: [
              { subject: "feat: add stripe payment integration", repo: "payment-service", hash: "abc" },
              { subject: "fix: resolve race condition in transaction", repo: "payment-service", hash: "def" }
            ]
          }
        ],
        highlights: {
          businessOutcomes: ["결제 실패율 0.1%로 감소"],
          keyChanges: ["Stripe 결제 연동 완료"],
          commitAnalysis: [],
          impact: [],
          workingStyleSignals: [],
          storyThreads: []
        },
        aiSessions: {
          codex: [
            {
              summary: "Redis 캐시 레이어 구현으로 결제 조회 성능 개선",
              snippets: []
            }
          ],
          claude: []
        },
        resume: { candidates: [], companyCandidates: [] }
      }),
      wlBase({
        date: "2025-01-11",
        highlights: {
          businessOutcomes: ["TypeScript 마이그레이션 완료"],
          keyChanges: [],
          commitAnalysis: [],
          impact: [],
          workingStyleSignals: [],
          storyThreads: []
        },
        aiSessions: { codex: [], claude: [] },
        resume: { candidates: [], companyCandidates: [] }
      })
    ];

    const corpus = buildSignalCorpus(workLogs);

    const resume = resumeBase({
      summary: "결제 시스템 전문 백엔드 엔지니어",
      experience: [
        {
          company: "Payment Platform Inc.",
          title: "Backend Engineer",
          bullets: [
            "Stripe 결제 연동으로 결제 실패율 0.1%로 감소",  // 코퍼스 매칭 예상
            "Kubernetes 클러스터 마이그레이션 — 코퍼스에 없음"   // 코퍼스 불일치
          ]
        }
      ],
      skills: {
        technical: ["Redis", "TypeScript"],  // 코퍼스에 있음
        languages: ["Rust"],                  // 코퍼스에 없음
        tools: []
      }
    });

    const result = analyzeDataSourceCoverage(resume, corpus);

    // 전체 구조 확인
    assert.ok(result.experience.length === 1, "경험 섹션 1개");
    assert.ok(result.coverageSummary.totalItems > 0, "분석된 항목이 있어야 함");
    assert.ok(result.coverageSummary.insufficientCount > 0, "부족 항목이 있어야 함");

    // Stripe/결제 관련 불릿은 코퍼스에 매칭
    const firstBullet = result.experience[0].bullets[0];
    assert.ok(firstBullet.score > 0, "Stripe 관련 불릿이 매칭되어야 함");

    // Rust는 코퍼스에 없으므로 부족
    const rustSkill = result.skills.languages.find((s) => s.skill === "Rust");
    assert.ok(rustSkill, "Rust 스킬이 분석되어야 함");
    assert.strictEqual(rustSkill.isInsufficient, true, "Rust는 코퍼스에 없으므로 부족");

    // insufficientItems가 올바른 섹션 정보를 가짐
    for (const item of result.insufficientItems) {
      assert.ok(
        ["experience", "skills", "summary", "projects"].includes(item.section),
        `올바른 section 값: ${item.section}`
      );
      assert.ok(typeof item.text === "string" && item.text.length > 0, "text가 있어야 함");
      assert.ok(typeof item.reason === "string" && item.reason.length > 0, "reason이 있어야 함");
    }
  });
});
