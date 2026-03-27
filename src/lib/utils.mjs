import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, "../..");

export function expandHome(inputPath) {
  if (!inputPath || inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      rows.push({ parseError: true, raw: trimmed.slice(0, 500) });
    }
  }
  return rows;
}

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[`#>*_]/g, "")
    .replace(/\[(assistant|user)\]\s*/gi, "")
    .trim();
}

export function clip(value, max = 180) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

export function uniqueStrings(values, max = 8) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = clip(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= max) break;
  }
  return output;
}

export function isNoiseSnippet(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return true;

  const prefixes = [
    "you are codex",
    "<permissions instructions",
    "you have oh-my-codex installed",
    "agents.md instructions",
    "<environmentcontext",
    "<collaborationmode",
    "<skillsinstructions",
    "i'm observing",
    "i observe",
    "<summary",
    "<observation",
    "<identity",
    "<skill",
    "no observation needed",
    "/users/",
    "xml <observation",
    "<system>",
    "<local-command-caveat",
    "<command-name",
    "<command-message",
    "<local-command-stdout",
    "ouroboros interview",
    "proceed.",
    "reply with"
  ];

  return prefixes.some((prefix) => text.startsWith(prefix));
}

export function looksLikeQuestion(value) {
  const text = cleanText(value);
  return (
    text.endsWith("?") ||
    text.includes("인가요") ||
    text.includes("무엇") ||
    text.includes("어떤 ") ||
    text.includes("어떻게 ") ||
    text.includes("궁금합니다")
  );
}

export function isPathInsideRoots(targetPath, roots = []) {
  if (!targetPath) return false;
  const normalizedTarget = path.resolve(targetPath);
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

export function compactSummary(value, max = 160) {
  const text = clip(
    cleanText(value)
      .replace(/^#+\s*/g, "")
      .replace(/^[-:]\s*/g, "")
      .replace(/reply with:.*/i, "")
      .replace(/session:\s*`?[^`]+`?/i, "")
      .replace(/status:\s*`?[^`]+`?/i, "")
      .replace(/next:\s*/i, "")
      .trim(),
    max
  );

  return text;
}

export function scoreSummaryCandidate(value) {
  const text = cleanText(value);
  if (!text || isNoiseSnippet(text)) return -100;

  let score = 0;

  if (!looksLikeQuestion(text)) score += 4;
  else score -= 8;
  if (text.length >= 24) score += 2;
  if (text.length <= 220) score += 1;
  if (/(만들|구현|추가|수정|검토|분석|정리|확인|설계|연결|삭제|진단|요약|생성|자동화)/.test(text)) score += 5;
  if (/(완료|통과|동작|확인했습니다|만들었습니다|추가했습니다|제거|삭제했습니다)/.test(text)) score += 3;
  if (/^(##|session:|status:|next:)/i.test(text)) score -= 4;
  if (/(reply with|waitingforinput|not started|in_progress)/i.test(text)) score -= 6;

  return score;
}

export function parseDateArg(dateArg) {
  const date = dateArg || todayInSeoul();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  return date;
}

export function todayInSeoul() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

export function ymdParts(date) {
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

export function startEndForDate(date) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);
  return { start, end };
}

export function isTimestampOnDate(value, date) {
  if (value == null) return false;
  const timestamp = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) return false;
  return timestamp.toISOString().slice(0, 10) === date;
}

export async function walk(dirPath, options = {}) {
  const {
    maxDepth = 4,
    include = () => true
  } = options;
  const output = [];

  async function traverse(currentPath, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await traverse(fullPath, depth + 1);
        continue;
      }
      if (include(fullPath, entry)) {
        output.push(fullPath);
      }
    }
  }

  await traverse(dirPath, 0);
  return output;
}

export function collectTextSnippets(node, snippets = []) {
  if (!node || snippets.length >= 20) return snippets;

  if (typeof node === "string") {
    const text = clip(node);
    if (text.length > 20) snippets.push(text);
    return snippets;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectTextSnippets(item, snippets);
      if (snippets.length >= 20) break;
    }
    return snippets;
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && /(text|message|summary|title|reason)/i.test(key)) {
        const text = clip(value);
        if (text.length > 20) snippets.push(text);
      } else if (typeof value === "object") {
        collectTextSnippets(value, snippets);
      }
      if (snippets.length >= 20) break;
    }
  }

  return snippets;
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, "utf8");
}
