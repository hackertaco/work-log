import { readWorkStyleAnalysis } from "./blob.mjs";
import { synthesizeHandover } from "./handoverSynthesis.mjs";
import { renderMemberProfile } from "./memberProfile.mjs";
import { commitProfilesToKb } from "./kbCommit.mjs";
import { notifyMemberProfile } from "./slackNotify.mjs";
import { loadConfig } from "./config.mjs";
import { getAuthUsers } from "./authUsers.mjs";

const OWNER = process.env.KB_REPO_OWNER || "driving-teacher-bot";
const REPO = process.env.KB_REPO_NAME || "driving-teacher-knowledge-base";
const BASE = process.env.KB_BASE_BRANCH || "main";
const BRANCH = "profiles/auto";

export async function runProfileExport({ userIds, now = new Date().toISOString(), fetchImpl = fetch } = {}) {
  const users = getAuthUsers();
  const nameOf = (id) => users.find((u) => u.id === id)?.name || id;
  const ids = userIds ?? users.map((u) => u.id);

  const built = [], files = [];
  for (const id of ids) {
    const analysis = await readWorkStyleAnalysis(id).catch(() => null);
    if (!analysis?.principles?.length) continue;
    const handover = await synthesizeHandover(analysis, fetchImpl).catch(() => null);
    const content = renderMemberProfile({ name: nameOf(id), analysis, handover, generatedAt: now, windowDays: analysis.windowDays ?? 30 });
    files.push({ path: `raw/people/${id}.md`, content });
    built.push(id);
  }
  if (!files.length) return { built, commit: { committed: false, reason: "nothing to build" } };

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { built, commit: { committed: false, reason: "no token" } };

  const commit = await commitProfilesToKb({ owner: OWNER, repo: REPO, base: BASE, branch: BRANCH, files, token, fetchImpl });

  // best-effort notify for changed members
  const slackToken = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  for (const path of commit.changed ?? []) {
    const id = path.replace(/^raw\/people\//, "").replace(/\.md$/, "");
    const config = await Promise.resolve(loadConfig({ userId: id })).catch(() => null);
    const slackUserId = config?.slackUserId || "";
    const url = `https://github.com/${OWNER}/${REPO}/blob/${BASE}/${path}`;
    await notifyMemberProfile({ slackUserId, url, token: slackToken, fetchImpl }).catch(() => false);
  }
  return { built, commit };
}
