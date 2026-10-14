import {readFile, writeFile, mkdir} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const contract = await readFile(new URL('ai-review-contract.js', root), 'utf8');
const worker = await readFile(new URL('worker/ai-review-worker.mjs', root), 'utf8');
const bundled = worker.replace("import contract from '../ai-review-contract.js';",
  'const contract = (() => { const module = {exports: {}};\n' + contract + '\nreturn module.exports; })();');
await mkdir(new URL('build/', root), {recursive: true});
await writeFile(new URL('build/worker.mjs', root), bundled);
console.log('Built build/worker.mjs for the existing Worker.');
