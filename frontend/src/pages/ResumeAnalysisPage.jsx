import { useEffect, useState } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { ResumeLayout } from '../components/resume/ResumeLayout.jsx';
import { ResumeShell } from '../components/resume/ResumeShell.jsx';
import { DisplayAxesView } from '../components/resume/DisplayAxesView.jsx';
import { AxesPanel } from '../components/resume/AxesPanel.jsx';
import { AxisMergePanel } from '../components/resume/AxisMergePanel.jsx';
import { StrengthKeywordsPanel } from '../components/resume/StrengthKeywordsPanel.jsx';
import { CacheRebuildPanel } from '../components/resume/CacheRebuildPanel.jsx';
import { BulletQualityPanel } from '../components/resume/BulletQualityPanel.jsx';

export function ResumeAnalysisPage() {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'empty' | 'ready' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateMsg, setRegenerateMsg] = useState('');
  const [coherenceReport, setCoherenceReport] = useState(null);
  const [profileDraft, setProfileDraft] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    ensureResumeExists();
  }, []);

  useEffect(() => {
    if (phase === 'ready') {
      fetchCoherenceReport();
      fetchProfileDraft();
    }
  }, [phase, refreshToken]);

  async function ensureResumeExists() {
    setPhase('loading');
    setErrorMsg('');

    try {
      const res = await fetch('/api/resume/status', { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        window.location.href = '/login?next=/resume/analysis';
        return;
      }
      if (!res.ok) {
        throw new Error(`서버 오류: HTTP ${res.status}`);
      }

      const data = await res.json();
      setPhase(data.exists ? 'ready' : 'empty');
    } catch (err) {
      setErrorMsg(err.message || '분석 화면을 불러오지 못했습니다.');
      setPhase('error');
    }
  }

  async function fetchCoherenceReport() {
    try {
      const res = await fetch('/api/resume/coherence-validation', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setCoherenceReport(null);
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setCoherenceReport(data);
      }
    } catch {
      setCoherenceReport(null);
    }
  }

  async function fetchProfileDraft() {
    try {
      const res = await fetch('/api/profile?window=30', { credentials: 'include' });
      if (!res.ok) {
        setProfileDraft(null);
        return;
      }
      const data = await res.json();
      setProfileDraft(data?.resumeDraft || null);
    } catch {
      setProfileDraft(null);
    }
  }

  async function handleManualRegenerate() {
    setRegenerating(true);
    setRegenerateMsg('');
    try {
      const reconstructRes = await fetch('/api/resume/reconstruct', {
        method: 'POST',
        credentials: 'include',
      });
      const reconstructData = await reconstructRes.json().catch(() => ({}));
      if (!reconstructRes.ok) {
        throw new Error(reconstructData.error || `HTTP ${reconstructRes.status}`);
      }

      const threadingRes = await fetch('/api/resume/narrative-threading/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const threadingData = await threadingRes.json().catch(() => ({}));
      if (!threadingRes.ok) {
        throw new Error(threadingData.error || `HTTP ${threadingRes.status}`);
      }

      setRegenerateMsg('분석 데이터를 다시 생성했습니다.');
      setRefreshToken((prev) => prev + 1);
    } catch (err) {
      setRegenerateMsg(err.message || '재생성에 실패했습니다.');
    } finally {
      setRegenerating(false);
    }
  }

  if (phase === 'loading') {
    return (
      <ResumeShell activePage="analysis">
        <div class="rap-state">
          <div class="resume-spinner" aria-label="불러오는 중" />
          <p class="rap-state-msg">분석 화면 불러오는 중…</p>
        </div>
        <style>{RAP_CSS}</style>
      </ResumeShell>
    );
  }

  if (phase === 'error') {
    return (
      <ResumeShell activePage="analysis">
        <div class="rap-state">
          <p class="rap-error">{errorMsg}</p>
          <button class="rap-primary-btn" type="button" onClick={ensureResumeExists}>
            다시 시도
          </button>
        </div>
        <style>{RAP_CSS}</style>
      </ResumeShell>
    );
  }

  if (phase === 'empty') {
    return (
      <ResumeShell activePage="analysis">
        <div class="rap-state">
          <h2 class="rap-empty-title">먼저 이력서를 만들어야 합니다.</h2>
          <p class="rap-state-msg">
            분석 화면은 저장된 이력서와 보조 데이터가 있을 때 의미가 있습니다.
          </p>
          <button class="rap-primary-btn" type="button" onClick={() => navigate('/resume')}>
            이력서 편집으로 이동
          </button>
        </div>
        <style>{RAP_CSS}</style>
      </ResumeShell>
    );
  }

  return (
    <ResumeShell activePage="analysis">
      <ResumeLayout
        body={
          <div key={`analysis-body-${refreshToken}`} class="rap-body">
            <section class="rap-hero">
              <div>
                <p class="rap-kicker">Resume Analysis</p>
                <h1 class="rap-title">이력서를 어떤 방향으로 쓸지 정하는 작업대입니다.</h1>
                <p class="rap-copy">
                  축은 이력서 본문에 직접 노출하는 섹션이 아니라, summary·강점·포지셔닝을
                  어떤 방향으로 가져갈지 판단하는 분석 도구로 사용합니다.
                </p>
              </div>
              <div class="rap-hero-actions">
                <button
                  class="rap-primary-btn"
                  type="button"
                  onClick={handleManualRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? '재생성 중…' : '분석 재생성'}
                </button>
                <a class="rap-secondary-link" href="/resume">
                  편집 화면으로 돌아가기
                </a>
              </div>
            </section>

            {regenerateMsg && <p class="rap-inline-msg">{regenerateMsg}</p>}

            <ProfileDraftPanel draft={profileDraft} />
            <CoherencePanel report={coherenceReport} />
            <p class="rap-inline-msg">
              강점 후보와 서사 축은 본문 이력서에 직접 노출하지 않고, 이 분석 화면에서 먼저 다듬습니다.
            </p>
            <DisplayAxesView />
          </div>
        }
        panel={
          <div key={`analysis-panel-${refreshToken}`} class="rap-panel-stack">
            <StrengthKeywordsPanel />
            <AxesPanel />
            <AxisMergePanel />
            <CacheRebuildPanel />
            <BulletQualityPanel />
          </div>
        }
      />
      <style>{RAP_CSS}</style>
    </ResumeShell>
  );
}

function ProfileDraftPanel({ draft }) {
  return (
    <section class="rap-card" aria-label="프로필 초안">
      <div class="rap-card-head">
        <div>
          <p class="rap-card-kicker">Profile Draft</p>
          <h2 class="rap-card-title">최근 기록이 이력서 초안으로 연결되는 방식</h2>
        </div>
      </div>

      {!draft?.headline && !draft?.summary ? (
        <p class="rap-card-copy">최근 기록으로는 아직 프로필 초안을 만들기 어렵습니다.</p>
      ) : (
        <div class="rap-draft">
          {draft?.headline ? <p class="rap-draft-headline">{draft.headline}</p> : null}
          {draft?.summary ? <p class="rap-draft-summary">{draft.summary}</p> : null}
          {Array.isArray(draft?.strengthLabels) && draft.strengthLabels.length > 0 ? (
            <div class="rap-draft-tags">
              {draft.strengthLabels.map((label) => (
                <span key={label} class="rap-draft-tag">{label}</span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CoherencePanel({ report }) {
  return (
    <section class="rap-card" aria-label="일관성 검증">
      <div class="rap-card-head">
        <div>
          <p class="rap-card-kicker">Coherence</p>
          <h2 class="rap-card-title">이력서 일관성 점검</h2>
        </div>
        {report?.ok !== false && report?.grade && (
          <span class="rap-grade-badge">{report.grade}</span>
        )}
      </div>

      {!report && (
        <p class="rap-card-copy">현재 점검 결과를 불러오지 못했습니다.</p>
      )}

      {report && (
        <>
          <div class="rap-metrics">
            <Metric label="전체" value={Math.round((report.overallScore || 0) * 100)} />
            <Metric label="구조" value={Math.round((report.structuralFlow?.score || 0) * 100)} />
            <Metric label="중복" value={Math.round((report.redundancy?.score || 0) * 100)} />
            <Metric label="톤" value={Math.round((report.tonalConsistency?.score || 0) * 100)} />
          </div>

          {Array.isArray(report.issues) && report.issues.length > 0 && (
            <ul class="rap-issues">
              {report.issues.slice(0, 4).map((issue, index) => (
                <li key={`${issue.path || 'issue'}-${index}`} class="rap-issue">
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div class="rap-metric">
      <span class="rap-metric-value">{value}%</span>
      <span class="rap-metric-label">{label}</span>
    </div>
  );
}

const RAP_CSS = `
  .rap-body,
  .rap-panel-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .rap-hero,
  .rap-card {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    background: rgba(255, 255, 255, 0.74);
    padding: 20px;
  }

  .rap-hero {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
  }

  .rap-kicker,
  .rap-card-kicker {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rap-title,
  .rap-card-title {
    margin: 0;
    color: var(--ink);
  }

  .rap-title {
    font-size: 24px;
    line-height: 1.2;
  }

  .rap-card-title {
    font-size: 18px;
  }

  .rap-copy,
  .rap-card-copy,
  .rap-state-msg,
  .rap-inline-msg {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.5;
  }

  .rap-inline-msg {
    margin-top: 0;
  }

  .rap-hero-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 220px;
  }

  .rap-primary-btn,
  .rap-secondary-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0 14px;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }

  .rap-primary-btn {
    border: 1px solid var(--ink);
    background: var(--ink);
    color: #fff;
  }

  .rap-primary-btn:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .rap-secondary-link {
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.72);
    color: var(--text-strong);
  }

  .rap-card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .rap-grade-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    height: 36px;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(24, 32, 52, 0.92);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
  }

  .rap-metrics {
    margin-top: 16px;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .rap-metric {
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-md);
    padding: 12px;
    background: rgba(248, 246, 240, 0.72);
  }

  .rap-metric-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: var(--ink);
  }

  .rap-metric-label {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .rap-issues {
    margin: 16px 0 0;
    padding-left: 18px;
    display: grid;
    gap: 8px;
  }

  .rap-issue {
    color: var(--text-strong);
    font-size: 13px;
    line-height: 1.45;
  }

  .rap-draft {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }

  .rap-draft-headline {
    margin: 0;
    color: var(--ink);
    font-size: 19px;
    line-height: 1.35;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .rap-draft-summary {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.65;
  }

  .rap-draft-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .rap-draft-tag {
    display: inline-flex;
    align-items: center;
    padding: 7px 10px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    background: rgba(248, 246, 240, 0.72);
    color: var(--text-strong);
    font-size: 12px;
    font-weight: 600;
  }

  .rap-state {
    min-height: 55vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    text-align: center;
  }

  .rap-empty-title,
  .rap-error {
    margin: 0;
    color: var(--ink);
  }

  .rap-error {
    color: #b42318;
  }

  .resume-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: rap-spin 0.7s linear infinite;
  }

  @keyframes rap-spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 900px) {
    .rap-hero {
      flex-direction: column;
    }

    .rap-hero-actions {
      min-width: 0;
      width: 100%;
    }

    .rap-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;
