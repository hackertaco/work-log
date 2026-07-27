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
  // 1) base head sha — base is the source of truth, not the (possibly stale) work branch
  const refRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/ref/heads/${base}`);
  const baseSha = (await refRes.json())?.object?.sha;

  // 2) per file: compare against base content, collect only changed files (keep base blob sha for the PUT)
  const toWrite = [];
  for (const f of files) {
    const getRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}?ref=${base}`);
    const existing = getRes.status === 200 ? await getRes.json() : null;
    if (!contentChanged(existing?.content ?? null, f.content)) { skipped.push(f.path); continue; }
    toWrite.push({ path: f.path, content: f.content, sha: existing?.sha });
  }

  // 3) no changes -> no-op: zero branch writes, zero PR, zero merge
  if (!toWrite.length) return { changed, skipped, committed: false };

  // 4) make the work branch a thin, always-fresh mirror of base: create it if missing,
  // or reset it to base head (force) if it already exists — never build on a stale branch.
  const branchRefRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const branchSha = branchRefRes.status === 200 ? (await branchRefRes.json())?.object?.sha : null;
  if (branchSha) {
    await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: baseSha, force: true }) });
  } else {
    await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
  }

  // 5) PUT each changed file (using its base blob sha), only counting it as changed if the write succeeded
  for (const f of toWrite) {
    const putRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore(profiles): update ${f.path}`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch, ...(f.sha ? { sha: f.sha } : {})
      })
    });
    if (putRes.ok) changed.push(f.path);
  }

  if (!changed.length) return { changed, skipped, committed: false };
  // 6) open (or reuse) PR and merge
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
