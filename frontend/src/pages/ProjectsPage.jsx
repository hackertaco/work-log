import { useEffect, useState } from 'preact/hooks';
import './worklog.css';

export function ProjectsPage() {
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date');
  const group = params.get('group');

  const [projects, setProjects] = useState([]);
  const [title, setTitle] = useState('Project Details');
  const [subtitle, setSubtitle] = useState('날짜와 그룹에 해당하는 커밋 상세를 보여줍니다.');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!date || !group) {
      setTitle('잘못된 요청');
      setSubtitle('date와 group 파라미터가 필요합니다.');
      setError('date와 group 파라미터가 필요합니다.');
      return;
    }

    setTitle(`${date} ${labelFor(group)}`);
    setSubtitle(`${labelFor(group)} 커밋 상세`);
    void loadProjects(date, group);
  }, [date, group]);

  async function loadProjects(nextDate, nextGroup) {
    try {
      const response = await fetch(`/api/day/${encodeURIComponent(nextDate)}`);
      if (!response.ok) {
        throw new Error(`프로젝트 상세를 불러오지 못했습니다. HTTP ${response.status}`);
      }

      const payload = await response.json();
      setProjects(payload.projectGroups?.[nextGroup] || []);
      setError('');
    } catch (err) {
      setProjects([]);
      setError(err.message || '프로젝트 상세를 불러오지 못했습니다.');
    }
  }

  return (
    <div class="worklog-page">
      <main class="worklog-shell">
        <section class="worklog-hero">
          <div class="worklog-hero-copy">
            <p class="worklog-eyebrow">EDITORIAL ARCHIVE</p>
            <h1>{title}</h1>
            <p class="worklog-lede">{subtitle}</p>
          </div>

          <div class="worklog-actions">
            <a class="worklog-back-link" href="/">대시보드로 돌아가기</a>
          </div>
        </section>

        <section class="worklog-panel">
          {error ? (
            <div class="worklog-state">
              <p>{error}</p>
            </div>
          ) : null}

          {!error && !projects.length ? (
            <div class="worklog-state">
              <p>표시할 커밋이 없습니다.</p>
            </div>
          ) : null}

          {!error && projects.length ? (
            <div class="worklog-project-list">
              {projects.map((project) => (
                <article key={project.repo} class="worklog-info-card">
                  <p class="worklog-section-kicker">{project.category || 'project'}</p>
                  <h3>{project.repo}</h3>
                  <p class="worklog-project-summary">{project.commitCount} commits</p>
                  <ul class="worklog-list">
                    {(project.commits || []).map((commit) => (
                      <li key={`${project.repo}-${commit.hash}`}>
                        {commit.subject} <span class="worklog-mono">{commit.hash}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function labelFor(value) {
  if (value === 'company') return '회사 프로젝트';
  if (value === 'opensource') return '오픈소스 프로젝트';
  return '기타 프로젝트';
}
