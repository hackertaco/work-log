// scripts/verify-no-resume.mjs
// Builds the frontend with resume DISABLED and asserts the resume bundle is gone.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CANARY = "지금 work meaning에서 어디까지 이어졌는지"; // ← exact resume-only string literal from ResumePage.jsx

execFileSync("npx", ["vite", "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_ENABLE_RESUME: "" },
});

const assetsDir = path.join(process.cwd(), "dist", "assets");
const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
const hits = jsFiles.filter((f) => readFileSync(path.join(assetsDir, f), "utf8").includes(CANARY));

if (hits.length) {
  console.error(`FAIL: resume canary found in disabled build: ${hits.join(", ")}`);
  process.exit(1);
}
console.log(`OK: resume canary absent from ${jsFiles.length} JS asset(s) in disabled build.`);
