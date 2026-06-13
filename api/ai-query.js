// Vercel serverless function — SCOPE の AIアシスタント（キャパシティ＆人員配置の予測/相談）。
// クライアントが集計した「シフト在席 × お問い合わせ実績」のコンパクトな文脈(contextText)と
// 会話履歴(history)を受け取り、Claude (Opus 4.8 + adaptive thinking) に渡して回答を返す。
// Vercel ダッシュボード → Settings → Environment Variables に ANTHROPIC_API_KEY を設定すること。
// 関数の最大実行時間(maxDuration)は vercel.json の functions で延長している。
// Node 18+ 組み込み fetch を使用（npm依存なし）。

const MODEL = 'claude-opus-4-8';

const SYSTEM = `あなたは「SCOPE（SQA Capacity & Operator Planning Engine）」の人員配置アシスタントです。
SQAマネージャーが、過去のお問い合わせ実績とシフト在席状況をもとに「これからの人員配置」を考えるのを助けます。

【役割】
- 与えられた実績データ（時間帯×曜日の在席人数・お問い合わせ要対応数・取りこぼし(Missed)）を読み、相関と傾向を説明する。
- 「来月どう配置すべきか」「この曜日の昼は何人必要か」などの予測・配置提案に、根拠データを添えて具体的に答える。
- 取りこぼしが出ている時間帯（特に有人なのにMissed＝過負荷、または無人時間）を優先課題として指摘する。

【データの前提（必ず守る）】
- 「在席」は DE（データ入力）を除いたお問い合わせ対応可能な人数。
- お問い合わせ実績は2026-02以降のみ。当月分は AI電話以外（メール/ビデオ/電話）が月次手動取込のため遅れて入り、過小評価になりやすい。データが薄い月はその旨を断る。
- 推定キャパ（1人あたり処理件数）はデータから読み取れる範囲で推定し、仮定を明示する。数字を捏造しない。データが無い項目は「データなし」と述べる。

【回答スタイル】
- 必ず日本語。結論→根拠の順。要点を先に1〜2行で。
- 配置提案は「曜日×時間帯×必要人数（±現状差）」の表や箇条書きで具体的に。
- 不確実な点・データの限界は正直に書く。過度に長くしない。`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が Vercel の環境変数に設定されていません。' });
  }

  const body = req.body || {};
  const question = (body.question || '').toString().trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  // 後方互換: 旧クライアントは records[] を送ってくる。新クライアントは contextText を送る。
  let contextText = (body.contextText || '').toString();
  if (!contextText && Array.isArray(body.records)) {
    contextText = body.records.length
      ? '勤務記録:\n' + body.records.map(r =>
          `${r.date} ${r.employee_name}(${r.role}/${r.nationality}) ${r.start_time}〜${r.end_time} 休憩${r.break_min}分`).join('\n')
      : '(シフトデータなし)';
  }
  if (body.currentMonth) contextText = `対象月: ${body.currentMonth}\n` + contextText;

  // 会話履歴（user/assistant の配列）を整形。最後に今回の質問＋データ文脈を user として付ける。
  const history = Array.isArray(body.history) ? body.history : [];
  const messages = [];
  for (const m of history) {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const userContent = (contextText ? `【利用可能なデータ】\n${contextText}\n\n` : '') + `【質問】\n${question}`;
  messages.push({ role: 'user', content: userContent });
  // 先頭は必ず user（履歴の整合性を担保）
  if (messages[0].role !== 'user') messages.shift();

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
        model: MODEL,
        max_tokens: 3500,
        thinking: { type: 'adaptive' },        // 予測/配置設計は推論を要するため適応的思考をON
        output_config: { effort: 'medium' },    // 対話用に応答速度とのバランス
        system: SYSTEM,
        messages,
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
  if (data.stop_reason === 'refusal') {
    return res.json({ answer: '申し訳ありません。この内容にはお答えできませんでした。質問を変えてお試しください。' });
  }
  // adaptive thinking では content に thinking ブロックが含まれるため text ブロックのみ抽出
  const answer = (data.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim() || '(応答が空でした)';
  return res.json({ answer });
};
