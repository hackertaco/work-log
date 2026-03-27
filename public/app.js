const seoulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const archiveTrigger = document.querySelector("#archive-trigger");
const archiveCurrent = document.querySelector("#archive-current");
const archiveMenu = document.querySelector("#archive-menu");
const statusNode = document.querySelector("#status");
const worklogView = document.querySelector("#worklog-view");
const resumeView = document.querySelector("#resume-view");
const dateInput = document.querySelector("#date-input");
const runBatchButton = document.querySelector("#run-batch");
const tabs = document.querySelectorAll(".tab");
const urlState = new URL(window.location.href);
let profileData = null;

dateInput.value = seoulDate;

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((node) => node.classList.toggle("is-active", node === tab));
    const isWorklog = tab.dataset.tab === "worklog";
    worklogView.classList.toggle("is-hidden", !isWorklog);
    resumeView.classList.toggle("is-hidden", isWorklog);
  });
});

runBatchButton.addEventListener("click", async () => {
  const date = dateInput.value;
  setStatus(`${date} 배치 실행 중...`);
  const response = await fetch("/api/run-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date })
  });
  const payload = await response.json();
  renderDay(payload);
  await loadDays();
  setStatus(`${date} 배치 완료`);
});

await loadDays();
await loadProfile();

async function loadDays() {
  const response = await fetch("/api/days");
  const days = await response.json();
  renderDays(days);
  const requestedDate = urlState.searchParams.get("date");
  if (requestedDate && days.includes(requestedDate)) {
    await loadDay(requestedDate, { replaceUrl: true });
  } else if (days[0]) {
    await loadDay(days[0], { replaceUrl: true });
  } else {
    worklogView.innerHTML = "<p>아직 생성된 업무로그가 없습니다.</p>";
    resumeView.innerHTML = "<p>이력서 후보가 아직 없습니다.</p>";
  }
}

async function loadDay(date, options = {}) {
  setStatus(`${date} 불러오는 중...`);
  const response = await fetch(`/api/day/${date}`);
  const payload = await response.json();
  renderDay(payload);
  archiveCurrent.textContent = date;
  closeArchiveMenu();
  syncDateInUrl(date, options.replaceUrl);
  setStatus(`${date} 로드됨`);
}

async function loadProfile() {
  try {
    const response = await fetch("/api/profile");
    profileData = await response.json();
  } catch {
    profileData = null;
  }
}

function renderDays(days) {
  archiveMenu.innerHTML = "";
  for (const day of days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "archive-option";
    button.role = "option";
    button.textContent = day;
    button.addEventListener("click", () => loadDay(day));
    archiveMenu.append(button);
  }
}

archiveTrigger.addEventListener("click", () => {
  const nextExpanded = archiveTrigger.getAttribute("aria-expanded") !== "true";
  archiveTrigger.setAttribute("aria-expanded", String(nextExpanded));
  archiveMenu.classList.toggle("is-hidden", !nextExpanded);
});

document.addEventListener("click", (event) => {
  if (!archiveTrigger.contains(event.target) && !archiveMenu.contains(event.target)) {
    closeArchiveMenu();
  }
});

function closeArchiveMenu() {
  archiveTrigger.setAttribute("aria-expanded", "false");
  archiveMenu.classList.add("is-hidden");
}

function syncDateInUrl(date, replace = false) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("date", date);
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", nextUrl);
}

function renderDay(payload) {
  if (payload.missing) {
    worklogView.innerHTML = `<p>${payload.date} 데이터가 없습니다.</p>`;
    resumeView.innerHTML = "<p>이력서 후보가 없습니다.</p>";
    return;
  }

  const stories = payload.highlights.storyThreads || [];
  const leadStory = stories[0];
  const secondaryStories = stories.slice(1);

  worklogView.innerHTML = `
    <section class="stat-bar">
      <article class="stat-card stat-card-primary">
        <p class="stat-label">Date</p>
        <p class="stat-value">${escapeHtml(payload.date)}</p>
      </article>
      <article class="stat-card">
        <p class="stat-label">Total Commits</p>
        <p class="stat-value">${payload.counts.gitCommits}</p>
      </article>
      <article class="stat-card">
        <p class="stat-label">Company</p>
        <p class="stat-value">${payload.counts.companyCommits || 0}</p>
      </article>
      <article class="stat-card">
        <p class="stat-label">Open Source</p>
        <p class="stat-value">${payload.counts.openSourceCommits || 0}</p>
      </article>
    </section>

    <div class="section-divider"></div>

    <section class="story-layout">
      ${leadStory ? `
        <article class="lead-story">
          <p class="section-kicker">Lead Story</p>
          <h2 class="story-title">${escapeHtml(leadStory.outcome)}</h2>
          <div class="story-grid">
            <div class="story-line">
              <span class="story-label">Key change</span>
              <p>${escapeHtml(leadStory.keyChange || "없음")}</p>
            </div>
            <div class="story-line">
              <span class="story-label">Impact</span>
              <p>${escapeHtml(leadStory.impact || "없음")}</p>
            </div>
            <div class="story-line">
              <span class="story-label">Why it matters</span>
              <p>${escapeHtml(leadStory.why || "없음")}</p>
            </div>
            ${leadStory.decision ? `
              <div class="story-line">
                <span class="story-label">Judgment</span>
                <p>${escapeHtml(leadStory.decision)}</p>
              </div>
            ` : ""}
          </div>
        </article>
      ` : ""}

      <div class="story-column">
        ${secondaryStories.length
          ? secondaryStories.map((story, index) => `
            <article class="compact-story">
              <p class="section-kicker">Story ${index + 2}</p>
              <h3 class="compact-story-title">${escapeHtml(story.outcome)}</h3>
              <div class="compact-story-copy">
                <p><strong>Key</strong> ${escapeHtml(story.keyChange || "없음")}</p>
                <p><strong>Impact</strong> ${escapeHtml(story.impact || "없음")}</p>
                <p><strong>Why</strong> ${escapeHtml(story.why || "없음")}</p>
                ${story.decision ? `<p><strong>Judgment</strong> ${escapeHtml(story.decision)}</p>` : ""}
              </div>
            </article>
          `).join("")
          : `<article class="compact-story compact-story-empty"><p>추가 story 없음</p></article>`}
      </div>
    </section>

    <div class="section-divider"></div>

    <section class="notes-layout">
      <article class="side-card">
        <p class="section-kicker">Analysis</p>
        <h3>커밋 분석</h3>
        <ul class="list">${(payload.highlights.commitAnalysis || []).length
          ? payload.highlights.commitAnalysis.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
          : "<li>없음</li>"}</ul>
      </article>

      <article class="side-card">
        <p class="section-kicker">AI Review</p>
        <h3>AI 평가</h3>
        <ul class="list">${(payload.highlights.aiReview || []).length
          ? payload.highlights.aiReview.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
        : "<li>없음</li>"}</ul>
      </article>
    </section>

    <div class="section-divider"></div>

    <section class="project-links-inline">
      <p><strong>회사 프로젝트</strong> · ${(payload.projectGroups?.company || []).length} repo · ${(payload.projectGroups?.company || []).reduce((sum, project) => sum + project.commitCount, 0)} commits · <a href="/projects.html?date=${encodeURIComponent(payload.date)}&group=company">상세 보기</a></p>
      <p><strong>오픈소스 프로젝트</strong> · ${(payload.projectGroups?.opensource || []).length} repos · ${(payload.projectGroups?.opensource || []).reduce((sum, project) => sum + project.commitCount, 0)} commits · <a href="/projects.html?date=${encodeURIComponent(payload.date)}&group=opensource">상세 보기</a></p>
    </section>
  `;

  resumeView.innerHTML = `
    <section class="resume-layout">
    <article class="plain-section">
      <p class="section-kicker">Company Resume</p>
      <h3>회사 이력서 후보</h3>
      <ul class="list">${(payload.resume.companyCandidates || []).length
        ? payload.resume.companyCandidates.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Open Source Resume</p>
      <h3>오픈소스 이력서 후보</h3>
      <ul class="list">${(payload.resume.openSourceCandidates || []).length
        ? payload.resume.openSourceCandidates.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Combined View</p>
      <h3>통합 후보</h3>
      <ul class="list">${payload.resume.candidates.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Source</p>
      <h3>출처</h3>
      <p>${escapeHtml(payload.resume.notes)}</p>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Strengths</p>
      <h3>강점 신호</h3>
      <ul class="list">${(profileData?.strengths || []).length
        ? profileData.strengths.map((item) => `<li>${escapeHtml(item.label)} <span class="mono">${item.score}</span></li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Tech Signals</p>
      <h3>기술 강점</h3>
      <ul class="list">${(profileData?.techSignals || []).length
        ? profileData.techSignals.map((item) => `<li>${escapeHtml(item.label)} <span class="mono">${item.score}</span></li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Work Style</p>
      <h3>장기 작업 성향</h3>
      <ul class="list">${(profileData?.workStyle || []).length
        ? profileData.workStyle.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    <article class="plain-section">
      <p class="section-kicker">Project Arcs</p>
      <h3>장기 프로젝트 그루핑</h3>
      <ul class="list">${(profileData?.projectArcs || []).length
        ? profileData.projectArcs.slice(0, 5).map((item) => `<li><strong>${escapeHtml(item.repo)}</strong> · ${escapeHtml(item.summary)}</li>`).join("")
        : "<li>없음</li>"}</ul>
    </article>
    </section>
  `;
}

function setStatus(value) {
  statusNode.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
