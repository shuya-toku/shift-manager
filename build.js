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

// 自動取込データ（data/<sub> → public/data/<sub>）。manifest.json と列挙CSVのみコピー。
function copyDataDir(sub) {
  const SRC = path.join('data', sub);
  if (!fs.existsSync(SRC)) return;
  const DST = path.join(OUT, 'data', sub);
  fs.mkdirSync(DST, { recursive: true });
  let manifestFiles = [];
  const manifestPath = path.join(SRC, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.copyFileSync(manifestPath, path.join(DST, 'manifest.json'));
    console.log(`copied data/${sub}/manifest.json`);
    try { manifestFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || []; } catch (e) {}
  }
  for (const f of manifestFiles) {
    const src = path.join(SRC, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DST, f));
      console.log(`copied data/${sub}/` + f);
    } else {
      console.warn(`skip (missing) data/${sub}/` + f);
    }
  }
}
copyDataDir('history');   // 過去シフト
copyDataDir('bookings');  // 予約(onhand)

console.log('build done → public/');
