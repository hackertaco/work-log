/**
 * resumeEvidenceSearch.mjs
 *
 * 이력서 채팅 기능을 위한 데이터 소스별 키워드 검색 어댑터 레이어.
 *
 * 파싱된 쿼리(resumeQueryParser.js 출력)를 받아 세 가지 데이터 소스를
 * 독립적으로 검색하고 관련 레코드를 반환한다.
 *
 * 어댑터:
 *   searchCommits(parsedQuery, options)       — 커밋 로그 검색
 *   searchSlack(parsedQuery, options)          — 슬랙 메시지 검색
 *   searchSessionMemory(parsedQuery, options)  — 세션 메모리 검색
 *   searchAllSources(parsedQuery, options)     — 세 소스 병렬 검색
 *
 * 데이터 소스 전략:
 *   - 커밋:   data/daily/{date}.json →
 *             projects[].commits[] (커밋 메시지),
 *             highlights.commitAnalysis[] (LLM 커밋 분석 요약),
 *             highlights.storyThreads[] (스토리 스레드: outcome/keyChange/impact),
 *             highlights.accomplishments[] (커밋 기반 성과 하이라이트)
 *   - 슬랙:   data/daily/{date}.json 없음 → Slack API 재조회
 *             (SLACK_TOKEN / SLACK_USER_TOKEN 없으면 빈 배열 반환)
 *   - 세션:   data/daily/{date}.json →
 *             aiSessions.codex[] + aiSessions.claude[] (세션 요약·스니펫),
 *             highlights.aiReview[] (LLM 생성 AI 세션 리뷰),
 *             highlights.workingStyleSignals[] (행동 패턴 신호)
 *
 * 반환 타입 (ChatEvidenceRecord):
 *   {
 *     source: 'commits' | 'slack' | 'session',
 *     date: string,            // YYYY-MM-DD
 *     text: string,            // 검색에 히트한 주요 텍스트
 *     relevanceScore: number,  // 키워드 매칭 횟수 (0 = 키워드 없이 전체 반환 시)
 *     provenance: CommitProvenance | SlackProvenance | SessionProvenance
 *                              // 출처 메타데이터 (커밋 해시, 슬랙 메시지 ID 등)
 *   }
 *
 * 출처 메타데이터 필드 (source별):
 *   commits  → provenance.commitHash, provenance.repo, provenance.authoredAt, provenance.repoPath
 *   slack    → provenance.messageId (= Slack ts), provenance.channelId, provenance.permalink, provenance.context
 *   session  → provenance.sessionType, provenance.filePath, provenance.cwd, provenance.snippets
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { collectSlackContexts } from "./slack.mjs";
import { fileExists } from "./utils.mjs";

// ─── 상수 ─────────────────────────────────────────────────────────────────────

/** 소스별 최대 반환 레코드 수 */
const DEFAULT_MAX_RESULTS = 20;

/** Slack 재조회 시 최대 날짜 범위 (일) */
const SLACK_MAX_DATE_SPAN_DAYS = 30;

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * 텍스트에서 키워드 매칭 횟수와 매칭된 키워드 목록을 반환한다.
 * 대소문자 구분 없이 검색하며, 한글/영문 모두 지원한다.
 *
 * @param {string} text
 * @param {string[]} keywords
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
function scoreText(text, keywords) {
  if (!text || !keywords.length) return { score: 0, matchedKeywords: [] };
  const lower = text.toLowerCase();
  const matchedKeywords = [];
  for (const kw of keywords) {
    if (!kw) continue;
    if (lower.includes(kw.toLowerCase())) {
      matchedKeywords.push(kw);
    }
  }
  return { score: matchedKeywords.length, matchedKeywords };
}

/**
 * 날짜(YYYY-MM-DD)가 dateRange 범위 내인지 확인한다.
 *
 * @param {string} date
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @returns {boolean}
 */
function isInDateRange(date, dateRange) {
  if (!dateRange) return true;
  const { from, to } = dateRange;
  if (from && date < from.slice(0, 10)) return false;
  if (to && date > to.slice(0, 10)) return false;
  return true;
}

/**
 * 두 날짜(YYYY-MM-DD) 사이의 일 수를 반환한다.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
function daysBetween(from, to) {
  return Math.round(
    (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24)
  );
}

/**
 * data/daily/ 디렉터리에서 날짜 범위 내 JSON 파일 목록을 반환한다.
 * 최신순(내림차순) 정렬.
 *
 * @param {string} dataDir
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @returns {Promise<Array<{ date: string, filePath: string }>>}
 */
async function listDailyFiles(dataDir, dateRange) {
  const dailyDir = path.join(dataDir, "daily");
  if (!(await fileExists(dailyDir))) return [];

  let entries;
  try {
    entries = await fs.readdir(dailyDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => ({
      date: name.slice(0, 10),
      filePath: path.join(dailyDir, name),
    }))
    .filter(({ date }) => isInDateRange(date, dateRange))
    .sort((a, b) => b.date.localeCompare(a.date)); // 최신순
}

/**
 * daily JSON 파일을 읽는다. 실패 시 null 반환.
 *
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
async function readDailyFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * dateRange의 YYYY-MM-DD 날짜 문자열 목록을 순서대로 생성한다.
 * dateRange가 null이면 오늘 날짜만 반환한다.
 *
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @returns {string[]}
 */
function buildDateList(dateRange) {
  const today = new Date().toISOString().slice(0, 10);
  if (!dateRange?.from && !dateRange?.to) return [today];

  const from = dateRange.from?.slice(0, 10) ?? today;
  const to = dateRange.to?.slice(0, 10) ?? today;

  const dates = [];
  const current = new Date(from);
  const end = new Date(to);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates.reverse(); // 최신순
}

// ─── 커밋 어댑터 ─────────────────────────────────────────────────────────────

/**
 * Evidence record returned by the search adapters.
 *
 * Use `ChatEvidenceRecord` from resumeTypes.mjs for the full typedef.
 * The `provenance` field is a discriminated union based on `source`:
 *   - source === "commits"  → CommitProvenance
 *   - source === "slack"    → SlackProvenance
 *   - source === "session"  → SessionProvenance
 *
 * @typedef {import('./resumeTypes.mjs').ChatEvidenceRecord} EvidenceRecord
 */

/**
 * 커밋 로그에서 키워드 검색을 수행한다.
 *
 * 데이터 소스: data/daily/{date}.json
 * 매칭 대상:
 *   1. projects[].commits[].subject — 개별 커밋 메시지 + repo 이름
 *   2. highlights.commitAnalysis[] — LLM 생성 커밋 분석 요약
 *   3. highlights.storyThreads[] — 스토리 스레드 (outcome/keyChange/impact/why/decision)
 *   4. highlights.accomplishments[] — 커밋 기반 성과 하이라이트
 *
 * 키워드가 없으면 dateRange 내 모든 커밋을 반환한다.
 * 결과는 관련도(relevanceScore) 내림차순, 날짜 내림차순으로 정렬된다.
 *
 * provenance 필드 (CommitProvenance):
 *   - commitHash  — 커밋 해시 (7자 short hash; highlights 라인은 빈 문자열)
 *   - repo        — 레포지터리 이름
 *   - authoredAt  — 커밋 시각 (ISO 8601); highlights 라인은 null
 *   - repoPath    — 레포 파일시스템 경로; 없으면 null
 *
 * @param {{
 *   raw: string,
 *   intent: string,
 *   keywords: string[],
 *   section: string|null,
 *   dateRange: { from: string|null, to: string|null }|null
 * }} parsedQuery
 * @param {{ dataDir?: string, maxResults?: number }} [options]
 * @returns {Promise<EvidenceRecord[]>}
 */
export async function searchCommits(parsedQuery, options = {}) {
  const config = await loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const { keywords = [], dateRange } = parsedQuery;

  const dailyFiles = await listDailyFiles(dataDir, dateRange);
  const results = [];
  const seen = new Set();

  for (const { date, filePath } of dailyFiles) {
    const data = await readDailyFile(filePath);
    if (!data) continue;

    // ── 1. projects[].commits[].subject — 개별 커밋 메시지 검색 ────────────
    const projects = data.projects ?? [];

    for (const project of projects) {
      const repoName = String(project.repo ?? "");
      for (const commit of (project.commits ?? [])) {
        const subject = String(commit.subject ?? "");
        const fullText = repoName ? `${repoName} ${subject}` : subject;

        let score, matchedKeywords;
        if (keywords.length > 0) {
          ({ score, matchedKeywords } = scoreText(fullText, keywords));
        } else {
          score = 1; // 키워드 없음 → 전체 포함
          matchedKeywords = [];
        }

        if (keywords.length > 0 && score === 0) continue;

        const text = repoName ? `${repoName}: ${subject}` : subject;
        const dedup = `commits::${date}::${text}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);

        /** @type {import('./resumeTypes.mjs').CommitProvenance} */
        const provenance = {
          sourceType: "commits",
          commitHash: commit.hash ?? "",
          repo: commit.repo ?? repoName,
          authoredAt: commit.authoredAt ?? null,
          repoPath: commit.repoPath ?? null,
        };

        results.push(
          /** @type {EvidenceRecord} */ ({
            source: "commits",
            date,
            text,
            relevanceScore: score,
            matchedKeywords,
            provenance,
          })
        );
      }
    }

    // ── 2. highlights.commitAnalysis[] — LLM 생성 커밋 분석 요약 ──────────
    const highlights = data.highlights ?? {};
    for (const line of highlights.commitAnalysis ?? []) {
      if (!line) continue;
      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(line, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }
      if (keywords.length > 0 && score === 0) continue;

      const dedup = `commits::${date}::${line}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      // commitAnalysis 라인에서 레포명 추출: "repo에서 N개의 커밋" 패턴
      const repoMatch = line.match(/^([^\s]+)에서/);
      const repo = repoMatch ? repoMatch[1] : "";

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "commits",
          date,
          text: line,
          relevanceScore: score,
          matchedKeywords,
          provenance: {
            sourceType: "commits",
            commitHash: "",
            repo,
            authoredAt: null,
            repoPath: null,
          },
        })
      );
    }

    // ── 3. highlights.storyThreads[] — 스토리 스레드 (결과·핵심변경·영향) ──
    for (const thread of highlights.storyThreads ?? []) {
      const combinedText = [
        thread.outcome,
        thread.keyChange,
        thread.impact,
        thread.why,
        thread.decision,
      ]
        .filter(Boolean)
        .join(" ");

      if (!combinedText) continue;
      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(combinedText, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }
      if (keywords.length > 0 && score === 0) continue;

      const dedup = `commits::${date}::${combinedText}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "commits",
          date,
          text: combinedText,
          relevanceScore: score,
          matchedKeywords,
          provenance: {
            sourceType: "commits",
            commitHash: "",
            repo: thread.repo ?? "",
            authoredAt: null,
            repoPath: null,
          },
        })
      );
    }

    // ── 4. highlights.accomplishments[] — 커밋 기반 성과 하이라이트 ────────
    for (const line of highlights.accomplishments ?? []) {
      if (!line) continue;
      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(line, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }
      if (keywords.length > 0 && score === 0) continue;

      const dedup = `commits::${date}::${line}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      // "repo: subject" 패턴에서 레포명 추출
      const repoMatch = line.match(/^([^:]+):/);
      const repo = repoMatch ? repoMatch[1].trim() : "";

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "commits",
          date,
          text: line,
          relevanceScore: score,
          matchedKeywords,
          provenance: {
            sourceType: "commits",
            commitHash: "",
            repo,
            authoredAt: null,
            repoPath: null,
          },
        })
      );
    }
  }

  return results
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.date.localeCompare(a.date)
    )
    .slice(0, maxResults);
}

// ─── 슬랙 어댑터 ─────────────────────────────────────────────────────────────

/**
 * 슬랙 메시지에서 키워드 검색을 수행한다.
 *
 * 데이터 소스: Slack API 재조회 (collectSlackContexts)
 *   - SLACK_TOKEN / SLACK_USER_TOKEN이 설정되어 있어야 한다.
 *   - 미설정 시 빈 배열을 반환하며 오류를 발생시키지 않는다.
 *   - dateRange가 SLACK_MAX_DATE_SPAN_DAYS(30일)를 초과하면
 *     최근 30일로 자동 축소된다.
 *
 * 키워드가 없으면 dateRange 내 모든 자신의 메시지를 반환한다.
 *
 * provenance 필드 (SlackProvenance):
 *   - messageId  — Slack ts 문자열 (채널 내 메시지 고유 식별자)
 *   - channelId  — 슬랙 채널 ID (예: "C01ABCDEF")
 *   - permalink  — Slack permalink URL; 없으면 null
 *   - context    — 전후 메시지 스니펫 (0–2개)
 *
 * @param {{
 *   raw: string,
 *   intent: string,
 *   keywords: string[],
 *   section: string|null,
 *   dateRange: { from: string|null, to: string|null }|null
 * }} parsedQuery
 * @param {{ maxResults?: number }} [options]
 * @returns {Promise<EvidenceRecord[]>}
 */
export async function searchSlack(parsedQuery, options = {}) {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const { keywords = [], dateRange } = parsedQuery;

  // Slack 인증 정보 없으면 즉시 반환
  const token =
    process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  if (!token) return [];

  // dateRange 조정 (최대 30일)
  const today = new Date().toISOString().slice(0, 10);
  let from = dateRange?.from?.slice(0, 10) ?? today;
  const to = dateRange?.to?.slice(0, 10) ?? today;

  if (daysBetween(from, to) > SLACK_MAX_DATE_SPAN_DAYS) {
    const clampedFrom = new Date(to);
    clampedFrom.setDate(clampedFrom.getDate() - SLACK_MAX_DATE_SPAN_DAYS);
    from = clampedFrom.toISOString().slice(0, 10);
  }

  // 날짜별 Slack 조회 (최신순)
  const dates = buildDateList({ from, to });
  const results = [];

  for (const date of dates) {
    let contexts;
    try {
      contexts = await collectSlackContexts(date);
    } catch {
      // 채널별 오류는 무시하고 계속
      continue;
    }

    for (const ctx of contexts) {
      const text = String(ctx.text ?? "");
      if (!text) continue;

      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(text, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }

      if (keywords.length > 0 && score === 0) continue;

      /** @type {import('./resumeTypes.mjs').SlackProvenance} */
      const provenance = {
        sourceType: "slack",
        // Slack ts string is the canonical message identifier:
        // (channelId + messageId) uniquely identifies a message globally
        messageId: ctx.ts ?? "",
        channelId: ctx.channelId ?? "",
        permalink: ctx.permalink ?? null,
        context: Array.isArray(ctx.context) ? ctx.context : [],
      };

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "slack",
          date,
          text,
          relevanceScore: score,
          matchedKeywords,
          provenance,
        })
      );
    }

    if (results.length >= maxResults * 2) break; // 조기 중단
  }

  return results
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.date.localeCompare(a.date)
    )
    .slice(0, maxResults);
}

// ─── 세션 메모리 어댑터 ──────────────────────────────────────────────────────

/**
 * 세션 메모리(Codex + Claude 세션 + AI 리뷰)에서 키워드 검색을 수행한다.
 *
 * 데이터 소스: data/daily/{date}.json
 *   - 세션 로그는 기본 비활성(includeSessionLogs: false); 데이터가 없으면
 *     빈 배열을 반환하며 오류를 발생시키지 않는다.
 *
 * 매칭 대상:
 *   1. aiSessions.codex[]/claude[].summary — 세션의 대표 요약문
 *   2. aiSessions.codex[]/claude[].snippets[] — 원본 어시스턴트/사용자 발화 단편들
 *      (summary + snippets 합산 텍스트에 대해 키워드 점수 산출)
 *   3. highlights.aiReview[] — LLM 생성 AI 세션 리뷰 노트
 *   4. highlights.workingStyleSignals[] — 작업 스타일·행동 패턴 신호
 *
 * provenance 필드 (SessionProvenance):
 *   - sessionType — "codex" | "claude" | null (AI 도구 구분자)
 *   - filePath    — 세션 파일 경로; 없으면 null
 *   - cwd         — 세션 작업 디렉터리; 없으면 null
 *   - snippets    — 세션 발화 단편 미리보기 (최대 3개)
 *
 * @param {{
 *   raw: string,
 *   intent: string,
 *   keywords: string[],
 *   section: string|null,
 *   dateRange: { from: string|null, to: string|null }|null
 * }} parsedQuery
 * @param {{ dataDir?: string, maxResults?: number }} [options]
 * @returns {Promise<EvidenceRecord[]>}
 */
export async function searchSessionMemory(parsedQuery, options = {}) {
  const config = await loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const { keywords = [], dateRange } = parsedQuery;

  const dailyFiles = await listDailyFiles(dataDir, dateRange);
  const results = [];
  const seen = new Set();

  for (const { date, filePath } of dailyFiles) {
    const data = await readDailyFile(filePath);
    if (!data) continue;

    // ── 1. aiSessions.codex + aiSessions.claude 통합 (출처 타입 보존) ────
    const codexSessions = (data?.aiSessions?.codex ?? []).map((s) => ({
      ...s,
      _sessionType: "codex",
    }));
    const claudeSessions = (data?.aiSessions?.claude ?? []).map((s) => ({
      ...s,
      _sessionType: "claude",
    }));
    const allSessions = [...codexSessions, ...claudeSessions];

    for (const session of allSessions) {
      const summary = String(session.summary ?? "");
      const snippets = Array.isArray(session.snippets) ? session.snippets : [];

      // 점수 산출을 위한 합산 텍스트 (summary 가중치 2×)
      const scoringText = [summary, summary, ...snippets]
        .filter(Boolean)
        .join(" ");

      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(scoringText, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }

      if (keywords.length > 0 && score === 0) continue;

      // 표시 텍스트: summary 우선, 없으면 첫 번째 snippet
      const displayText =
        summary ||
        snippets.find((s) => s && s.length > 10) ||
        "";

      if (!displayText) continue;

      const dedup = `session::${date}::${displayText}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      // sessionType: _sessionType (우리가 위에서 붙인 출처 태그)이 우선;
      // session.source 필드가 있으면 그것도 보조 활용
      const sessionType = session._sessionType ?? session.source ?? null;

      /** @type {import('./resumeTypes.mjs').SessionProvenance} */
      const provenance = {
        sourceType: "session",
        sessionType: sessionType,
        filePath: session.filePath ?? null,
        cwd: session.cwd ?? null,
        snippets: snippets.slice(0, 3), // 처음 3개 미리보기
      };

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "session",
          date,
          text: displayText,
          relevanceScore: score,
          matchedKeywords,
          provenance,
        })
      );
    }

    // ── 2. highlights.aiReview[] — LLM 생성 AI 세션 리뷰 노트 ───────────
    const highlights = data.highlights ?? {};
    for (const line of highlights.aiReview ?? []) {
      if (!line) continue;

      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(line, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }
      if (keywords.length > 0 && score === 0) continue;

      const dedup = `session::${date}::${line}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "session",
          date,
          text: line,
          relevanceScore: score,
          matchedKeywords,
          provenance: {
            sourceType: "session",
            sessionType: "aiReview",
            filePath: null,
            cwd: null,
            snippets: [],
          },
        })
      );
    }

    // ── 3. highlights.workingStyleSignals[] — 행동 패턴 신호 ─────────────
    for (const signal of highlights.workingStyleSignals ?? []) {
      if (!signal) continue;

      let score, matchedKeywords;
      if (keywords.length > 0) {
        ({ score, matchedKeywords } = scoreText(signal, keywords));
      } else {
        score = 1;
        matchedKeywords = [];
      }
      if (keywords.length > 0 && score === 0) continue;

      const dedup = `session::${date}::${signal}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      results.push(
        /** @type {EvidenceRecord} */ ({
          source: "session",
          date,
          text: signal,
          relevanceScore: score,
          matchedKeywords,
          provenance: {
            sourceType: "session",
            sessionType: "aiReview",
            filePath: null,
            cwd: null,
            snippets: [],
          },
        })
      );
    }
  }

  return results
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.date.localeCompare(a.date)
    )
    .slice(0, maxResults);
}

// ─── 통합 검색 ────────────────────────────────────────────────────────────────

/**
 * 세 가지 데이터 소스(커밋, 슬랙, 세션 메모리)를 병렬로 검색한다.
 *
 * 각 어댑터는 독립적으로 실행되며, 한 소스의 오류가 다른 소스에 영향을
 * 주지 않는다(오류 시 해당 소스는 빈 배열로 처리).
 *
 * 각 레코드의 provenance 필드에 출처 메타데이터가 포함된다:
 *   - commits  → CommitProvenance  (commitHash, repo, authoredAt, repoPath)
 *   - slack    → SlackProvenance   (messageId, channelId, permalink, context)
 *   - sessions → SessionProvenance (sessionType, filePath, cwd, snippets)
 *
 * 반환값:
 *   {
 *     commits: ChatEvidenceRecord[],   // CommitProvenance 포함
 *     slack: ChatEvidenceRecord[],     // SlackProvenance 포함
 *     sessions: ChatEvidenceRecord[],  // SessionProvenance 포함
 *     totalCount: number
 *   }
 *
 * @param {{
 *   raw: string,
 *   intent: string,
 *   keywords: string[],
 *   section: string|null,
 *   dateRange: { from: string|null, to: string|null }|null
 * }} parsedQuery
 * @param {{
 *   dataDir?: string,
 *   maxResultsPerSource?: number
 * }} [options]
 * @returns {Promise<import('./resumeTypes.mjs').ChatEvidenceResult>}
 */
export async function searchAllSources(parsedQuery, options = {}) {
  const adapterOptions = {
    dataDir: options.dataDir,
    maxResults: options.maxResultsPerSource ?? DEFAULT_MAX_RESULTS,
  };

  const errors = [];
  const [commits, slack, sessions] = await Promise.all([
    searchCommits(parsedQuery, adapterOptions).catch((err) => {
      console.error("[EvidenceSearch] commits search failed:", err.message);
      errors.push(`commits: ${err.message}`);
      return [];
    }),
    searchSlack(parsedQuery, adapterOptions).catch((err) => {
      console.error("[EvidenceSearch] slack search failed:", err.message);
      errors.push(`slack: ${err.message}`);
      return [];
    }),
    searchSessionMemory(parsedQuery, adapterOptions).catch((err) => {
      console.error("[EvidenceSearch] sessions search failed:", err.message);
      errors.push(`sessions: ${err.message}`);
      return [];
    }),
  ]);

  return {
    commits,
    slack,
    sessions,
    totalCount: commits.length + slack.length + sessions.length,
    errors,
  };
}

// ─── AnalyzedQuery 기반 소스별 탐색 ──────────────────────────────────────────

/**
 * AnalyzedQuery(resumeQueryAnalyzer 출력)를 기반으로 각 데이터 소스를
 * 소스별 확장 키워드·날짜 범위·maxResults·enabled 플래그를 사용하여 탐색한다.
 *
 * 기존 searchAllSources()와 다른 점:
 *   - sourceParams.{source}.enabled === false 인 소스는 API 호출 없이 건너뜀
 *   - 소스별로 독립적인 확장 키워드를 사용 (커밋용 영어 약어, 슬랙용 한국어 등)
 *   - 소스별 maxResults를 의도(intent)에 따라 차등 적용
 *   - techStack 키워드를 소스 키워드에 보강 (기술 이름이 명시되면 검색 정밀도 향상)
 *
 * @param {import('./resumeQueryAnalyzer.mjs').AnalyzedQuery} analyzed
 *   analyzeQuery() 또는 analyzeQueryWithLLM()의 출력
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<import('./resumeTypes.mjs').ChatEvidenceResult>}
 */
export async function searchWithAnalyzedQuery(analyzed, options = {}) {
  const { sourceParams, techStack } = analyzed;

  // 기술스택 키워드 보강: techStack.all 에서 소스별 키워드에 없는 것만 추가
  const techKeywords = techStack?.all ?? [];

  /**
   * 소스별 파싱된 쿼리를 구성한다.
   * sourceParams에서 expanded keywords를 사용하되,
   * techStack 키워드를 중복 없이 추가한다.
   *
   * @param {"commits"|"slack"|"sessions"} source
   * @returns {{ keywords: string[], dateRange: object|null }}
   */
  function buildSourceQuery(source) {
    const params = sourceParams[source];
    const baseKeywords = params?.keywords ?? [];

    // techStack 키워드를 소스 키워드에 보강 (대소문자 무시 중복 제거)
    const existingLower = new Set(baseKeywords.map((k) => k.toLowerCase()));
    const augmented = [...baseKeywords];
    for (const tk of techKeywords) {
      if (!existingLower.has(tk.toLowerCase())) {
        augmented.push(tk);
        existingLower.add(tk.toLowerCase());
      }
    }

    return {
      raw: analyzed.raw,
      intent: analyzed.intent,
      keywords: augmented,
      section: analyzed.section,
      dateRange: params?.dateRange ?? analyzed.dateRange,
    };
  }

  const commitParams = sourceParams.commits;
  const slackParams = sourceParams.slack;
  const sessionParams = sourceParams.sessions;

  // 비활성 소스는 빈 배열로 즉시 반환 (API 호출 없음)
  const errors = [];

  const commitSearch = commitParams?.enabled
    ? searchCommits(buildSourceQuery("commits"), {
        dataDir: options.dataDir,
        maxResults: commitParams.maxResults ?? DEFAULT_MAX_RESULTS,
      }).catch((err) => {
        console.error("[EvidenceSearch] commits search failed:", err.message);
        errors.push(`commits: ${err.message}`);
        return [];
      })
    : Promise.resolve([]);

  const slackSearch = slackParams?.enabled
    ? searchSlack(buildSourceQuery("slack"), {
        maxResults: slackParams.maxResults ?? DEFAULT_MAX_RESULTS,
      }).catch((err) => {
        console.error("[EvidenceSearch] slack search failed:", err.message);
        errors.push(`slack: ${err.message}`);
        return [];
      })
    : Promise.resolve([]);

  const sessionSearch = sessionParams?.enabled
    ? searchSessionMemory(buildSourceQuery("sessions"), {
        dataDir: options.dataDir,
        maxResults: sessionParams.maxResults ?? DEFAULT_MAX_RESULTS,
      }).catch((err) => {
        console.error("[EvidenceSearch] sessions search failed:", err.message);
        errors.push(`sessions: ${err.message}`);
        return [];
      })
    : Promise.resolve([]);

  const [commits, slack, sessions] = await Promise.all([
    commitSearch,
    slackSearch,
    sessionSearch,
  ]);

  return {
    commits,
    slack,
    sessions,
    totalCount: commits.length + slack.length + sessions.length,
    errors,
  };
}
