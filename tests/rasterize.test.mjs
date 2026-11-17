import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {chromium} from 'playwright';
import psd from '../rasterize-psd.js';
import rasterize from '../rasterize.js';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const ascii = value => Buffer.from(value, 'ascii');
const key = value => Buffer.concat([u32(value.length), ascii(value)]);
const unicode = value => Buffer.concat([u32(value.length), Buffer.from(value, 'utf16le').swap16()]);
const descriptor = fields => Buffer.concat([unicode(''), key('null'), u32(fields.length), ...fields]);
const item = (name, type, value) => Buffer.concat([key(name), ascii(type), value]);
function placed(id, fields = []) {
  return Buffer.concat([ascii('soLD'), u32(4), u32(16), descriptor([
    item('Idnt', 'TEXT', unicode('source-' + id)), item('placed', 'TEXT', unicode('placed-' + id)),
    item('Type', 'long', u32(2)), item('Trnf', 'VlLs', u32(0)), ...fields
  ])]);
}
function tag(name, data, alignment = 2) {
  return Buffer.concat([ascii('8BIM' + name), u32(data.length), data, Buffer.alloc((alignment - data.length % alignment) % alignment)]);
}
function fixture(records, global = []) {
  const layers = records.map(({id, mask, style, clipping = 0, opacity = 255, flags = 0, mode = 'norm', tags = []}) => {
    const extra = Buffer.concat([
      u32(mask?.length ?? 0), mask ?? Buffer.alloc(0), u32(0), Buffer.alloc(4),
      tag('lyid', u32(id)), ...(style ? [tag('lfx2', style)] : []),
      ...tags.map(([name, data]) => tag(name, data))
    ]);
    return Buffer.concat([Buffer.alloc(16), u16(0), ascii('8BIM' + mode),
      Buffer.from([opacity, clipping, flags, 0]), u32(extra.length), extra]);
  });
  const info = Buffer.concat([u16(layers.length), ...layers]);
  const layerMask = Buffer.concat([u32(info.length), info, u32(0), ...global]);
  const result = Buffer.concat([ascii('8BPS'), u16(1), Buffer.alloc(20), u32(0), u32(0), u32(layerMask.length), layerMask]);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}
const embedded = id => ({id, tags: [['SoLd', placed(id)]]});
function globalFilter(id) {
  const name = ascii('$placed-' + id);
  const entry = Buffer.concat([Buffer.from([name.length]), name, u32(1)]);
  return tag('FEid', Buffer.concat([u32(3), u32(0), u32(entry.length), entry, Buffer.alloc((4 - entry.length % 4) % 4)]), 4);
}
const smart = (id, extra = {}) => ({
  id, name: 'Render', typename: 'ArtLayer', kind: 1, visible: true, opacity: 70, blendMode: 'over', ...extra
});
const group = (id, layers, extra = {}) => smart(id, {typename: 'LayerSet', kind: 0, layers, ...extra});

function execute(doc, mode = 'scan', data = null, documents = [doc]) {
  const replies = [], actions = [];
  vm.runInNewContext(rasterize.buildScript('TEST|', mode, data), {
    app: {documents, activeDocument: doc, echoToOE: line => replies.push(JSON.parse(line.slice(5)))},
    LayerKind: {NORMAL: 0, SMARTOBJECT: 1}, DialogModes: {NO: 0},
    ActionReference: class { putIdentifier(type, id) { assert.equal(type, 'Lyr '); this.id = id; } },
    ActionDescriptor: class { putReference(key, ref) { assert.equal(key, 'null'); this.id = ref.id; } },
    charIDToTypeID: value => value, stringIDToTypeID: value => value,
    executeAction(name, action) {
      assert.equal(name, 'rasterizeLayer');
      assert.equal(doc.activeLayer.id, action.id);
      actions.push(action.id);
      doc.activeLayer.kind = 0;
    }
  });
  return {...replies.at(-1), actions};
}

function documentFixture(layers) {
  return {layers, activeLayer: layers[0], historyStates: [1], name: 'Test', source: 'local,0,Test.psd', saveToOE() {}};
}

test('qualifies embedded, external linked, hidden and nested Smart Objects; excludes pixel, text, shape, adjustment and groups', () => {
  const doc = documentFixture([
    smart(1), smart(2), smart(3, {visible: false}), group(4, [
      smart(5), group(6, [group(7, [smart(8)])]), smart(9, {kind: 0}), smart(10, {kind: 2}),
      smart(11, {kind: 3}), smart(12, {kind: 5})
    ])
  ]);
  const {meta, actions, exporting} = execute(doc);
  const rows = psd.readLayers(fixture([
    ...[1,3,5,8,9,10,11,12].map(embedded), {id: 2, tags: [['SoLE', placed(2)]]}
  ]));
  assert.deepEqual(actions, []);
  assert.equal(exporting, true);
  assert.deepEqual(rasterize.eligible(meta, rows).map(row => row.id), [1,2,3,5,8]);
});

test('filters, disabled filters and filter masks are skipped; adjacent unfiltered objects remain eligible', () => {
  const filter = item('filterFX', 'Objc', descriptor([item('enab','bool',Buffer.from([0]))]));
  const rows = psd.readLayers(fixture([
    embedded(1), {id: 2, tags: [['SoLd', placed(2, [filter])]]}, embedded(3),
    {id: 4, tags: [['SoLd',placed(4)], ['FMsk',Buffer.alloc(12)]]}, {...embedded(5), flags: 32}
  ],[globalFilter(3)]));
  assert.deepEqual([...rows].map(([id,row])=>[id,row.filterFree]), [[1,true],[2,false],[3,false],[4,false],[5,false]]);
  assert.equal(psd.readLayers(fixture([embedded(1)],[globalFilter(99)])).get(1).filterFree, false);
});

test('absence or ambiguity of Smart Filter metadata never qualifies a layer', () => {
  const valid = fixture([embedded(1)]);
  for (const length of [0, 12, 26, valid.byteLength - 1]) assert.throws(() => psd.readLayers(valid.slice(0,length)));
  assert.throws(() => psd.readLayers(fixture([embedded(1), embedded(1)])));
  const records = psd.readLayers(fixture([
    {id: 1, tags: [['PlLd',placed(1)]]}, {id: 2, tags:[['SoLE',Buffer.alloc(16)]]},
    {id: 3, tags:[['SoLd',placed(3,[item('futureField', 'long', u32(1))])]]},
    {id: 4, tags:[['SoLd',placed(4)], ['SoLE',placed(4)]]}, {id: 5}
  ]));
  assert.ok([...records.values()].every(row => !row.filterFree));
});

test('native script rasterizes only checked IDs and preserves duplicate names, visibility, blend, opacity, stack and group membership', () => {
  const keep = smart(1), selected = smart(2,{visible:false,opacity:43,blendMode:'mul '}), other = smart(3);
  const doc = documentFixture([keep,group(4,[selected,other])]);
  const {meta} = execute(doc);
  const result = execute(doc,'apply',{meta,ids:[2],verified:[1,2,3]});
  assert.equal(result.count,1);
  assert.deepEqual(result.actions,[2]);
  assert.equal(keep.kind,1);
  assert.equal(other.kind,1);
  assert.equal(selected.kind,0);
  assert.deepEqual(execute(doc).meta.layers,meta.layers.map(row =>
    row.id === 2 ? {...row,kind:'0',smart:false} : row));
});

test('native script rejects an empty/duplicate selection, a group, a pixel layer and an unverified ID before changing anything', () => {
  const doc = documentFixture([smart(1),group(2,[smart(3,{kind:0})]),smart(4)]);
  const {meta} = execute(doc);
  for (const ids of [[], [1,1], [1,2], [1,3], [1,4]]) {
    const result=execute(doc,'apply',{meta,ids,verified:[1,2,3]});
    assert.equal(result.error,'INVALID_SELECTION');
    assert.deepEqual(result.actions,[]);
  }
  assert.equal(execute(doc,'scan',null,[doc,doc]).error,'AMBIGUOUS_DOCUMENT');
  assert.equal(execute(doc,'scan',null,[]).error,'NO_DOCUMENT');
});

test('native script rejects stale document, renamed layer, replaced ID and reordering', () => {
  for (const edit of [d=>{d.source='another';}, d=>{d.layers[1].name='Renamed';},
    d=>{d.layers[1]=smart(3);}, d=>{d.layers.reverse();}]) {
    const doc = documentFixture([smart(1),smart(2)]);
    const {meta} = execute(doc);
    edit(doc);
    const result=execute(doc,'apply',{meta,ids:[1,2],verified:[1,2]});
    assert.equal(result.error,'DOCUMENT_CHANGED');
    assert.deepEqual(result.actions,[]);
  }
});

test('PSD readback verifies editable style and mask data, clipping, opacity, blend mode and visibility', () => {
  const initial={id:1,mask:Buffer.from([8,9]),style:Buffer.from([4,5]),clipping:1,opacity:150,mode:'over',flags:2};
  const record = options => psd.readLayers(fixture([{...initial,...options}])).get(1);
  assert.equal(rasterize.attachmentsPreserved(record({tags:embedded(1).tags}),record({})),true);
  for (const change of [{mask:null},{style:null},{style:Buffer.from([4,6])},{clipping:0},{opacity:255},{mode:'norm'},{flags:0}]) {
    assert.equal(rasterize.attachmentsPreserved(record({}),record(change)),false);
  }
});

test('confirmation reads fresh PSD even when layer tree stayed the same; added filter blocks native action', async () => {
  const code = await readFile(new URL('../rasterize.js',import.meta.url),'utf8');
  const listeners = new Set(), sent = [], host = {};
  const doc = documentFixture([smart(1)]);
  const window = {parent:host, ktxRasterizePsd:psd, crypto:webcrypto,
    addEventListener:(_,listener)=>listeners.add(listener), removeEventListener:(_,listener)=>listeners.delete(listener),
    setTimeout, clearTimeout};
  const emit=data=>{for(const listener of [...listeners])listener({data,source:host,origin:'https://www.photopea.com'});};
  let buffer=fixture([embedded(1)]);
  host.postMessage=script=>{
    sent.push(script);
    doc.saveToOE=()=>emit(buffer);
    vm.runInNewContext(script,{app:{documents:[doc],activeDocument:doc,echoToOE:emit},LayerKind:{NORMAL:0,SMARTOBJECT:1}});
    emit('done');
  };
  vm.runInNewContext(code,{window,document:{getElementById:()=>null,querySelectorAll:()=>[]},ArrayBuffer});
  const snapshot=await window.ktxRasterize.scan();
  assert.equal(snapshot.candidates.length,1);
  buffer=fixture([embedded(1)],[globalFilter(1)]);
  await assert.rejects(window.ktxRasterize.rasterize(snapshot,[1]),{code:'DOCUMENT_CHANGED'});
  assert.equal(sent.length,2);
  assert.equal(doc.layers[0].kind,1);
});

test('panel defaults to checked, counts selected IDs, disables zero, cancels safely and scrolls long names', async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.KTX_TEST_BROWSER || undefined});
  try {
    const page = await browser.newPage({viewport: {width: 360, height: 720}});
    const html = await readFile(new URL('../plugin.html', import.meta.url), 'utf8');
    const section = html.slice(html.indexOf('<div id="rasterize">'), html.indexOf('<details class="watermark-section"'));
    await page.setContent(section);
    for (const name of ['plugin-v35.css', 'layer-cleaner.css']) {
      await page.addStyleTag({content: await readFile(new URL('../' + name, import.meta.url), 'utf8')});
    }
    await page.evaluate(() => {
      window.actions = [];
      const candidates = Array.from({length: 18}, (_, i) => ({id:i+1,name:i < 2 ? 'Render' : 'Długa nazwa '.repeat(35)}));
      window.ktxRasterize = {
        async scan() { return {candidates}; },
        async rasterize(_,ids) { window.actions.push(ids); return ids.length; }
      };
    });
    await page.addScriptTag({content: await readFile(new URL('../rasterize-ui.js', import.meta.url), 'utf8')});
    const start = page.locator('#rasterizeScan'), apply = page.locator('#rasterizeApply');
    const list = page.locator('#rasterizeList'), inputs = list.locator('input');
    await start.click();
    assert.equal(await list.locator('input:checked').count(),18);
    assert.equal(await apply.textContent(),'RASTERYZUJ 18 WARSTW');
    assert.equal(await list.evaluate(e=>e.scrollHeight>e.clientHeight),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#rasterizeCancel').click();
    assert.equal(await list.isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>window.actions),[]);
    await start.click();
    for (const input of await inputs.all()) await input.uncheck();
    assert.equal(await apply.isEnabled(),false);
    await inputs.nth(1).check();
    assert.equal(await apply.textContent(),'RASTERYZUJ 1 WARSTWĘ');
    await apply.click();
    assert.deepEqual(await page.evaluate(()=>window.actions),[[2]]);
  } finally { await browser.close(); }
});
