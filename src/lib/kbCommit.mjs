// src/lib/kbCommit.mjs
// KB 레포에 프로필 파일을 GitHub REST로 커밋한다. 로컬 git 불필요(Vercel에서 HTTPS).
const API = "https://api.github.com";

export function contentChanged(existingBase64, newText) {
  if (!existingBase64) return true;
  const decoded = Buffer.from(String(existingBase64).replace(/\n/g, ""), "base64").toString("utf8");
  return decoded !== newText;
}

async function gh(fetchImpl, token, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(init.headers || {}) }
  });
  return res;
}

export async function commitProfilesToKb({ owner, repo, base, branch, files, token, fetchImpl = fetch }) {
  const changed = [], skipped = [];
  // 1) base head + ensure work branch
  const refRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/ref/heads/${base}`);
  const baseSha = (await refRes.json())?.object?.sha;
  if (baseSha) {
    // ensure work branch exists at base head: check first, create if missing, else fast-forward
    const branchRefRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const branchSha = branchRefRes.status === 200 ? (await branchRefRes.json())?.object?.sha : null;
    if (!branchSha) {
      const created = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
      if (created.status === 422) {
        await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: baseSha, force: true }) });
      }
    }
  }
  // 2) per file: get existing on branch, PUT if changed
  for (const f of files) {
    const getRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}?ref=${branch}`);
    const existing = getRes.status === 200 ? await getRes.json() : null;
    if (!contentChanged(existing?.content ?? null, f.content)) { skipped.push(f.path); continue; }
    await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore(profiles): update ${f.path}`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch, ...(existing?.sha ? { sha: existing.sha } : {})
      })
    });
    changed.push(f.path);
  }
  if (!changed.length) return { changed, skipped, committed: false };
  // 3) open (or reuse) PR and merge
  const prRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: "chore: member work-style profiles", head: branch, base }) });
  let pr = prRes.status === 201 ? (await prRes.json())?.number : undefined;
  if (!pr) {
    const listRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&base=${base}&state=open`);
    pr = (await listRes.json())?.[0]?.number;
  }
  let merged = false;
  if (pr) {
    const mergeRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls/${pr}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
    merged = mergeRes.status === 200;
  }
  return { changed, skipped, committed: true, pr, merged };
}
