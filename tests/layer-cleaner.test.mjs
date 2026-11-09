import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import http from 'node:http';
import cleaner from '../layer-cleaner.js';
const require = createRequire(import.meta.url);
const {psdFixture,neutralMetadata} = require('./helpers/layer-cleaner-fixture.cjs');
const {chromium} = require('playwright');
const root = new URL('../',import.meta.url);
const LayerKind = {NORMAL:0,TEXT:2,SMARTOBJECT:17,CURVES:5,SOLIDFILL:11};
const pixel = (id, props = {}) => ({id,name:'Warstwa '+id,typename:'ArtLayer',kind:0,visible:true,opacity:100,
  bounds:[0,0,8,8],allLocked:false,isBackgroundLayer:false,...props});
const group = (id, layers = [], props = {}) => ({...pixel(id,props),typename:'LayerSet',layers});
function fixture(layers) {
  const doc = {source:'local,0,Test',name:'Test',width:32,height:32,layers,saveToOE() {}};
  function attach(items) { for (const row of items) { row.remove=()=>items.splice(items.findIndex(item=>item.id===row.id),1); if (row.layers) attach(row.layers); } }
  attach(layers); return doc;
}
function execute(doc, mode = 'scan', payload = null, documents = [doc]) {
  const messages = [];
  vm.runInNewContext(cleaner.buildScript('offline',mode,payload),{app:{activeDocument:doc,documents,echoToOE:m=>messages.push(m)},LayerKind});
  assert.equal(messages.length,1);
  return JSON.parse(messages[0].slice('KTX_CLEANER|offline|'.length));
}
function scan(layers, records = []) {
  const doc = fixture(layers), result = execute(doc);
  return {doc,meta:result.meta,candidates:cleaner.candidates(result.meta,cleaner.emptyPixelIds(psdFixture(records)))};
}
for (const [kind,label] of [[0,'pixel'],[17,'Smart Object'],[2,'text'],[5,'adjustment'],[11,'shape']]) {
  test(`own-hidden ${label} is detected regardless of layer type`,()=>{
    const result=scan([pixel(1,{kind,visible:false})]);
    assert.deepEqual(result.candidates.map(r=>[r.id,r.reasons]),[[1,['hidden']]]);
  });
}
test('visible opacity 0 is detected for any individual layer, not fill or inherited opacity',()=>{
  const result=scan([pixel(1,{kind:17,opacity:0}),pixel(2,{opacity:0.01}),pixel(3,{fillOpacity:0}),pixel(4,{opacity:null})]);
  assert.deepEqual(result.candidates.map(r=>[r.id,r.reasons]),[[1,['zero']]]);
});
test('a genuinely empty visible pixel needs independent PSD evidence',()=>{
  const result=scan([pixel(1,{bounds:[0,0,0,0]})],[{id:1}]);
  assert.deepEqual(result.candidates.map(r=>r.reasons),[['empty']]);
  assert.equal(cleaner.candidates(result.meta).length,0,'Zero bounds alone are insufficient');
});
test('a pixel layer with pixels, including pixels masked out of view, is preserved',()=>{
  const result=scan([pixel(1),pixel(2,{bounds:[0,0,0,0]})],[{id:1,rect:[0,0,8,8]},{id:2,rect:[0,0,8,8],mask:true}]);
  assert.equal(result.candidates.length,0);
});
test('empty clipping bases are preserved so removal cannot reveal their clipped layers',()=>{
  const records=[{id:1},{id:2,rect:[0,0,8,8],clipping:1},{id:3,rect:[0,0,8,8],clipping:1},{id:4}];
  assert.deepEqual([...cleaner.emptyPixelIds(psdFixture(records))],[4]);
});
for (const [label,record] of [
  ['style',{tags:[['lfx2',Buffer.alloc(16)]]}],
  ['legacy effects',{tags:[['lrFX',Buffer.alloc(16)]]}],
  ['raster mask',{mask:true}],
  ['vector mask',{tags:[['vmsk',Buffer.alloc(16)]]}],
  ['unknown significant metadata',{tags:[['????',Buffer.alloc(2)]]}],
  ['custom layer comps',{tags:[['shmd',Buffer.alloc(8)]]}],
  ['extra channel',{channels:[{id:0,length:2},{id:3,length:2}]}],
  ['unexpected pixel payload',{channels:[{id:0,length:3}]}]
]) test(`pixel with zero bounds but ${label} is not called empty`,()=>{
  assert.equal(scan([pixel(1,{bounds:[0,0,0,0]})],[{id:1,...record}]).candidates.length,0);
});
for (const [kind,label] of [[17,'Smart Object'],[2,'text'],[5,'adjustment'],[11,'shape']]) {
  test(`${label} without classic pixel bounds is never classified empty`,()=>{
    assert.equal(scan([pixel(1,{kind,bounds:[0,0,0,0]})],[{id:1}]).candidates.length,0);
  });
}
test('hidden, opacity-zero and empty groups are excluded; children are recursively scanned',()=>{
  const result=scan([group(1,[group(2,[pixel(3,{visible:false})],{opacity:0})],{visible:false}),group(4)]);
  assert.deepEqual(result.candidates.map(r=>r.id),[3]);
  assert.equal(result.meta.layers.filter(r=>r.group).length,3);
});
test('own visibility is independent of a hidden parent; only the own-OFF child is hidden',()=>{
  const result=scan([group(1,[pixel(2),pixel(3,{visible:false})],{visible:false,opacity:0})]);
  assert.deepEqual(result.candidates.map(r=>r.id),[3]);
  assert.equal(result.meta.layers.find(r=>r.id===2).visible,true);
});
test('several reasons produce exactly one candidate',()=>{
  const result=scan([pixel(1,{visible:false,opacity:0,bounds:[0,0,0,0]})],[{id:1}]);
  assert.deepEqual(result.candidates,[{id:1,name:'Warstwa 1',parent:null,reasons:['hidden','empty','zero']}]);
});
test('empty document, duplicate IDs, excessive nesting and ambiguous document sources fail closed',()=>{
  assert.equal(execute(null,'scan',null,[]).error,'NO_DOCUMENT');
  assert.equal(execute(fixture([pixel(1),pixel(1)])).error,'UNSAFE_TREE');
  assert.equal(execute(fixture([pixel(1,{typename:undefined,visible:false})])).error,'UNSAFE_TREE');
  const doc=fixture([pixel(1)]); assert.equal(execute(doc,'scan',null,[doc,{source:doc.source}]).error,'AMBIGUOUS_DOCUMENT');
  let deep=pixel(1000); for(let i=0;i<70;i++)deep=group(i,[deep]);
  assert.equal(execute(fixture([deep])).error,'UNSAFE_TREE');
});
test('selected stable ID is removed; same-named unchecked layer and all groups survive',()=>{
  const snapshot=scan([group(1,[pixel(2,{name:'Render',visible:false}),pixel(3,{name:'Render',visible:false})]),group(4,[],{visible:false})]);
  assert.equal(snapshot.doc.layers[0].layers.length,2,'Scan never deletes');
  const result=execute(snapshot.doc,'delete',{...snapshot,ids:[3]});
  assert.equal(result.error,null);
  assert.deepEqual(result.deleted,[3]);
  assert.deepEqual(snapshot.doc.layers.map(r=>r.id),[1,4]);
  assert.deepEqual(snapshot.doc.layers[0].layers.map(r=>r.id),[2]);
});
test('changed, missing or retyped layers abort the complete batch before any deletion',()=>{
  for (const change of [doc=>{doc.layers.pop();},doc=>{doc.layers[1].name='Changed';},
    doc=>{doc.layers[1].visible=true;},doc=>{doc.layers[1].typename='LayerSet';doc.layers[1].layers=[];},
    doc=>{doc.source='local,1,Other';}]) {
    const snapshot=scan([pixel(1,{visible:false}),pixel(2,{visible:false})]);
    change(snapshot.doc);
    const result=execute(snapshot.doc,'delete',{...snapshot,ids:[1,2]});
    assert.equal(result.error,'DOCUMENT_CHANGED');
    assert.ok(snapshot.doc.layers.some(r=>r.id===1));
  }
});
test('groups, unscanned IDs, duplicate selections and an empty delete are rejected',()=>{
  const snapshot=scan([group(1,[pixel(2,{visible:false})])]);
  for (const ids of [[],[1],[99],[2,2]]) {
    assert.equal(execute(snapshot.doc,'delete',{...snapshot,ids}).error,'INVALID_SELECTION');
    assert.equal(snapshot.doc.layers[0].layers.length,1);
  }
});
test('locked selections and native delete failures are reported without false success',()=>{
  const snapshot=scan([pixel(1,{visible:false}),pixel(2,{visible:false,allLocked:true})]);
  assert.equal(execute(snapshot.doc,'delete',{...snapshot,ids:[1,2]}).error,'LOCKED_LAYER');
  assert.equal(snapshot.doc.layers.length,2);
  const second=scan([pixel(1,{visible:false}),pixel(2)]);
  second.doc.layers[0].remove=()=>{};
  assert.equal(execute(second.doc,'delete',{...second,ids:[1]}).error,'DELETE_FAILED');
});
test('truncated, unsupported or duplicate-ID PSD metadata cannot prove emptiness',()=>{
  const valid=psdFixture([{id:1}]);
  for(const cut of [0,4,18,30,valid.byteLength-4])assert.throws(()=>cleaner.emptyPixelIds(valid.slice(0,cut)));
  const psb=valid.slice(0);new DataView(psb).setUint16(4,2);assert.throws(()=>cleaner.emptyPixelIds(psb));
  assert.throws(()=>cleaner.emptyPixelIds(psdFixture([{id:1},{id:1}])));
});

test('Photopea base-comp metadata is accepted only when it contains precisely neutral settings',()=>{
  const plain={id:1,tags:[['shmd',neutralMetadata(1)]]};
  assert.deepEqual([...cleaner.emptyPixelIds(psdFixture([plain]))],[1]);
  const hidden={id:1,flags:2,opacity:0,tags:[['shmd',neutralMetadata(1,d=>{d.layerSettings[0].enab=false;d.layerSettings[0].blendOptions.Opct.value=0;})]]};
  assert.deepEqual([...cleaner.emptyPixelIds(psdFixture([hidden]))],[1]);
  for(const change of [d=>{d.LyrI=99;},d=>{d.layerSettings[0].compList=[7];},
    d=>{d.layerSettings[0].FXRefPoint.Hrzn=15;},d=>{d.layerSettings[0].unknown=1;},
    d=>{d.layerSettings[0].blendOptions.fillOpacity.value=50;},d=>{d.layerSettings.push(d.layerSettings[0]);}]) {
    assert.equal(cleaner.emptyPixelIds(psdFixture([{id:1,tags:[['shmd',neutralMetadata(1,change)]]}])).size,0);
  }
});
test('Photopea UnitValue bounds are unwrapped before checking pixel emptiness',()=>{
  const units=[0,0,0,0].map(n=>({as:unit=>{assert.equal(unit,'px');return n;}}));
  assert.deepEqual(scan([pixel(1,{bounds:units})],[{id:1}]).candidates.map(r=>r.reasons),[['empty']]);
});

const bridgeSource = await readFile(new URL('layer-cleaner.js',root),'utf8');
function bridge(doc, records = []) {
  const host={}, listeners=new Set(),sent=[],timers=new Map(),buttons=[{disabled:false},{disabled:true}];let timerId=0;
  const gate={owner:null,queue:[]}, document={getElementById:()=>null,querySelectorAll:()=>buttons};
  const window={parent:host,ktxSaveToOEGate:gate,crypto:{randomUUID:()=> 'test-request'},
    addEventListener:(_type,fn)=>listeners.add(fn),removeEventListener:(_type,fn)=>listeners.delete(fn),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),postScript:script=>sent.push(script)};
  const context=vm.createContext({window,document,console,ArrayBuffer});vm.runInContext(bridgeSource,context);
  const emit=(data,source=host,origin='https://www.photopea.com')=>{for(const receive of [...listeners])receive({data,source,origin});};
  let currentRecords=records;
  host.postMessage=script=>{
    sent.push(script);
    vm.runInNewContext(script,{app:{documents:[doc],activeDocument:doc,echoToOE:emit},LayerKind});
    emit('done');
  };
  doc.saveToOE=()=>emit(psdFixture(currentRecords));
  return {api:window.ktxLayerCleaner,host,gate,buttons,emit,sent,timers,setRecords:r=>{currentRecords=r;}};
}
test('bridge ignores untagged, wrong-origin and wrong-source replies and restores the shared export gate',async()=>{
  const doc=fixture([pixel(1,{visible:false})]),h=bridge(doc);
  h.host.postMessage=script=>h.sent.push(script);
  const job=h.api.scan();
  assert.equal(h.gate.owner,'layer-cleaner');assert.deepEqual(h.buttons.map(b=>b.disabled),[true,true]);
  const reply='KTX_CLEANER|test-request|'+JSON.stringify({...execute(doc),exporting:false});
  h.emit('done');h.emit(reply,{},'https://www.photopea.com');h.emit(reply,h.host,'https://evil.example');
  assert.equal(h.gate.owner,'layer-cleaner');
  h.gate.queue.push('queued export');h.emit(reply);h.emit('done');
  assert.equal((await job).candidates[0].id,1);
  assert.equal(h.gate.owner,null);assert.deepEqual(h.buttons.map(b=>b.disabled),[false,true]);
  assert.equal(h.sent.at(-1),'queued export');assert.equal(h.timers.size,0);
});
test('bridge refuses busy operation and reports timeouts while releasing only its own lock',async()=>{
  const h=bridge(fixture([pixel(1)]));h.gate.owner='ai-review';
  await assert.rejects(h.api.scan(),{code:'BUSY'});assert.equal(h.sent.length,0);assert.equal(h.gate.owner,'ai-review');
  h.gate.owner=null;h.host.postMessage=()=>{};
  const job=h.api.scan();for(const timeout of [...h.timers.values()])timeout();
  await assert.rejects(job,{code:'TIMEOUT'});assert.equal(h.gate.owner,'layer-cleaner');
  await assert.rejects(h.api.scan(),{code:'BUSY'});
  h.emit(psdFixture([{id:1}]));assert.equal(h.gate.owner,'layer-cleaner');
  h.emit('done');assert.equal(h.gate.owner,null);assert.deepEqual(h.buttons.map(b=>b.disabled),[false,true]);
});
test('fresh PSD proof is required again before deleting an empty layer; a new mask aborts removal',async()=>{
  const doc=fixture([pixel(1,{bounds:[0,0,0,0]}),pixel(2)]),h=bridge(doc,[{id:1}]);
  const snapshot=await h.api.scan();assert.equal(snapshot.candidates[0].id,1);
  h.setRecords([{id:1,mask:true}]);
  await assert.rejects(h.api.remove(snapshot,[1]),{code:'DOCUMENT_CHANGED'});
  assert.equal(doc.layers.length,2);
});
test('bridge performs fresh scan and native ID verification before returning successful deletion',async()=>{
  const doc=fixture([pixel(1,{visible:false}),pixel(2,{visible:false,name:'Same'}),pixel(3,{name:'Same'})]),h=bridge(doc);
  const snapshot=await h.api.scan();const result=await h.api.remove(snapshot,[2]);
  assert.deepEqual(Array.from(result.deleted),[2]);assert.deepEqual(doc.layers.map(l=>l.id),[1,3]);
  assert.equal(h.sent.filter(script=>script.includes('var result=operate("scan"')).length,2);
  assert.equal(h.gate.owner,null);
});

test('UI: scanning never removes, cancel preserves, selection counts update, zero disables delete, names are safe and scroll bounded', {timeout:60000},async()=>{
  const server=http.createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1)||'plugin.html';
    if(!/^[\w.-]+$/.test(name)){res.writeHead(404).end();return;}
    try {
      let body=await readFile(new URL(name,root));
      if(name==='plugin.html')body=body.toString().replace('<script src="layer-cleaner-ui.js',`<script>
        window.cleanerCalls={scan:0,remove:[]};window.cleanerRows=Array.from({length:40},(_,i)=>({id:i+1,name:i<2?'Render':'&lt;img src=x onerror=alert(1)&gt; '+('Long name '.repeat(30))+i,parent:null,reasons:i%2?['hidden','zero']:['hidden']}));
        window.ktxLayerCleaner={scan:async()=>{cleanerCalls.scan++;return {meta:{source:'test'},candidates:cleanerRows,warning:''}},remove:async(snapshot,ids)=>{cleanerCalls.remove.push(ids);cleanerRows=cleanerRows.filter(r=>!ids.includes(r.id));return {deleted:ids}}};
        </script><script src="layer-cleaner-ui.js`);
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});
    const page=await browser.newPage({viewport:{width:380,height:1000}});
    await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    const start=page.locator('#layerCleanerScan'),remove=page.locator('#layerCleanerDelete'),checks=page.locator('#layerCleanerList input');
    await start.click();assert.equal(await checks.count(),40);assert.equal(await page.locator('#layerCleanerList input:checked').count(),40);
    assert.equal(await remove.innerText(),'USUŃ 40 WARSTW');
    assert.deepEqual(await page.evaluate(()=>cleanerCalls.remove),[]);
    await page.locator('#layerCleanerCancel').click();assert.equal(await page.locator('#layerCleanerPanel').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>cleanerCalls.remove),[]);
    await start.click(); await checks.nth(0).uncheck();await checks.nth(1).uncheck();
    assert.equal(await remove.innerText(),'USUŃ 38 WARSTW');
    assert.ok(await page.locator('#layerCleanerList').evaluate(e=>e.scrollHeight>e.clientHeight));
    assert.equal(await page.locator('#layerCleanerList img').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    for(const check of await checks.all())await check.uncheck();
    assert.equal(await remove.innerText(),'USUŃ 0 WARSTW');assert.equal(await remove.isEnabled(),false);
    await checks.nth(1).check();await remove.click();
    assert.deepEqual(await page.evaluate(()=>cleanerCalls.remove),[[2]]);
    assert.equal(await page.evaluate(()=>cleanerRows.some(r=>r.id===1)),true);
    assert.equal(await page.evaluate(()=>cleanerRows.some(r=>r.id===2)),false);
    await start.click();
    await mkdir(new URL('test-results/',root),{recursive:true});
    await page.locator('#layerCleaner').screenshot({path:new URL('test-results/020-cleaner-ui.png',root).pathname.replace(/^\/(?=[A-Za-z]:)/,'')});
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
