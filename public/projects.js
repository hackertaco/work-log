const params = new URLSearchParams(window.location.search);
const date = params.get("date");
const group = params.get("group");

const titleNode = document.querySelector("#title");
const subtitleNode = document.querySelector("#subtitle");
const contentNode = document.querySelector("#content");
const backLink = document.querySelector("#back-link");

backLink.href = "/";

if (!date || !group) {
  titleNode.textContent = "잘못된 요청";
  contentNode.textContent = "date와 group 파라미터가 필요합니다.";
} else {
  titleNode.textContent = `${date} ${labelFor(group)}`;
  subtitleNode.textContent = `${labelFor(group)} 커밋 상세`;
  await load();
}

async function load() {
  const response = await fetch(`/api/day/${date}`);
  const payload = await response.json();
  const projects = payload.projectGroups?.[group] || [];

  if (!projects.length) {
    contentNode.innerHTML = "<p>표시할 커밋이 없습니다.</p>";
    return;
  }

  contentNode.innerHTML = projects.map((project) => `
    <article class="card" style="margin-bottom:16px;">
      <h3>${escapeHtml(project.repo)}</h3>
      <p>${project.commitCount} commits</p>
      <ul class="list">
        ${project.commits.map((commit) => `<li>${escapeHtml(commit.subject)} <span class="mono">${escapeHtml(commit.hash)}</span></li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function labelFor(value) {
  if (value === "company") return "회사 프로젝트";
  if (value === "opensource") return "오픈소스 프로젝트";
  return "기타 프로젝트";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
