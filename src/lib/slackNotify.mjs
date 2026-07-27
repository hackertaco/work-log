export async function notifyMemberProfile({ slackUserId, url, token, fetchImpl = fetch }) {
  if (!token || !slackUserId) return false;
  try {
    const open = await fetchImpl("https://slack.com/api/conversations.open", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: slackUserId })
    });
    const channel = (await open.json())?.channel?.id;
    if (!channel) return false;
    const post = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text: `당신의 업무방식 프로필이 KB에 올라갔어요 → ${url}\n관찰된 패턴이라 이상하면 알려주세요.` })
    });
    return (await post.json())?.ok === true;
  } catch { return false; }
}
