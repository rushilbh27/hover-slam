// Bundles the game into dist/hoverslam.html, a single file you can open from disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const strip = (js) => js.replace(/import \{[\s\S]*?\} from '\.\/[^']+';\n?/g, '').replace(/^export (const|function|let|class) /gm, '$1 ');
const script = ['physics.js', 'explain.js', 'controls.js', 'app.js'].map((f) => strip(read(f))).join('\n');
const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('style.css')}\n</style>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script type="module">\n${script}\n</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'hoverslam.html'), html);
console.log(`wrote dist/hoverslam.html (${Math.round(html.length / 1024)} KB)`);
