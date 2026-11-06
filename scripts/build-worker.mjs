import {readFile, writeFile, mkdir} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const worker = await readFile(new URL('worker/ai-review-worker.mjs', root), 'utf8');
let bundled = worker;
for (const [name, file] of [['contract', 'ai-review-contract.js'], ['layerMetadata', 'photopea-layer-tree.js'],
  ['instructionRules', 'photopea-instruction-rules.js']]) {
  const source = await readFile(new URL(file, root), 'utf8');
  bundled = bundled.replace("import " + name + " from '../" + file + "';",
    () => 'const ' + name + ' = (() => { const module = {exports: {}};\n' + source + '\nreturn module.exports; })();');
}
await mkdir(new URL('build/', root), {recursive: true});
await writeFile(new URL('build/worker.mjs', root), bundled);
console.log('Built build/worker.mjs for the existing Worker.');
