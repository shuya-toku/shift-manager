// Vercel serverless function — proxies Claude API for shift history queries.
// Set ANTHROPIC_API_KEY in Vercel dashboard → Settings → Environment Variables.
// Node 18+ built-in fetch is used; no npm packages required.

module.exports = async function handler(req, res) {
  // CORS headers (same-origin on Vercel, but useful for local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY が Vercel の環境変数に設定されていません。',
    });
  }

  const { question, records = [], currentMonth = '' } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question is required' });

  // Format records into a compact text table for the prompt
  const table = records.length === 0
    ? '(データなし — 先にシフトを確定してください)'
    : records
        .map(r =>
          `${r.date} ${r.employee_name}(${r.role}/${r.nationality}) ` +
          `${r.start_time}〜${r.end_time} 休憩${r.break_min}分`
        )
        .join('\n');

  const system = `あなたはシフト管理の補助AIです。必ず日本語で回答してください。
以下の確定済み勤務記録を元に質問に答えてください。

【時間帯の判定ルール】
- 「15時台」= 15:00〜16:00 の間に勤務中の人
- 夜勤の日またぎ: start_time > end_time なら翌日にまたがる (例 22:00〜07:00)
- 「X時に勤務中」= start <= X かつ end > X (夜勤も考慮)

【回答形式】
- 人数 (合計 / ロール別 / 国籍別)
- 名前リスト (ロール付き)
- 必要であれば補足`;

  const userMsg = `対象月: ${currentMonth}\n\n勤務記録:\n${table}\n\n質問: ${question}`;

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Claude API への接続に失敗: ' + e.message });
  }

  if (!claudeRes.ok) {
    const detail = await claudeRes.text();
    return res.status(502).json({ error: 'Claude API エラー', detail });
  }

  const data = await claudeRes.json();
  const answer = data.content?.[0]?.text ?? '(応答なし)';
  return res.json({ answer });
};
