// Vercel build script: copy static files into public/ for serving.
const fs = require('fs');
const path = require('path');

const OUT = 'public';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const files = [
  'index.html', 'sqa-data.js', 'sqa-glossary.js', 'app.js', 'cloud.js', 'history.js',
  'volume.js', 'inquiry.js', 'nav.js', 'context-bar.js',
  'styles.css', 'firebase-config.js', 'supabase-config.js',
];

for (const f of files) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, path.join(OUT, f));
    console.log('copied', f);
  }
}

// 過去シフトの自動取込データ（data/history → public/data/history）。
// manifest.json と列挙されたCSVのみコピー（README/_scan.mjs は配信不要）。
const HISTORY_SRC = path.join('data', 'history');
if (fs.existsSync(HISTORY_SRC)) {
  const HISTORY_OUT = path.join(OUT, 'data', 'history');
  fs.mkdirSync(HISTORY_OUT, { recursive: true });
  let manifestFiles = [];
  const manifestPath = path.join(HISTORY_SRC, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, path.join(HISTORY_OUT, 'manifest.json'));
    console.log('copied data/history/manifest.json');
    try { manifestFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || []; } catch (e) {}
  }
  for (const f of manifestFiles) {
    const src = path.join(HISTORY_SRC, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(HISTORY_OUT, f));
      console.log('copied data/history/' + f);
    } else {
      console.warn('skip (missing) data/history/' + f);
    }
  }
}

console.log('build done → public/');
