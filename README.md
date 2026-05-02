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

## OpenAI Summaries

If `OPENAI_API_KEY` is set, batch generation will try OpenAI summarization first and fall back to local heuristics on failure.

`work-log/.env.local` is loaded automatically.

Optional env vars:

- `OPENAI_API_KEY`
- `WORK_LOG_OPENAI_MODEL` default: `gpt-5.4-mini`
- `WORK_LOG_OPENAI_URL` default: `https://api.openai.com/v1/responses`
- `WORK_LOG_DISABLE_OPENAI=1` to force heuristic mode
- `WORK_LOG_INCLUDE_SESSION_LOGS=1` to opt into Codex/Claude session-log analysis
- `WORK_LOG_INCLUDE_SLACK=1` to opt into Slack context analysis
- `SLACK_TOKEN` or `SLACK_USER_TOKEN`
- `SLACK_USER_ID`
- `SLACK_CHANNEL_IDS` comma-separated channel IDs

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
