import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * DisplayAxesView — 서사 축(narrative axes) 뷰
 *
 * 서사 축을 강점 구성(strength composition) 관점에서 시각화하는 컴포넌트.
 * 각 축은 여러 강점을 엮어 만든 **상위 수준의 커리어 내러티브**이며,
 * 이 뷰는 그 구성 관계를 직관적으로 보여준다.
 *
 * ── 상태 분리 원칙 (Sub-AC 24a) ────────────────────────────────────────────
 *
 *   이 컴포넌트는 resume 상태와 **완전히 분리**된 독립 뷰다.
 *
 *   1. props 없음 — resume 객체를 받지 않고, resume를 수정하는 콜백
 *      (onResumePatched, setResume 등)도 받지 않는다.
 *
 *   2. 모든 데이터는 자체 fetch로 로드한다:
   *        GET /api/resume/narrative-axes → 서사 축 목록 (with strengthComposition)
 *        GET /api/resume/axes/staleness → 미분류 키워드 비율
 *
 *   3. 축 변경 이벤트(재클러스터링)는 API 호출로만 처리된다:
 *        POST /api/resume/axes/recluster
 *      응답 결과를 로컬 상태(axes, staleness)로만 반영하며,
 *      상위 resume 상태(ResumePage.resume)를 직접 수정하지 않는다.
 *
 *   4. 단방향 데이터 흐름 보장:
 *        API 응답 → 로컬 상태(axes / staleness) → 렌더링
 *      이벤트가 역방향으로 resume 데이터를 변경하는 경로가 없다.
 *
 * ── 표시 내용 ───────────────────────────────────────────────────────────────
 *
 *   - 각 축의 이름(label), 설명(description), 구성 강점(strengthComposition)
 *   - 강점별 "역할(role)" — 해당 강점이 이 축에서 담당하는 내러티브 역할
 *   - 대표 불릿(supportingBullets) — 축을 대표하는 증거 문장
 *   - 축 간 커버리지 요약 (총 강점/프로젝트 수, 미분류 수)
 *   - 미분류 키워드 비율이 임계값(30%) 초과 시 재클러스터링 안내 배너
 *
 * props: 없음 (독립 컴포넌트 — resume 상태와 결합 없음)
 */
export function DisplayAxesView() {
  // ── 표시 축 상태 ─────────────────────────────────────────────────────────
  /** @type {[import('./AxesPanel').Axis[]|null, function]} */
  const [axes, setAxes] = useState(null);
  const [axesLoading, setAxesLoading] = useState(true);
  const [axesError, setAxesError] = useState('');

  // ── 신선도(staleness) 상태 ───────────────────────────────────────────────
  /**
   * @type {[{
   *   ratio: number,
   *   totalKeywords: number,
   *   unclassifiedCount: number,
   *   unclassifiedKeywords?: string[],
   *   threshold: number,
   *   shouldRecluster: boolean
   * }|null, function]}
   */
  const [staleness, setStaleness] = useState(null);
  const [stalenessLoading, setStalenessLoading] = useState(false);
  const [stalenessError, setStalenessError] = useState('');

  // ── 재클러스터링 상태 ────────────────────────────────────────────────────
  const [reclustering, setReclustering] = useState(false);
  const [reclusterError, setReclusterError] = useState('');
  const [reclusterSuccess, setReclusterSuccess] = useState(false);

  // ── 서사 스레딩 상태 ────────────────────────────────────────────────────
  const [threading, setThreading] = useState(null);
  const [threadingLoading, setThreadingLoading] = useState(false);
  const [threadingError, setThreadingError] = useState('');
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineSuccess, setPipelineSuccess] = useState(false);

  // ── 식별된 강점 상태 ────────────────────────────────────────────────────
  const [strengths, setStrengths] = useState(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 마운트 시 축 목록 + 신선도 + 스레딩 + 강점 동시 로드
  useEffect(() => {
    fetchAxes();
    fetchStaleness();
    fetchThreading();
    fetchStrengths();
  }, []);

  // ── 데이터 로드 ──────────────────────────────────────────────────────────

  /**
   * GET /api/resume/narrative-axes — 서사 축 목록 로드
   *
   * 단방향 흐름: API → axes 로컬 상태 → 렌더링
   * resume 상태를 건드리지 않는다.
   */
  async function fetchAxes() {
    setAxesLoading(true);
    setAxesError('');
    try {
      const res = await fetch('/api/resume/narrative-axes', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setAxes(data.axes ?? []);
      }
    } catch (err) {
      if (mountedRef.current) {
        setAxesError(err.message);
        setAxes([]);
      }
    } finally {
      if (mountedRef.current) setAxesLoading(false);
    }
  }

  /**
   * GET /api/resume/axes/staleness — 미분류 키워드 비율 확인
   *
   * 단방향 흐름: API → staleness 로컬 상태 → 배너 렌더링
   * 결과가 shouldRecluster=true여도 resume 상태를 변경하지 않는다.
   */
  async function fetchStaleness() {
    setStalenessLoading(true);
    setStalenessError('');
    try {
      const res = await fetch('/api/resume/axes/staleness', { credentials: 'include' });
      if (!res.ok) {
        // 404 = 아직 이력서 없음, 무시
        if (res.status === 404) {
          if (mountedRef.current) setStaleness(null);
          return;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setStaleness(data);
      }
    } catch (err) {
      if (mountedRef.current) {
        setStalenessError(err.message);
      }
    } finally {
      if (mountedRef.current) setStalenessLoading(false);
    }
  }

  // ── 재클러스터링 ─────────────────────────────────────────────────────────

  /**
   * POST /api/resume/axes/recluster — 미분류 키워드 비율 초과 시 재클러스터링 실행
   *
   * 축 변경 이벤트 처리 원칙:
   *   - API 호출 결과를 로컬 axes 상태로만 반영한다.
   *   - 상위 resume 상태(ResumePage.resume)를 직접 수정하지 않는다.
   *   - 단방향 흐름: 버튼 클릭 → POST API → 로컬 axes/staleness 갱신 → 재렌더링
   *
   * @param {boolean} [force=false] 임계값 무시하고 강제 재클러스터링
   */
  async function triggerRecluster(force = false) {
    setReclustering(true);
    setReclusterError('');
    setReclusterSuccess(false);
    try {
      const res = await fetch('/api/resume/axes/recluster', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        // API 결과를 로컬 상태에만 반영 (resume 상태 수정 없음)
        if (Array.isArray(data.axes)) {
          setAxes(data.axes);
        } else {
          // 서버가 axes를 반환하지 않으면 재조회
          await fetchAxes();
        }
        setReclusterSuccess(true);
        // staleness 재확인
        fetchStaleness();
        // 3초 후 성공 메시지 숨기기
        setTimeout(() => {
          if (mountedRef.current) setReclusterSuccess(false);
        }, 3000);
      }
    } catch (err) {
      if (mountedRef.current) {
        setReclusterError(err.message);
      }
    } finally {
      if (mountedRef.current) setReclustering(false);
    }
  }

  // ── 서사 스레딩 데이터 로드 ───────────────────────────────────────────

  /**
   * GET /api/resume/narrative-threading — 스레딩 결과 로드
   *
   * 각 불릿이 어떤 강점·축과 연결되는지를 보여주는 어노테이션 데이터.
   */
  async function fetchThreading() {
    setThreadingLoading(true);
    setThreadingError('');
    try {
      const res = await fetch('/api/resume/narrative-threading', { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 404) {
          if (mountedRef.current) setThreading(null);
          return;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setThreading(data);
      }
    } catch (err) {
      if (mountedRef.current) {
        setThreadingError(err.message);
      }
    } finally {
      if (mountedRef.current) setThreadingLoading(false);
    }
  }

  /**
   * GET /api/resume/identified-strengths — 식별된 강점 로드
   */
  async function fetchStrengths() {
    try {
      const res = await fetch('/api/resume/identified-strengths', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setStrengths(data.strengths || []);
      }
    } catch {
      // Non-fatal — strengths are supplementary info
    }
  }

  /**
   * POST /api/resume/narrative-threading/run — 서사 스레딩 파이프라인 실행
   *
   * 에피소드 → 강점 식별 → 서사 축 생성 → 불릿 스레딩 전체 실행.
   */
  async function triggerPipeline(force = false) {
    setPipelineRunning(true);
    setPipelineSuccess(false);
    setThreadingError('');
    try {
      const res = await fetch('/api/resume/narrative-threading/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        setPipelineSuccess(true);
        // 결과 새로고침
        fetchAxes();
        fetchThreading();
        fetchStrengths();
        setTimeout(() => {
          if (mountedRef.current) setPipelineSuccess(false);
        }, 4000);
      }
    } catch (err) {
      if (mountedRef.current) {
        setThreadingError(err.message);
      }
    } finally {
      if (mountedRef.current) setPipelineRunning(false);
    }
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  const totalKeywords = staleness?.totalKeywords ?? 0;
  const unclassifiedCount = staleness?.unclassifiedCount ?? 0;
  const unclassifiedKeywords = staleness?.unclassifiedKeywords ?? [];
  const ratioPct = staleness ? Math.round(staleness.ratio * 100) : 0;
  const shouldRecluster = staleness?.shouldRecluster ?? false;

  return (
    <section class="dav-root" aria-label="서사 축 분석">
      {/* 헤더 */}
      <header class="dav-header">
        <div class="dav-header-left">
          <h3 class="dav-title">Narrative Axes</h3>
          {staleness && (
            <span
              class={`dav-coverage-badge${shouldRecluster ? ' dav-coverage-badge--warn' : ''}`}
              title={`전체 ${totalKeywords}개 키워드 중 ${unclassifiedCount}개(${ratioPct}%) 미분류`}
            >
              {totalKeywords > 0
                ? `${totalKeywords - unclassifiedCount}/${totalKeywords}`
                : '0/0'}
            </span>
          )}
        </div>
        <button
          class="dav-refresh-btn"
          type="button"
          onClick={() => { fetchAxes(); fetchStaleness(); }}
          title="프로필 분석 새로고침"
          aria-label="새로고침"
          disabled={axesLoading}
        >
          ↻
        </button>
      </header>

      {/* 재클러스터링 권고 배너 */}
      {shouldRecluster && !reclustering && (
        <div class="dav-recluster-banner" role="alert">
          <span class="dav-banner-msg">
            미분류 키워드가 {ratioPct}%로 임계값을 초과했습니다.
          </span>
          <button
            class="dav-recluster-btn"
            type="button"
            onClick={() => triggerRecluster(false)}
            disabled={reclustering}
          >
            축 재편성
          </button>
        </div>
      )}

      {/* 재클러스터링 진행 중 */}
      {reclustering && (
        <div class="dav-state">
          <span class="dav-spinner" aria-label="재편성 중" />
          <span class="dav-state-msg">프로필 축 재편성 중…</span>
        </div>
      )}

      {/* 재클러스터링 성공 메시지 */}
      {reclusterSuccess && (
        <p class="dav-recluster-success" role="status">
          프로필 축이 업데이트되었습니다.
        </p>
      )}

      {/* 재클러스터링 오류 */}
      {reclusterError && (
        <p class="dav-recluster-error" role="alert">{reclusterError}</p>
      )}

      {/* 로딩 */}
      {axesLoading && !reclustering && (
        <div class="dav-state">
          <span class="dav-spinner" aria-label="불러오는 중" />
          <span class="dav-state-msg">불러오는 중…</span>
        </div>
      )}

      {/* 오류 */}
      {!axesLoading && axesError && (
        <div class="dav-state dav-state--error">
          <p class="dav-error-msg">{axesError}</p>
          <button class="dav-retry-btn" type="button" onClick={fetchAxes}>
            다시 시도
          </button>
        </div>
      )}

      {/* 빈 상태 */}
      {!axesLoading && !axesError && axes !== null && axes.length === 0 && (
        <div class="dav-empty">
          <p class="dav-empty-msg">No narrative axes yet.</p>
          <p class="dav-empty-hint">
            Once enough work logs and strengths are identified, 2-3 narrative axes
            will be generated automatically — each composing multiple strengths into
            a coherent career theme.
          </p>
        </div>
      )}

      {/* 축 목록 — 서사 축 뷰 (읽기 전용, 강점 구성 표시) */}
      {!axesLoading && !axesError && axes !== null && axes.length > 0 && (
        <ol class="dav-axes-list" role="list">
          {axes.map((axis, idx) => {
            const composition = axis.strengthComposition || [];
            const bullets = axis.supportingBullets || [];
            // Per-axis grounding status from threading report
            const axisGrounding = threading?.groundingReport?.axisGrounding?.[axis.id];
            const groundingStatus = axisGrounding?.status || null;
            const groundingBulletCount = axisGrounding?.bulletCount || 0;
            // Cross-section info: which sections thread through this axis
            const axisCoverage = threading?.axisCoverage?.[axis.id];
            const connectedSections = axisCoverage?.sections || [];
            return (
              <li key={axis.id} class="dav-axis-item">
                <div class="dav-axis-header">
                  {/* 축 번호 */}
                  <span class="dav-axis-index" aria-hidden="true">
                    {idx + 1}
                  </span>
                  {/* 축 이름 */}
                  <span class="dav-axis-label">{axis.label}</span>
                  {/* 구성 강점 수 배지 */}
                  {composition.length > 0 && (
                    <span class="dav-strength-count" title={`${composition.length}개 강점으로 구성`}>
                      {composition.length} strengths
                    </span>
                  )}
                  {/* Grounding status badge */}
                  {groundingStatus && (
                    <span
                      class={`dav-grounding-badge dav-grounding-badge--${groundingStatus}`}
                      title={
                        groundingStatus === 'well-grounded'
                          ? `${groundingBulletCount}개 불릿에서 근거 확인 (충분)`
                          : groundingStatus === 'weakly-grounded'
                          ? `${groundingBulletCount}개 불릿에서만 근거 확인 (보강 필요)`
                          : '이력서 불릿에서 근거를 찾지 못함'
                      }
                    >
                      {groundingStatus === 'well-grounded' ? '✓' : groundingStatus === 'weakly-grounded' ? '△' : '○'}
                    </span>
                  )}
                </div>
                {/* 축 설명 (description) — tagline 대신 풍부한 내러티브 */}
                {axis.description && <p class="dav-axis-description">{axis.description}</p>}
                {/* tagline 호환 (레거시 데이터 지원) */}
                {!axis.description && axis.tagline && <p class="dav-axis-description">{axis.tagline}</p>}

                {/* 구성 강점 목록 — 각 강점이 이 축에서 맡는 역할 */}
                {composition.length > 0 && (
                  <div class="dav-composition">
                    <p class="dav-composition-label">Composed of:</p>
                    <ul class="dav-composition-list">
                      {composition.map((entry) => (
                        <li key={entry.strengthId} class="dav-composition-item">
                          <span class="dav-composition-strength">{entry.label}</span>
                          {entry.role && (
                            <span class="dav-composition-role">{entry.role}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 대표 불릿 — 축을 대표하는 증거 문장 */}
                {bullets.length > 0 && (
                  <div class="dav-bullets">
                    <p class="dav-bullets-label">Evidence:</p>
                    <ul class="dav-bullets-list">
                      {bullets.map((b, bIdx) => (
                        <li key={bIdx} class="dav-bullet-item">{b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Cross-section threading: which resume sections this axis threads through */}
                {connectedSections.length > 0 && (
                  <div class="dav-cross-section">
                    <span class="dav-cross-section-label">Threads through:</span>
                    {connectedSections.map((sec) => (
                      <span key={sec} class="dav-cross-section-tag">
                        {sec === 'experience' ? 'Experience' : sec === 'projects' ? 'Projects' : sec}
                      </span>
                    ))}
                    {groundingBulletCount > 0 && (
                      <span class="dav-cross-section-count">{groundingBulletCount} bullets</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* ── 식별된 강점 서사 섹션 (Identified Strengths Narratives) ────── */}
      {strengths && strengths.length > 0 && (
        <section class="dav-strengths-section" aria-label="식별된 강점">
          <h4 class="dav-strengths-title">식별된 강점 (Identified Strengths)</h4>
          <p class="dav-strengths-subtitle">
            {strengths.length} behavioral pattern{strengths.length !== 1 ? 's' : ''} identified from evidence episodes
          </p>
          <div class="dav-strengths-list">
            {strengths.map((str) => {
              const narrative = _davBuildNarrative(str.description, str.reasoning);
              const repoList = Array.isArray(str.repos) ? str.repos : [];
              const bullets = Array.isArray(str.exampleBullets) ? str.exampleBullets : [];
              const evidenceCount = Array.isArray(str.evidenceIds) ? str.evidenceIds.length : 0;
              const projectCount = Array.isArray(str.projectIds) ? str.projectIds.length : 0;

              return (
                <article key={str.id} class="dav-strength-item">
                  <div class="dav-strength-header">
                    <h5 class="dav-strength-label">{str.label}</h5>
                    {repoList.length > 0 && (
                      <span class="dav-strength-scope" title={repoList.join(', ')}>
                        {repoList.length === 1
                          ? repoList[0].split('/').pop()
                          : `${repoList.length} repos`}
                      </span>
                    )}
                  </div>

                  {/* Integrated narrative: description + reasoning merged naturally */}
                  {narrative && (
                    <p class="dav-strength-narrative">{narrative}</p>
                  )}

                  {/* Evidence bullets with repo context */}
                  {bullets.length > 0 && (
                    <div class="dav-strength-evidence">
                      <span class="dav-strength-evidence-label">Evidence:</span>
                      <ul class="dav-strength-evidence-list">
                        {bullets.slice(0, 3).map((b, bIdx) => (
                          <li key={bIdx} class="dav-strength-evidence-item">
                            {b}
                            {repoList.length === 1 && bIdx === 0 && (
                              <span class="dav-strength-evidence-repo">
                                — {repoList[0].split('/').pop()}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Depth indicator: episodes + projects */}
                  {(evidenceCount > 0 || projectCount > 0) && (
                    <p class="dav-strength-depth">
                      {evidenceCount > 0 && `${evidenceCount} episode${evidenceCount !== 1 ? 's' : ''}`}
                      {evidenceCount > 0 && projectCount > 0 && ' · '}
                      {projectCount > 0 && `${projectCount} project${projectCount !== 1 ? 's' : ''}`}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 서사 스레딩 요약 섹션 ────────────────────────────────────────── */}
      {threading && threading.bulletAnnotations && threading.bulletAnnotations.length > 0 && (
        <section class="dav-threading-summary" aria-label="서사 연결 현황">
          <h4 class="dav-threading-title">서사 연결 (Threading)</h4>
          <div class="dav-threading-stats">
            <div class="dav-stat">
              <span class="dav-stat-number">{threading.totalAnnotations || 0}</span>
              <span class="dav-stat-label">연결된 불릿</span>
            </div>
            <div class="dav-stat">
              <span class="dav-stat-number">
                {Math.round((threading.groundedRatio || 0) * 100)}%
              </span>
              <span class="dav-stat-label">근거 기반</span>
            </div>
            {strengths && strengths.length > 0 && (
              <div class="dav-stat">
                <span class="dav-stat-number">{strengths.length}</span>
                <span class="dav-stat-label">식별 강점</span>
              </div>
            )}
          </div>

          {/* 섹션별 스레딩 요약 */}
          {threading.sectionSummaries && threading.sectionSummaries.length > 0 && (
            <div class="dav-section-threads">
              {threading.sectionSummaries.map((summary, idx) => {
                const threadRatio = summary.totalBulletCount > 0
                  ? Math.round((summary.threadedBulletCount / summary.totalBulletCount) * 100)
                  : 0;
                const dominantStrengthLabels = (summary.dominantStrengthIds || [])
                  .map((id) => {
                    const str = (strengths || []).find((s) => s.id === id);
                    return str ? str.label : null;
                  })
                  .filter(Boolean);
                const dominantAxisLabels = (summary.dominantAxisIds || [])
                  .map((id) => {
                    const ax = (axes || []).find((a) => a.id === id);
                    return ax ? ax.label : null;
                  })
                  .filter(Boolean);

                return (
                  <div key={`${summary.section}-${summary.itemIndex}`} class="dav-section-thread">
                    <div class="dav-section-thread-header">
                      <span class="dav-section-thread-label">{summary.itemLabel}</span>
                      <span class={`dav-thread-ratio${threadRatio >= 60 ? ' dav-thread-ratio--good' : ''}`}>
                        {summary.threadedBulletCount}/{summary.totalBulletCount}
                      </span>
                    </div>
                    {dominantStrengthLabels.length > 0 && (
                      <div class="dav-thread-tags">
                        {dominantStrengthLabels.map((label) => (
                          <span key={label} class="dav-thread-tag dav-thread-tag--strength">{label}</span>
                        ))}
                      </div>
                    )}
                    {dominantAxisLabels.length > 0 && (
                      <div class="dav-thread-tags">
                        {dominantAxisLabels.map((label) => (
                          <span key={label} class="dav-thread-tag dav-thread-tag--axis">{label}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 근거 없는 항목 경고 */}
          {threading.groundingReport?.summary?.ungroundedCount > 0 && (
            <div class="dav-ungrounded-warn" role="alert">
              <span class="dav-ungrounded-msg">
                {threading.groundingReport.summary.ungroundedCount}개 항목이 이력서 불릿에서 근거를 찾지 못했습니다.
              </span>
            </div>
          )}
        </section>
      )}

      {/* 서사 스레딩 파이프라인 트리거 */}
      {!pipelineRunning && !threadingLoading && axes !== null && (
        <div class="dav-pipeline-trigger">
          <button
            class="dav-pipeline-btn"
            type="button"
            onClick={() => triggerPipeline(!threading || threading.totalAnnotations === 0)}
            disabled={pipelineRunning}
          >
            {threading && threading.totalAnnotations > 0 ? '서사 연결 재생성' : '서사 연결 생성'}
          </button>
          {threading && threading.totalAnnotations > 0 && (
            <button
              class="dav-pipeline-force-btn"
              type="button"
              onClick={() => triggerPipeline(true)}
              disabled={pipelineRunning}
              title="기존 결과를 무시하고 전체 재생성"
            >
              강제 재생성
            </button>
          )}
        </div>
      )}

      {/* 파이프라인 실행 중 */}
      {pipelineRunning && (
        <div class="dav-state">
          <span class="dav-spinner" aria-label="서사 연결 생성 중" />
          <span class="dav-state-msg">서사 연결 분석 중… (에피소드 → 강점 → 축 → 스레딩)</span>
        </div>
      )}

      {/* 파이프라인 성공 */}
      {pipelineSuccess && (
        <p class="dav-recluster-success" role="status">
          서사 연결이 생성되었습니다.
        </p>
      )}

      {/* 스레딩 오류 */}
      {threadingError && (
        <p class="dav-recluster-error" role="alert">{threadingError}</p>
      )}

      {/* 신선도 요약 — 전체 커버리지 수치 */}
      {!stalenessLoading && staleness && axes !== null && axes.length > 0 && (
        <footer class="dav-summary">
          <span class="dav-summary-text">
            총 {totalKeywords}개 키워드 · 분류됨 {totalKeywords - unclassifiedCount}개
            {unclassifiedCount > 0 && (
              <> · <span class="dav-summary-warn">미분류 {unclassifiedCount}개 ({ratioPct}%)</span></>
            )}
          </span>
          {!shouldRecluster && (
            <button
              class="dav-force-recluster-btn"
              type="button"
              onClick={() => triggerRecluster(true)}
              disabled={reclustering}
              title="임계값과 무관하게 축을 강제 재편성합니다"
            >
              강제 재편성
            </button>
          )}
        </footer>
      )}

      {/* 신선도 오류 (비치명적, 축 목록 표시에 영향 없음) */}
      {stalenessError && (
        <p class="dav-staleness-error" role="alert">
          신선도 확인 실패: {stalenessError}
        </p>
      )}

      {!stalenessLoading && unclassifiedKeywords.length > 0 && (
        <section class="dav-unclassified" aria-label="미분류 키워드">
          <div class="dav-unclassified-head">
            <h4 class="dav-unclassified-title">미분류 키워드</h4>
            <span class="dav-unclassified-count">{unclassifiedKeywords.length}개</span>
          </div>
          <p class="dav-unclassified-copy">
            현재 어떤 축에도 들어가지 않은 키워드입니다. 축 이름을 손보거나 새 축을 만들 때 우선 참고할 목록입니다.
          </p>
          <div class="dav-unclassified-tags">
            {unclassifiedKeywords.map((kw) => (
              <span key={kw} class="dav-unclassified-tag">{kw}</span>
            ))}
          </div>
        </section>
      )}

      <style>{DAV_CSS}</style>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Helpers                                                               */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Build an integrated narrative paragraph from description and reasoning.
 *
 * Merges both into a single flowing text suitable for resume consumption.
 * If reasoning adds new information beyond description, appends it as a
 * continuation. If they overlap, uses the more complete one.
 *
 * @param {string} description
 * @param {string} reasoning
 * @returns {string}
 */
function _davBuildNarrative(description, reasoning) {
  const desc = (description || '').trim();
  const reason = (reasoning || '').trim();

  if (!desc && !reason) return '';
  if (!reason) return desc;
  if (!desc) return reason;

  // Simple overlap check: if leading portion of reasoning appears in description
  const reasonStart = reason.slice(0, 40).toLowerCase();
  const descLower = desc.toLowerCase();
  if (descLower.includes(reasonStart) || reasonStart.includes(descLower.slice(0, 40))) {
    return desc.length >= reason.length ? desc : reason;
  }

  // Combine with natural sentence boundary
  const normalizedDesc = /[.!?]$/.test(desc) ? desc : `${desc}.`;
  const looksLikeProperNoun = reason.length > 1 && /^[A-Z][a-z]/.test(reason);
  const flowReason = looksLikeProperNoun
    ? reason
    : (reason.charAt(0).toLowerCase() + reason.slice(1));

  return `${normalizedDesc} ${flowReason}`;
}

/* ──────────────────────────────────────────────────────────────────── */
/* Styles                                                               */
/* ──────────────────────────────────────────────────────────────────── */

const DAV_CSS = `
  .dav-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Header ─── */
  .dav-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .dav-header-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .dav-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    white-space: nowrap;
  }

  /* 전체 커버리지 배지 (헤더 우측) */
  .dav-coverage-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 600;
    color: #2f855a;
    background: #f0fff4;
    border: 1px solid #c6f6d5;
    border-radius: 999px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .dav-coverage-badge--warn {
    color: #c05621;
    background: #fffaf0;
    border-color: #fbd38d;
  }

  .dav-refresh-btn {
    padding: 2px 6px;
    font-size: 16px;
    line-height: 1;
    color: var(--muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }

  .dav-refresh-btn:hover:not(:disabled) {
    color: var(--ink);
    background: var(--surface);
  }

  .dav-refresh-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Recluster banner ─── */
  .dav-recluster-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: #fffaf0;
    border: 1px solid #fbd38d;
    border-radius: var(--radius-md);
  }

  .dav-banner-msg {
    font-size: 12px;
    color: #c05621;
    flex: 1;
    min-width: 0;
  }

  .dav-recluster-btn {
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    color: #c05621;
    background: #feebcb;
    border: 1px solid #fbd38d;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.12s, border-color 0.12s;
  }

  .dav-recluster-btn:hover:not(:disabled) {
    background: #fbd38d;
    border-color: #ed8936;
  }

  .dav-recluster-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ─── Status messages ─── */
  .dav-state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .dav-state--error {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .dav-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: dav-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes dav-spin {
    to { transform: rotate(360deg); }
  }

  .dav-state-msg {
    font-size: 13px;
    color: var(--muted);
  }

  .dav-error-msg {
    margin: 0;
    font-size: 13px;
    color: #e53e3e;
  }

  .dav-retry-btn {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 0.15s;
  }

  .dav-retry-btn:hover {
    background: var(--line);
  }

  .dav-recluster-success {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: 12px;
    font-weight: 600;
    color: #2f855a;
    background: #f0fff4;
    border: 1px solid #c6f6d5;
    border-radius: var(--radius-md);
  }

  .dav-recluster-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
  }

  .dav-staleness-error {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }

  .dav-unclassified {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .dav-unclassified-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .dav-unclassified-title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--ink);
  }

  .dav-unclassified-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }

  .dav-unclassified-copy {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.55;
  }

  .dav-unclassified-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .dav-unclassified-tag {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
  }

  /* ─── Empty state ─── */
  .dav-empty {
    padding: var(--space-3) 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .dav-empty-msg {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .dav-empty-hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    opacity: 0.7;
  }

  /* ─── Axes list (profile analysis view) ─── */
  .dav-axes-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    counter-reset: none;
  }

  .dav-axis-item {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: border-color 0.15s;
  }

  .dav-axis-item:hover {
    border-color: var(--line-strong);
  }

  .dav-axis-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 22px;
  }

  /* 순서 번호 */
  .dav-axis-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 50%;
    flex-shrink: 0;
    user-select: none;
  }

  /* 축 이름 — 읽기 전용 텍스트 (편집 불가) */
  .dav-axis-label {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dav-axis-description {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }

  /* ─── Strength count badge ─── */
  .dav-strength-count {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: 600;
    color: #553c9a;
    background: #faf5ff;
    border: 1px solid #e9d8fd;
    border-radius: 999px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ─── Strength composition ─── */
  .dav-composition {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 4px;
  }

  .dav-composition-label {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dav-composition-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .dav-composition-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid #805ad5;
    border-radius: var(--radius-sm);
  }

  .dav-composition-strength {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
  }

  .dav-composition-role {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.5;
    font-style: italic;
  }

  /* ─── Identified Strengths narrative section ─── */
  .dav-strengths-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .dav-strengths-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink);
  }

  .dav-strengths-subtitle {
    margin: 0;
    font-size: 11.5px;
    color: var(--muted);
    font-style: italic;
  }

  .dav-strengths-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .dav-strength-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: rgba(248, 250, 252, 0.6);
    border: 1px solid rgba(17, 24, 39, 0.06);
    border-left: 3px solid #805ad5;
    border-radius: var(--radius-sm);
  }

  .dav-strength-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .dav-strength-label {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--ink);
    line-height: 1.35;
  }

  .dav-strength-scope {
    font-size: 10.5px;
    font-weight: 500;
    color: var(--muted);
    font-style: italic;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .dav-strength-narrative {
    margin: 0;
    font-size: 12px;
    line-height: 1.65;
    color: var(--ink);
  }

  .dav-strength-evidence {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }

  .dav-strength-evidence-label {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dav-strength-evidence-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .dav-strength-evidence-item {
    font-size: 11.5px;
    color: var(--ink);
    line-height: 1.5;
    padding-left: 14px;
    position: relative;
    opacity: 0.88;
  }

  .dav-strength-evidence-item::before {
    content: "\\2022";
    position: absolute;
    left: 2px;
    color: var(--muted);
  }

  .dav-strength-evidence-repo {
    display: inline;
    margin-left: 4px;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--muted);
    opacity: 0.7;
    font-style: italic;
  }

  .dav-strength-depth {
    margin: 0;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--muted);
    font-style: italic;
    opacity: 0.65;
  }

  /* ─── Supporting bullets ─── */
  .dav-bullets {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 4px;
  }

  .dav-bullets-label {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dav-bullets-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dav-bullet-item {
    font-size: 12px;
    color: var(--ink);
    line-height: 1.5;
    padding-left: 14px;
    position: relative;
  }

  .dav-bullet-item::before {
    content: "\\2022";
    position: absolute;
    left: 2px;
    color: var(--muted);
  }

  /* ─── Summary footer ─── */
  .dav-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .dav-summary-text {
    font-size: 11px;
    color: var(--muted);
    flex: 1;
    min-width: 0;
  }

  .dav-summary-warn {
    color: #c05621;
    font-weight: 600;
  }

  .dav-force-recluster-btn {
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }

  .dav-force-recluster-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
    background: var(--surface);
  }

  .dav-force-recluster-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Narrative threading summary ─── */
  .dav-threading-summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
    border: 1px solid #d6bcfa;
    border-radius: var(--radius-md);
  }

  .dav-threading-title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    color: #553c9a;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dav-threading-stats {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .dav-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 60px;
  }

  .dav-stat-number {
    font-size: 18px;
    font-weight: 700;
    color: #553c9a;
    line-height: 1.1;
  }

  .dav-stat-label {
    font-size: 10px;
    font-weight: 600;
    color: #805ad5;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Section threading list */
  .dav-section-threads {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 4px;
  }

  .dav-section-thread {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px;
    background: rgba(255,255,255,0.7);
    border: 1px solid #e9d8fd;
    border-radius: var(--radius-sm);
  }

  .dav-section-thread-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .dav-section-thread-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dav-thread-ratio {
    font-size: 11px;
    font-weight: 600;
    color: #805ad5;
    flex-shrink: 0;
  }

  .dav-thread-ratio--good {
    color: #2f855a;
  }

  .dav-thread-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .dav-thread-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.4;
  }

  .dav-thread-tag--strength {
    color: #553c9a;
    background: #e9d8fd;
  }

  .dav-thread-tag--axis {
    color: #2b6cb0;
    background: #bee3f8;
  }

  /* Ungrounded warning */
  .dav-ungrounded-warn {
    padding: 6px 10px;
    background: #fffaf0;
    border: 1px solid #fbd38d;
    border-radius: var(--radius-sm);
  }

  .dav-ungrounded-msg {
    font-size: 11px;
    color: #c05621;
    font-weight: 500;
  }

  /* Pipeline trigger buttons */
  .dav-pipeline-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-top: var(--space-1);
  }

  .dav-pipeline-btn {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background: #805ad5;
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 0.15s;
  }

  .dav-pipeline-btn:hover:not(:disabled) {
    background: #6b46c1;
  }

  .dav-pipeline-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dav-pipeline-force-btn {
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }

  .dav-pipeline-force-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
  }

  .dav-pipeline-force-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Grounding badge (per-axis evidence status) ─── */
  .dav-grounding-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    font-size: 10px;
    font-weight: 700;
    border-radius: 50%;
    flex-shrink: 0;
    line-height: 1;
  }

  .dav-grounding-badge--well-grounded {
    color: #2f855a;
    background: #f0fff4;
    border: 1px solid #c6f6d5;
  }

  .dav-grounding-badge--weakly-grounded {
    color: #c05621;
    background: #fffaf0;
    border: 1px solid #fbd38d;
  }

  .dav-grounding-badge--ungrounded {
    color: #e53e3e;
    background: #fff5f5;
    border: 1px solid #fed7d7;
  }

  /* ─── Cross-section threading (per-axis) ─── */
  .dav-cross-section {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
    flex-wrap: wrap;
  }

  .dav-cross-section-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .dav-cross-section-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
    color: #2b6cb0;
    background: #ebf8ff;
    border: 1px solid #bee3f8;
    border-radius: 999px;
    white-space: nowrap;
  }

  .dav-cross-section-count {
    font-size: 10px;
    color: var(--muted);
    font-weight: 500;
  }

  /* ─── Print: hide from printed resume ─── */
  @media print {
    .dav-root {
      display: none !important;
    }
  }
`;
