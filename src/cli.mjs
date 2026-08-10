import { startServer } from "./server.mjs";
import { runDailyBatch } from "./lib/batch.mjs";

const [, , command = "serve", ...rest] = process.argv;

if (command === "batch") {
  const allowLlm = rest.includes("--allow-llm");

  const date = readFlag(rest, "--date");
  const result = await runDailyBatch(date, { allowLlm });
  console.log(JSON.stringify({
    date: result.date,
    counts: result.counts,
    paths: result.paths
  }, null, 2));
  process.exit(0);
}

if (command === "export-profiles") {
  // Manual/on-demand trigger for the member work-style profile pipeline —
  // an emergency handle when the daily cron is down or a refresh is needed now.
  // Optional positional args = specific user ids; none = all configured users.
  const { runProfileExport } = await import("./lib/profileExport.mjs");
  const userIds = rest.filter((a) => !a.startsWith("--"));
  const result = await runProfileExport(userIds.length ? { userIds } : {});
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "refresh-profiles") {
  // Local-only weekly enrichment. runWorkStyleAnalysis owns the seven-day
  // freshness gate; profile publishing runs only when the LLM result changed.
  const [{ getAuthUsers }, { runWorkStyleAnalysis }, { runProfileExport }] = await Promise.all([
    import("./lib/authUsers.mjs"),
    import("./lib/serverCollect.mjs"),
    import("./lib/profileExport.mjs")
  ]);
  const requestedIds = rest.filter((arg) => !arg.startsWith("--"));
  const configuredIds = getAuthUsers().map((user) => user.id);
  const userIds = requestedIds.length ? requestedIds : (configuredIds.length ? configuredIds : ["default"]);
  const analyses = {};
  const refreshed = [];
  const results = [];

  for (const userId of userIds) {
    const result = await runWorkStyleAnalysis({ userId });
    results.push({ userId, ...result, analysis: undefined });
    if (result.llmRefreshed && result.analysis) {
      analyses[userId] = result.analysis;
      refreshed.push(userId);
    }
  }

  const profiles = refreshed.length
    ? await runProfileExport({ userIds: refreshed, analyses })
    : { built: [], skipped: true, reason: "no_changed_analysis" };
  console.log(JSON.stringify({ users: userIds, results, profiles }, null, 2));
  process.exit(0);
}

if (command === "serve") {
  const port = Number(readFlag(rest, "--port") || 4310);
  const host = readFlag(rest, "--host") || "localhost";
  await startServer(port, host);
  console.log(`Work Log server listening on http://${host}:${port}`);
  process.exitCode = 0;
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}
