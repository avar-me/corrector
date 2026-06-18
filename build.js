/**
 * Build script for corrector.avar.me
 * Fetches lemma_frequencies.csv and produces dist/ for GitHub Pages.
 */

import { writeFileSync, mkdirSync, copyFileSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');
const SRC  = join(__dirname, 'src');

const CSV_URL = 'https://forms.avar.me/data/lemma_frequencies.csv';

// ---------------------------------------------------------------------------

async function fetchCSV(url) {
  console.log(`Fetching ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function parseCSV(text) {
  const dict = Object.create(null);
  const lines = text.trim().split('\n');

  for (const line of lines) {
    const sep = line.includes('\t') ? '\t' : ',';
    const parts = line.split(sep);
    if (parts.length < 2) continue;

    const word = parts[0].trim();
    const freq = parseInt(parts[1].trim(), 10);

    if (!word || isNaN(freq) || word === 'lemma') continue;
    dict[word.toLowerCase()] = (dict[word.toLowerCase()] || 0) + freq;
  }

  return dict;
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(DIST, { recursive: true });

  const csv  = await fetchCSV(CSV_URL);
  const dict = parseCSV(csv);
  const count = Object.keys(dict).length;
  console.log(`Parsed ${count} lemmas.`);

  // Read src files up front so the cache-busting hash can cover both the
  // dictionary and the code/assets — иначе правки в app.js/style.css не
  // меняют ?v= и браузер отдаёт старую версию из кэша.
  const srcFiles = readdirSync(SRC).map(file => ({
    file,
    content: readFileSync(join(SRC, file), 'utf8'),
  }));

  const hash = createHash('md5')
    .update(JSON.stringify(dict))
    .update(srcFiles.map(f => f.file + '\0' + f.content).join('\0'))
    .digest('hex')
    .slice(0, 8);

  writeFileSync(join(DIST, 'dictionary.json'), JSON.stringify(dict));
  console.log('Wrote dictionary.json');

  // Copy all src files, injecting asset version into HTML
  for (const { file, content } of srcFiles) {
    const out = file.endsWith('.html')
      ? content.replace(/__ASSET_VERSION__/g, hash)
      : content;
    writeFileSync(join(DIST, file), out);
  }

  // Copy corrections.json
  copyFileSync(join(__dirname, 'corrections.json'), join(DIST, 'corrections.json'));

  // CNAME for GitHub Pages
  writeFileSync(join(DIST, 'CNAME'), 'corrector.avar.me');

  console.log(`Build done (v=${hash}, ${count} lemmas) → dist/`);
}

main().catch(err => { console.error(err); process.exit(1); });
