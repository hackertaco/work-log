import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const WATCH_DIR = path.join(ROOT, "src");
const POLL_MS = 800;

let child = null;
let stopping = false;
let restarting = false;
let lastSignature = "";

async function main() {
  lastSignature = await readTreeSignature(WATCH_DIR);
  startServer();
  poll();
  wireSignals();
}

function startServer() {
  child = spawn(process.execPath, ["src/cli.mjs", "serve"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  child.on("exit", () => {
    child = null;
    if (!stopping && !restarting) {
      // Keep the watcher alive even if the child exits unexpectedly.
      startServer();
    }
  });
}

async function poll() {
  while (!stopping) {
    await sleep(POLL_MS);
    const nextSignature = await readTreeSignature(WATCH_DIR);
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature;
      await restartServer();
    }
  }
}

async function restartServer() {
  if (restarting || stopping) return;
  restarting = true;

  if (child) {
    await stopChild(child);
  }

  if (!stopping) {
    startServer();
  }

  restarting = false;
}

async function stopChild(target) {
  if (!target || target.exitCode !== null) return;

  await new Promise((resolve) => {
    const done = () => resolve();
    target.once("exit", done);
    target.kill("SIGTERM");

    setTimeout(() => {
      if (target.exitCode === null) {
        target.kill("SIGKILL");
      }
    }, 1500);
  });
}

function wireSignals() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      if (child) {
        await stopChild(child);
      }
      process.exit(0);
    });
  }
}

async function readTreeSignature(dir) {
  const entries = [];
  await walk(dir, entries);
  entries.sort((a, b) => a.localeCompare(b));
  return entries.join("|");
}

async function walk(dir, entries) {
  let items = [];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      await walk(fullPath, entries);
      continue;
    }
    if (!item.isFile()) continue;

    const stat = await fs.stat(fullPath);
    const relPath = path.relative(ROOT, fullPath);
    entries.push(`${relPath}:${stat.mtimeMs}:${stat.size}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
