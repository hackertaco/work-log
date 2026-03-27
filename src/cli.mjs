import { startServer } from "./server.mjs";
import { runDailyBatch } from "./lib/batch.mjs";

const [, , command = "serve", ...rest] = process.argv;

if (command === "batch") {
  const date = readFlag(rest, "--date");
  const result = await runDailyBatch(date);
  console.log(JSON.stringify({
    date: result.date,
    counts: result.counts,
    paths: result.paths
  }, null, 2));
  process.exit(0);
}

if (command === "serve") {
  const port = Number(readFlag(rest, "--port") || 4310);
  await startServer(port);
  console.log(`Work Log server listening on http://127.0.0.1:${port}`);
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
