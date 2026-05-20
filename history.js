/* ============================================================================
   history.js — Supabase shift history + AI chat
   - If SUPABASE_URL is null: buttons show setup prompt, nothing breaks.
   - Confirm button: pushes current month WORK cells to Supabase (upsert).
   - Chat: fetches month records → calls /api/ai-query → shows Claude answer.
   ============================================================================ */
(function () {
  const TABLE = 'shift_records';

  function ready() {
    return !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
  }

  function sbHeaders(extra) {
    return Object.assign({
      'apikey': window.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${window.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  // ---- Confirm & push current month → Supabase ----
  async function confirmShift() {
    const state = window.ShiftApp?.state;
    if (!state) throw new Error('アプリが初期化されていません');

    const month = state.month;
    const rows = [];

    for (const [date, dayShifts] of Object.entries(state.shift || {})) {
      if (!date.startsWith(month)) continue;
      for (const [empId, cell] of Object.entries(dayShifts)) {
        if (cell.status !== 'WORK') continue;
        const emp = state.employees.find(e => e.id === empId);
        if (!emp) continue;
        rows.push({
          month,
          date,
          employee_id: empId,
          employee_name: emp.name,
          role: (emp.roles || [])[0] || '',
          nationality: emp.nationality || '',
          start_time: cell.start || '',
          end_time: cell.end || '',
          break_min: cell.breakMin || 0,
        });
      }
    }

    if (rows.length === 0) throw new Error('確定するWORKシフトが見つかりません');

    const res = await fetch(`${window.SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Supabase: ${detail}`);
    }
    return rows.length;
  }

  // ---- Fetch month records from Supabase ----
  async function fetchRecords(month) {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const start = `${month}-01`;
    const end   = `${month}-${String(lastDay).padStart(2, '0')}`;

    const url = `${window.SUPABASE_URL}/rest/v1/${TABLE}`
      + `?date=gte.${start}&date=lte.${end}&select=*&order=date.asc,start_time.asc`;

    const res = await fetch(url, { headers: sbHeaders() });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ---- Call /api/ai-query ----
  async function askAI(question, month) {
    const records = await fetchRecords(month);

    const res = await fetch('/api/ai-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, records, currentMonth: month }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI query failed');
    return data.answer;
  }

  // ---- Chat UI helpers ----
  function addMsg(log, role, text) {
    const d = document.createElement('div');
    d.className = `chat-msg chat-${role}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // ---- Init ----
  function init() {
    const confirmBtn = document.getElementById('btn-confirm-shift');
    const sendBtn    = document.getElementById('history-chat-send');
    const input      = document.getElementById('history-chat-input');
    const log        = document.getElementById('history-chat-log');
    if (!confirmBtn || !sendBtn || !input || !log) return;

    // --- Confirm button ---
    confirmBtn.addEventListener('click', async () => {
      if (!ready()) {
        alert('Supabase が未設定です。\nsupabase-config.js に URL と ANON KEY を入力してください。');
        return;
      }
      const month = window.ShiftApp?.state?.month || '';
      if (!confirm(`${month} のシフト (WORK のみ) を Supabase に確定しますか？\n既存レコードは上書きされます。`)) return;

      confirmBtn.disabled = true;
      confirmBtn.textContent = '保存中…';
      try {
        const n = await confirmShift();
        addMsg(log, 'system', `✅ ${month} のシフト ${n} 件を確定しました。`);
      } catch (e) {
        addMsg(log, 'error', '❌ 確定失敗: ' + e.message);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '今月のシフトを確定';
      }
    });

    // --- Chat send ---
    async function send() {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';

      if (!ready()) {
        addMsg(log, 'system', '⚠️ Supabase が未設定です。supabase-config.js を設定してください。');
        return;
      }

      addMsg(log, 'user', q);
      const thinking = addMsg(log, 'assistant', '考え中…');
      sendBtn.disabled = true;

      try {
        const month = document.getElementById('month-input')?.value
          || window.ShiftApp?.state?.month || '';
        const answer = await askAI(q, month);
        thinking.textContent = answer;
        thinking.classList.add('done');
      } catch (e) {
        thinking.textContent = '❌ ' + e.message;
        thinking.classList.add('error');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
