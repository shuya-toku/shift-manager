// Vercel build script: copy static files into public/ for serving.
const fs = require('fs');
const path = require('path');

const OUT = 'public';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const files = [
  'index.html', 'app.js', 'cloud.js', 'history.js', 'volume.js',
  'styles.css', 'firebase-config.js', 'supabase-config.js',
];

for (const f of files) {
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, path.join(OUT, f));
    console.log('copied', f);
  }
}
console.log('build done → public/');
