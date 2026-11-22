import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import position from '../rasterize-position.js';

function doc(source) {
  return {source, name:'Same.psd', get layers() {throw Error('Identity must never inspect layers');},
    saveToOE() {throw Error('Identity must never export');}};
}
function query(host, documents, activeDocument, markSource = null) {
  let reply;
  vm.runInNewContext(position.buildScript('STATE|', markSource), {
    window:host, app:{documents,activeDocument,echoToOE:value=>{reply=JSON.parse(value.slice(6));}}
  });
  return reply;
}
test('native instance IDs preserve independent same-name document marks across plugin instances and switching', () => {
  const host={}, a=doc('local,7,Same.psd'), b=doc('local,8,Same.psd');
  assert.deepEqual(query(host,[a,b],a),{key:'local:7',source:a.source,used:false});
  assert.equal(query(host,[a,b],a,a.source).used,true);
  assert.equal(query(host,[a,b],b).used,false);
  assert.equal(query(host,[a,b],a).used,true);
  // Each query executes in a new interpreter context, while the Photopea window survives.
  assert.equal(query(host,[a,b],b,b.source).used,true);
  assert.equal(query(host,[a,b],a).used,true);
  assert.equal(query(host,[a,b],b).used,true);
  assert.equal(query(host,[a,b,doc('local,9,Same.psd')],doc('local,9,Same.psd')).used,false);
});
test('closed/reopened files start unused, renaming keeps the instance, and a fresh Photopea session resets marks', () => {
  const host={}, a=doc('local,4,Same.psd');
  query(host,[a],a,a.source);
  a.source='local,4,Renamed.psd'; a.name='Renamed';
  assert.equal(query(host,[a],a).used,true);
  const reopened=doc('local,5,Same.psd');
  assert.equal(query(host,[reopened],reopened).used,false);
  assert.deepEqual(JSON.parse(host.ktxRasterizePositionV1),[]);
  assert.equal(query({},[a],a).used,false);
  assert.deepEqual(query(host,[],null),{key:null,source:null,used:false});
});
test('ambiguous instance IDs and URL-only sources never restore or persist a guessed document identity', () => {
  const host={}, a=doc('local,1,Same.psd'), duplicate=doc('local,1,Other.psd');
  query(host,[a],a,a.source);
  assert.equal(query(host,[a,duplicate],a,a.source).used,false);
  assert.equal(query(host,[duplicate],duplicate).used,false);
  const remote=doc('https://example.test/same.psd');
  assert.deepEqual(query(host,[remote],remote,remote.source),{key:null,source:remote.source,used:false});
  assert.deepEqual(JSON.parse(host.ktxRasterizePositionV1),[]);
});

test('document observation restores UI state, skips occupied export gates, and stops with the iframe', async () => {
  const code = await readFile(new URL('../rasterize-position.js',import.meta.url),'utf8');
  const listeners=new Map(), timers=new Map(), sent=[], values=[];
  const host={}, gate={owner:null}; let timerId=0, used=false;
  const window={parent:host,ktxSaveToOEGate:gate,crypto:{randomUUID:()=>String(sent.length)},
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}};
  const document={getElementById:()=>null};
  host.postMessage=script=>{
    sent.push(script);
    const marker=JSON.parse(script.match(/app\.echoToOE\(("KTX_RASTERIZE_POSITION\|[^"]+")/)[1]);
    queueMicrotask(()=>{
      for(const fn of [...listeners.get('message')]) fn({source:host,origin:'https://www.photopea.com',data:marker+JSON.stringify({key:'local:0',source:'local,0,A',used})});
      for(const fn of [...listeners.get('message')]) fn({source:host,origin:'https://www.photopea.com',data:'done'});
    });
  };
  vm.runInNewContext(code,{window,document});
  const observer=window.ktxRasterizePosition.observe(state=>values.push(state));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(values.at(-1).used,false);assert.equal(sent.length,1);
  used=true;await observer.mark('local,0,A');
  assert.equal(values.at(-1).used,true);
  gate.owner='ai-review';const before=sent.length;
  await observer.mark('local,0,A');assert.equal(sent.length,before);
  for(const stop of listeners.get('pagehide'))stop();
  assert.equal(timers.size,0);
});

test('position UI can repeatedly move between the exact original slot and the first section', async () => {
  const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});
  try {
    const page=await browser.newPage();
    const source=await readFile(new URL('../plugin.html',import.meta.url),'utf8');
    await page.setContent(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace(/<img\b[^>]*>/g,''));
    await page.evaluate(()=>{
      window.marks=[];
      window.ktxRasterizePosition={observe(listener){window.showPosition=listener;return {mark:async source=>marks.push(source)};}};
      window.ktxRasterize={scan:async()=>({meta:{source:'local,1,Same.psd'},candidates:[{id:1,name:'Smart'}]}),rasterize:async()=>1};
    });
    await page.addScriptTag({content:await readFile(new URL('../rasterize-ui.js',import.meta.url),'utf8')});
    const top=()=>page.evaluate(()=>document.querySelector('.wrap > .section').contains(document.getElementById('rasterize')));
    const show=(source,used)=>page.evaluate(([source,used])=>showPosition({source,key:source.split(',')[1],used}),[source,used]);
    assert.equal(await top(),true);
    await show('local,1,Same.psd',false);
    await page.locator('#rasterizeScan').click();await page.locator('#rasterizeCancel').click();
    assert.equal(await top(),true);assert.deepEqual(await page.evaluate(()=>marks),[]);
    await page.locator('#rasterizeScan').click();await page.locator('#rasterizeApply').click();
    assert.deepEqual(await page.evaluate(()=>marks),['local,1,Same.psd']);
    assert.equal(await top(),false);
    await show('local,2,Same.psd',false);assert.equal(await top(),true);
    await show('local,1,Same.psd',true);assert.equal(await top(),false);
    await show('local,2,Same.psd',true);assert.equal(await top(),false);
    await show('local,3,Same.psd',false);assert.equal(await top(),true);
    await show('local,1,Same.psd',true);
    assert.equal(await page.locator('#rasterize').evaluate(node=>node.previousElementSibling.id),'layerCleaner');
  } finally {await browser.close();}
});
