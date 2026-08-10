# Work Log

Personal work-log MVP for:

- collecting Codex / Claude Code session traces
- scanning git commit history and zsh history
- generating Obsidian-friendly daily notes
- surfacing resume update candidates in a small local dashboard

## Commands

```bash
node src/cli.mjs batch --date 2026-03-24
node src/cli.mjs serve --port 4310
```

Open `http://localhost:4310` after starting the server.

## Defaults

If `work-log.config.json` does not exist, the app uses:

- Codex sessions: `~/.codex/sessions`
- Claude Code sessions: `~/.claude/projects`
- zsh history: `~/.zsh_history`
- Obsidian-style vault output: `./vault`
- structured data output: `./data`
- git repo scan root: parent directory of this project

## LLM Summaries

LLM calls go through `src/lib/llmGateway.mjs`. Direct `api.openai.com` billing is blocked unless `WORK_LOG_ALLOW_DIRECT_OPENAI=1` is explicitly set.

On a local machine, the active Responses-compatible `cliproxy` provider in `~/.codex/config.toml` is loaded automatically. Vercel cannot read that file, so configure the proxy URL and bearer as encrypted project environment variables.

LLM env vars:

- `WORK_LOG_LLM_URL` — proxy `/v1` base URL or full `/v1/responses` URL
- `WORK_LOG_LLM_BEARER_TOKEN` — proxy bearer token
- `WORK_LOG_LLM_MODEL` — default: `gpt-5.4-mini`
- `WORK_LOG_DISABLE_LLM=1` — force heuristic mode
- `WORK_LOG_LLM_TIMEOUT_MS` — default: `45000`
- `WORK_LOG_LLM_MAX_OUTPUT_TOKENS` — default: `8192`
- `WORK_LOG_LLM_MAX_CALLS_PER_PROCESS` — default: `100`
- `WORK_LOG_USE_CODEX_PROXY=0` — disable local Codex provider discovery

Legacy `WORK_LOG_OPENAI_*`, `OPENAI_API_KEY`, and `WORK_LOG_DISABLE_OPENAI` are read only for compatibility. A direct OpenAI endpoint still requires `WORK_LOG_ALLOW_DIRECT_OPENAI=1`.

Embeddings are separately disabled by default. They require `WORK_LOG_ENABLE_EMBEDDINGS=1`, `WORK_LOG_EMBEDDING_URL`, and `WORK_LOG_EMBEDDING_BEARER_TOKEN`; the Responses proxy bearer is never reused automatically.

Other optional env vars:

- `WORK_LOG_INCLUDE_SESSION_LOGS=1` to opt into Codex/Claude session-log analysis
- `WORK_LOG_INCLUDE_SLACK=1` to opt into Slack context analysis
- `SLACK_TOKEN` or `SLACK_USER_TOKEN`
- `SLACK_USER_ID`
- `SLACK_CHANNEL_IDS` comma-separated channel IDs

## Cost Architecture Gate

Render the repository cost graph before deployment:

```bash
python3 ~/.codex/skills/audit-api-costs/scripts/render_cost_architecture.py \
  docs/cost-audit/work-log-cost-architecture.json \
  --out-dir docs/cost-audit/generated
```

`cost-audit.json` is the CI source of truth. A `FAIL` result exits non-zero; review `cost-audit.html` or compile `cost-audit.tex` for the visual report.

## Controlled Multi-User Access

This app now supports invite-only multi-user operation without a database.

Set `WORK_LOG_USERS_JSON` to a JSON array of users:

```bash
WORK_LOG_USERS_JSON='[
  {"id":"alice","name":"Alice","token":"alice-secret-token"},
  {"id":"bob","name":"Bob","token":"bob-secret-token"}
]'
```

Behavior:
- Each token maps to one `userId`
- Local worklog data is isolated under `data/users/{userId}/...` and `vault/users/{userId}/...`
- Resume/blob state is isolated under `users/{userId}/resume/...`
- There is no self-serve signup yet; users must be pre-registered by an operator

Compatibility:
- If `WORK_LOG_USERS_JSON` is not set, the app falls back to the legacy single-user `RESUME_TOKEN` flow
- The legacy single-user flow continues to use the default namespace

## Session Privacy

Session logs are disabled by default. On shared machines or shared Claude/Codex storage, the logs do not provide a reliable person identifier, so automatic attribution is unsafe.

Slack is also disabled by default. If enabled, only your authored messages are treated as first-class reasoning signals. Other people's Slack messages are read only as context and should not be quoted into the final work log.

## Output

- Daily JSON: `data/daily/YYYY-MM-DD.json`
- Resume candidate JSON: `data/resume/YYYY-MM-DD.json`
- Daily Obsidian note: `vault/daily/YYYY-MM-DD.md`
- Resume note: `vault/resume/YYYY-MM-DD.md`

## Notes

- This MVP uses deterministic heuristics, not LLM summarization.
- PR ingestion is not wired yet; git commit data is included now.
- You can add a `work-log.config.json` later to override paths or repo roots.
