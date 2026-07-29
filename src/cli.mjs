import { startServer } from "./server.mjs";
import { runDailyBatch } from "./lib/batch.mjs";
import { registerResumeBatchHook } from "./lib/workLogEventBus.mjs";

const [, , command = "serve", ...rest] = process.argv;

if (command === "batch") {
  // Register the resume candidate hook so that emitWorkLogSaved() triggers it
  // when the daily summary is written (Sub-AC 2-1).
  await registerResumeBatchHook();

  const date = readFlag(rest, "--date");
  const result = await runDailyBatch(date);
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
