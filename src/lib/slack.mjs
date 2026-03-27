const SLACK_API_BASE = "https://slack.com/api";

export async function collectSlackContexts(date) {
  const token = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  const channelIds = parseCsv(process.env.SLACK_CHANNEL_IDS || process.env.WORK_LOG_SLACK_CHANNEL_IDS || "");
  const configuredUserId = process.env.SLACK_USER_ID || process.env.WORK_LOG_SLACK_USER_ID || "";

  if (!token || !channelIds.length) return [];

  const auth = await slackGet("auth.test", {}, token);
  const ownUserId = configuredUserId || auth.user_id;
  if (!ownUserId) return [];

  const oldest = `${Math.floor(new Date(`${date}T00:00:00+09:00`).getTime() / 1000)}`;
  const latest = `${Math.floor(new Date(`${date}T23:59:59+09:00`).getTime() / 1000)}`;
  const contexts = [];

  for (const channelId of channelIds) {
    const history = await slackGet("conversations.history", {
      channel: channelId,
      oldest,
      latest,
      inclusive: "true",
      limit: "200"
    }, token);

    const messages = (history.messages || [])
      .filter((message) => message.type === "message")
      .sort((left, right) => Number(left.ts) - Number(right.ts));

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.user !== ownUserId) continue;

      const nearby = collectNearbyContext(messages, index, ownUserId);
      const threadContext = message.thread_ts
        ? await collectThreadContext(channelId, message.thread_ts, ownUserId, token)
        : [];

      contexts.push({
        channelId,
        ts: message.ts,
        text: cleanSlackText(message.text),
        context: uniqueContext([...nearby, ...threadContext])
      });
    }
  }

  return contexts.slice(0, 40);
}

async function collectThreadContext(channelId, threadTs, ownUserId, token) {
  try {
    const replies = await slackGet("conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: "20",
      inclusive: "true"
    }, token);

    return (replies.messages || [])
      .filter((message) => message.user && message.user !== ownUserId)
      .slice(0, 3)
      .map((message) => cleanSlackText(message.text))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectNearbyContext(messages, index, ownUserId) {
  const context = [];
  for (const offset of [-2, -1, 1, 2]) {
    const message = messages[index + offset];
    if (!message || message.user === ownUserId) continue;
    const text = cleanSlackText(message.text);
    if (text) context.push(text);
  }
  return context;
}

async function slackGet(method, params, token) {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error || "unknown_error"}`);
  }

  return data;
}

function cleanSlackText(text) {
  return String(text || "")
    .replace(/<@[^>]+>/g, "@user")
    .replace(/<#[^|>]+\|?([^>]+)?>/g, "#channel")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(raw) {
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueContext(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= 4) break;
  }
  return output;
}
