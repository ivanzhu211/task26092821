import fs from 'node:fs';
import path from 'node:path';

const STORE = '/Users/ivan/Library/pnpm/store/v10';
const [indexFile, dest] = process.argv.slice(2);
const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
let count = 0;
for (const [rel, meta] of Object.entries(idx.files)) {
  const hex = Buffer.from(meta.integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
  let src = path.join(STORE, 'files', hex.slice(0, 2), hex.slice(2));
  if (!fs.existsSync(src) && fs.existsSync(src + '-exec')) src += '-exec';
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(src, out);
  fs.chmodSync(out, meta.mode);
  count++;
}
console.log(`${idx.name}@${idx.version}: ${count} files -> ${dest}`);
