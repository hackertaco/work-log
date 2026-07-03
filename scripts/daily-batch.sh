#!/bin/zsh
# 매일 로컬 업무로그 배치를 돌려 디스크 + Vercel Blob에 기록한다.
# launchd(com.worklog.daily-batch)가 매일 22:00에 실행하며, 자정에 꺼져
# 있던 날을 대비해 어제 날짜를 먼저 백필한 뒤 오늘을 돌린다.
# 수동 실행: ./scripts/daily-batch.sh

set -euo pipefail

REPO_DIR="${0:a:h:h}"
cd "$REPO_DIR"

# launchd 는 PATH 가 비어 있으므로 node 경로를 직접 해석한다 (nvm 대응)
if ! command -v node > /dev/null 2>&1; then
  export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

# Slack/Blob/OpenAI 자격증명 로드
if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

YESTERDAY=$(date -v-1d +%F)

echo "[daily-batch] $(date '+%F %T') backfilling ${YESTERDAY}"
node src/cli.mjs batch --date "$YESTERDAY"

echo "[daily-batch] $(date '+%F %T') running today"
node src/cli.mjs batch

echo "[daily-batch] $(date '+%F %T') done"
