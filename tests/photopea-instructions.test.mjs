import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import tree from '../photopea-layer-tree.js';
import rules from '../photopea-instruction-rules.js';

const source = await readFile(new URL('../photopea-layer-tree.js', import.meta.url), 'utf8');
function echo(app, LayerKind = {}, expectedSource) {
  const replies = [];
  vm.runInNewContext(tree.buildScript('test', expectedSource), {app: {...app, echoToOE: message => replies.push(message)}, LayerKind});
  assert.equal(replies.length, 1);
  assert.ok(replies[0].startsWith('KTX_LAYER_TREE|test|'));
  return JSON.parse(replies[0].slice('KTX_LAYER_TREE|test|'.length));
}
const pixel = (name, properties = {}) => ({name, kind: 'LayerKind.NORMAL', visible: true, ...properties});
const group = (name, layers, visible = true) => ({name, typename: 'LayerSet', layers, visible});
const documentWith = layers => ({documents: [1], activeDocument: {layers}});

test('reads PSD layer order, nested groups, visibility, text, pixels, Smart Objects and adjustments', () => {
  const smartKind = Object.freeze({value: 7});
  const raw = echo(documentWith([
    group('Okładka', [group('Napisy', [{name: 'Nagłówek', kind: 'LayerKind.TEXT', visible: true}], false),
      {name: 'Grafika', kind: smartKind, visible: true, bounds: [{as: unit => unit === 'px' ? -3.25 : NaN}, 2, 80, 50]},
      {name: 'Kolor', kind: 'LayerKind.HUESATURATION', visible: true}]),
    pixel('Tło')
  ]), {SMARTOBJECT: smartKind});
  const {layers, truncated} = tree.normalize(raw);
  assert.equal(truncated, false);
  assert.deepEqual(layers.map(l => [l.path, l.type, l.visible, l.effectiveVisible, l.indexPath]), [
    ['Okładka', 'group', true, true, [0]],
    ['Okładka/Napisy', 'group', false, false, [0, 0]],
    ['Okładka/Napisy/Nagłówek', 'text', true, false, [0, 0, 0]],
    ['Okładka/Grafika', 'smart-object', true, true, [0, 1]],
    ['Okładka/Kolor', 'adjustment', true, true, [0, 2]],
    ['Tło', 'pixel', true, true, [1]]
  ]);
  assert.deepEqual(layers[3].bounds, [-3.25, 2, 80, 50]);
  assert.equal(layers[4].bounds, undefined);
});

test('reads a single flattened pixel layer without exporting an image or guessing elements', () => {
  const doc = {layers: [pixel('Scalony obraz', {bounds: [0, 0, 1280, 720]})],
    saveToOE() { assert.fail('Metadata must not export pixels'); }};
  const result = tree.normalize(echo({activeDocument: doc}));
  assert.deepEqual(result, {layers: [{name: 'Scalony obraz', type: 'pixel', visible: true,
    effectiveVisible: true, path: 'Scalony obraz', indexPath: [0], bounds: [0, 0, 1280, 720]}], truncated: false});
});

test('reports no document and unavailable layer lists separately', () => {
  assert.deepEqual(echo({documents: []}), {error: 'NO_DOCUMENT'});
  assert.deepEqual(echo({activeDocument: null}), {error: 'NO_DOCUMENT'});
  assert.deepEqual(echo({activeDocument: {}}), {error: 'LAYERS_UNAVAILABLE'});
});

test('layer read is bound to the document that supplied the PNG', async () => {
  const doc = {source: 'local,thumbnail', layers: [pixel('Tło')]};
  assert.equal(echo({activeDocument: doc}, {}, doc.source).layers.length, 1);
  assert.deepEqual(echo({activeDocument: doc}, {}, 'local,other'), {error: 'DOCUMENT_CHANGED'});
  const h = browserHarness(), job = h.read();
  h.emit(h.payload({error: 'DOCUMENT_CHANGED'}));
  await assert.rejects(job, {code: 'DOCUMENT_CHANGED'});
});

test('wire metadata normalization strips extra contents, rebuilds paths and rejects unsafe context', () => {
  const safe = tree.normalize(echo(documentWith([group('Grupa', [pixel('Tło')])])));
  const extra = structuredClone(safe);
  extra.pixels = 'never forward'; extra.layers[1].smartObjectContents = 'never forward';
  extra.layers[1].path = 'untrusted path'; extra.layers[1].effectiveVisible = false;
  assert.deepEqual(tree.normalizeContext(extra), safe);
  for (const value of [null, undefined, {}, {layers: [], truncated: true, extra: 'a'.repeat(tree.limits.bytes)},
    {...safe, layers: [{...safe.layers[1], indexPath: [9,0]}]},
    {...safe, layers: [safe.layers[0], safe.layers[0]]},
    {...safe, layers: [{...safe.layers[0], type: 'invented'}]}]) assert.equal(tree.normalizeContext(value), null);
  assert.deepEqual(tree.normalizeContext({...safe, truncated: true}), {...safe, truncated: true});
});

test('normalization keeps unknown values unknown and rejects broken hierarchy', () => {
  const raw = echo(documentWith([group('A/B', [
    {name: '  napis\u0000 ', kind: 'LayerKind.FUTURE', bounds: [9, 0, 1, 10], extra: 'private'},
    {name: 'napis', kind: 'LayerKind.TEXT', visible: false}
  ])]));
  assert.deepEqual(tree.normalize(raw).layers.slice(1), [
    {name: 'napis', type: 'unknown', visible: null, effectiveVisible: null, path: 'A%2FB/napis', indexPath: [0, 0]},
    {name: 'napis', type: 'text', visible: false, effectiveVisible: false, path: 'A%2FB/napis', indexPath: [0, 1]}
  ]);
  assert.throws(() => tree.normalize({layers: [{name: 'x', parent: 3, position: 0}]}), {code: 'INVALID_DATA'});
});

test('bounds metadata work by layer count, depth, name length and UTF-8 payload size', () => {
  const tooMany = tree.normalize(echo(documentWith(Array.from({length: 300}, (_, i) => pixel('L' + i)))));
  assert.equal(tooMany.layers.length, tree.limits.layers);
  assert.equal(tooMany.truncated, true);
  let deep = pixel('Niewidoczna w wyniku');
  for (let i = 0; i < 20; i++) deep = group('Grupa ' + i, [deep]);
  assert.equal(tree.normalize(echo(documentWith([deep]))).layers.length, tree.limits.depth);
  const large = echo(documentWith(Array.from({length: 120}, () => pixel('\u0000'.repeat(110)))));
  assert.equal(large.truncated, true);
  assert.ok(large.layers.length < 120);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= tree.limits.bytes);
});

function browserHarness() {
  let receive, sent, timeout;
  const origin = 'https://www.photopea.com';
  const parent = {postMessage(script, target) { sent = {script, target}; }};
  const window = {
    parent, crypto: {randomUUID: () => 'request-id'}, ktxSaveToOEGate: {owner: null},
    addEventListener(_type, listener) { receive = listener; },
    removeEventListener(_type, listener) { if (receive === listener) receive = null; },
    setTimeout(listener) { timeout = listener; return 1; }, clearTimeout() { timeout = null; }
  };
  vm.runInNewContext(source, {window, TextEncoder});
  return {
    window, read: () => window.ktxPhotopeaLayerTree.readActiveDocument(), sent: () => sent,
    hasListener: () => Boolean(receive), expire: () => timeout(),
    emit: (data, overrides) => receive?.({source: parent, origin, data, ...overrides}),
    payload: raw => 'KTX_LAYER_TREE|request-id|' + JSON.stringify(raw)
  };
}

test('bridge uses Photopea origin and request tag and ignores other windows, origins and binary exports', async () => {
  const h = browserHarness();
  const job = h.read();
  assert.equal(h.sent().target, 'https://www.photopea.com');
  assert.doesNotMatch(h.sent().script, /saveToOE|textItem|fetch\(/);
  const reply = h.payload(echo(documentWith([pixel('Tło')])));
  h.emit(reply, {source: {}});
  h.emit(reply, {origin: 'https://example.com'});
  h.emit(reply.replace('request-id', 'older-id'));
  h.emit(new ArrayBuffer(12));
  assert.equal(h.hasListener(), true);
  await assert.rejects(h.read(), {code: 'BUSY'});
  h.emit(reply);
  assert.equal((await job).layers[0].name, 'Tło');
  assert.equal(h.hasListener(), false);
});

test('bridge fails closed for active exports, missing documents, excess data and timeout', async () => {
  const h = browserHarness();
  h.window.ktxSaveToOEGate.owner = 'external';
  await assert.rejects(h.read(), {code: 'BUSY'});
  assert.equal(h.sent(), undefined);
  h.window.ktxSaveToOEGate.owner = null;
  const noDocument = h.read();
  h.emit(h.payload({error: 'NO_DOCUMENT'}));
  await assert.rejects(noDocument, {code: 'NO_DOCUMENT'});
  const oversized = h.read();
  h.emit(h.payload({layers: [], ignored: 'ż'.repeat(tree.limits.bytes)}));
  await assert.rejects(oversized, {code: 'TOO_LARGE'});
  const timedOut = h.read();
  h.expire();
  await assert.rejects(timedOut, {code: 'TIMEOUT'});
  assert.equal(h.hasListener(), false);
});

test('color rules separate saturation from brightness and contrast', () => {
  assert.deepEqual(rules.evaluate('saturation').tools, ['Hue/Saturation', 'Vibrance']);
  assert.equal(rules.evaluate('saturation', {tool: 'Brightness/Contrast'}).reason, 'UNSUITABLE_TOOL');
  assert.deepEqual(rules.evaluate('brightnessContrast').tools, ['Curves', 'Levels', 'Brightness/Contrast']);
});

test('transform and opacity rules require verified editing facts', () => {
  for (const operation of ['move', 'scale', 'rotate']) {
    assert.equal(rules.evaluate(operation).allowed, false);
    assert.equal(rules.evaluate(operation, {target: 'separate-layer'}).allowed, true);
    assert.equal(rules.evaluate(operation, {target: 'flattened', original: 'masked'}).allowed, false);
    assert.equal(rules.evaluate(operation, {target: 'flattened', original: 'removed', areaRestored: true, retouchSafe: true}).allowed, true);
  }
  assert.equal(rules.evaluate('opacity', {target: 'separate-layer', identicalOriginalBelow: true}).reason, 'IDENTICAL_ORIGINAL_BELOW');
  assert.equal(rules.evaluate('opacity', {target: 'separate-layer'}).allowed, false);
  assert.equal(rules.evaluate('opacity', {target: 'separate-layer', identicalOriginalBelow: false}).allowed, true);
});
