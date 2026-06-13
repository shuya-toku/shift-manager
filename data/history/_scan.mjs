// 文字化け修復(latin1→utf8) + 整合性スキャン。
// 使い方: node data/history/_scan.mjs <csvファイル...>
// - mojibake(UTF-8をLatin-1誤読)を検出したらバイト復元してファイルを上書き
// - SQA Working Shift 形式として軽くパースし、社員数/シフトセル数/異常を報告
import fs from 'fs';

const MONTHS = { January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12 };

// --- 簡易CSVパーサ(引用フィールド内の改行・カンマ対応) ---
function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// mojibake 判定: Latin-1 補助域(À-ÿ)が多数あれば誤読とみなす
function looksMojibaked(s) {
  const m = s.match(/[À-ÿ]/g);
  return m && m.length > 50;
}
function repairMojibake(s) {
  // 各コードポイントを1バイト(latin1)として並べ直し、UTF-8として再デコード
  const bytes = Buffer.from(s, 'latin1');
  return bytes.toString('utf8');
}

for (const path of process.argv.slice(2)) {
  let raw = fs.readFileSync(path, 'utf8').replace(/^﻿/, '');
  let repaired = false;
  if (looksMojibaked(raw)) { raw = repairMojibake(raw); fs.writeFileSync(path, raw, 'utf8'); repaired = true; }

  const rows = parseCSV(raw);
  const flat = rows.slice(0, 3).flat().join('|');
  const mm = flat.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s*\/\s*(\d{4})/);
  const month = mm ? `${mm[2]}-${String(MONTHS[mm[1]]).padStart(2,'0')}` : '(不明)';
  const dim = mm ? new Date(+mm[2], MONTHS[mm[1]], 0).getDate() : 31;

  // dayColStart 検出 (先頭5行の col3-6 に "1")
  let dayColStart = 4;
  outer: for (let r = 0; r < Math.min(5, rows.length); r++)
    for (let c = 3; c <= 6; c++) if ((rows[r][c]||'').trim() === '1') { dayColStart = c; break outer; }

  // ID ブロック走査
  let emp = 0, cells = 0;
  const dollar = [], fullwidth = [], unknown = new Set(), shortRows = [], negCounts = [];
  const expectCols = dayColStart + 3 * dim; // 期待される最小列数
  for (let i = 0; i < rows.length; i++) {
    const id = (rows[i][0]||'').trim();
    if (!/^\d{2,4}$/.test(id)) continue;
    emp++;
    const header = rows[i]||[], inRow = rows[i+1]||[], outRow = rows[i+2]||[], brkRow = rows[i+3]||[];
    // 行の列数チェック(著しく短い=列ズレ/欠落の疑い)
    for (const [lbl, rr] of [['hdr',header],['in',inRow],['out',outRow],['brk',brkRow]])
      if (rr.length < expectCols - 3) shortRows.push(`${id}:${lbl}(${rr.length}列)`);
    for (let d = 1; d <= dim; d++) {
      const col = dayColStart + 3 * (d - 1);
      const cnt = (header[col]||'').trim();
      if (/\$/.test(cnt)) dollar.push(`${id} d${d}="${cnt}"`);
      else if (cnt && /[^\d.\s]/.test(cnt)) fullwidth.push(`${id} d${d}="${cnt}"`);
      const inT = (inRow[col]||'').trim(), outT = (outRow[col]||'').trim(), bv = (brkRow[col]||'').trim();
      if (/^\d+:\d+$/.test(inT) || /^\d+:\d+$/.test(outT)) cells++;
      const U = bv.toUpperCase();
      if (bv && !/^\d+:\d+$/.test(bv) && !['','OFF','NG','AL','AL0.5','P'].includes(U)) unknown.add(bv.replace(/\s+/g,'¬'));
    }
    // 右端サマリの負値検出(ざっくり: ID行の末尾付近に負数)
    for (const v of header.slice(expectCols)) if (/^-\d+/.test((v||'').trim())) negCounts.push(`${id}=${v.trim()}`);
    i += 3;
  }

  console.log(`\n=== ${path} ===`);
  console.log(`修復: ${repaired ? 'mojibake復元済み✅' : '不要'} / 月=${month} / 日数=${dim} / dayColStart=${dayColStart}`);
  console.log(`社員ブロック: ${emp} / 取込見込みシフトセル(IN/OUT有): ${cells}`);
  console.log(`$表記カウント: ${dollar.length}件 ${dollar.slice(0,8).join(', ')}${dollar.length>8?' …':''}`);
  console.log(`非数値カウント(全角/化け): ${fullwidth.length}件 ${fullwidth.slice(0,8).join(', ')}${fullwidth.length>8?' …':''}`);
  console.log(`負のサマリ値: ${negCounts.length}件 ${[...new Set(negCounts)].slice(0,10).join(', ')}`);
  console.log(`未知ステータス: ${unknown.size}種 ${[...unknown].slice(0,10).join(', ')}`);
  console.log(`短い行(列ズレ疑い): ${shortRows.length}件 ${shortRows.slice(0,10).join(', ')}${shortRows.length>10?' …':''}`);
}
