// Real Photopea with local release files, disposable PSDs and blocked AI endpoints.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {readLayers}=require('../rasterize-psd.js');
const root=path.resolve(__dirname,'..'),plugin='https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
const source=fs.readFileSync(path.join(root,'tests/rasterize-photopea-live.cjs'),'utf8');
const extract=name=>vm.runInNewContext(source.match(new RegExp('const '+name+' = (`[\\s\\S]*?`);'))[1]);
const bridge=extract('testBridge'),fixture=extract('createFixture'),readState=extract('readState');
const report={checks:[],cases:[],errors:[],aiRequests:0};
async function main(){
 const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.addInitScript(()=>{if(location.hostname==='www.photopea.com'){
    window.previewScripts=[];addEventListener('message',e=>{if(e.origin==='https://kubixsio.github.io'&&typeof e.data==='string')previewScripts.push(e.data);});
  }});
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname.includes('openai')||url.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
    if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname))return route.abort();
    if(url.hostname!=='kubixsio.github.io'||!url.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
    const name=path.basename(url.pathname);let body=fs.readFileSync(path.join(root,name));
    if(name==='plugin.html')body=body.toString().replace('</body>',bridge+'</body>');
    return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
  });
  const config={files:[plugin.replace('plugin.html','watermark-full.png')],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}};
  await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify(config)));
  await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
  const ui=page.frameLocator('iframe[src="'+plugin+'"]');await ui.locator('#thumbnailPreviewOpen').waitFor({state:'attached'});
  const frame=page.frames().find(f=>f.url()===plugin);await frame.waitForLoadState('domcontentloaded');
  assert.equal(await page.evaluate(()=>previewScripts.filter(s=>s.includes('saveToOE')).length),0);
  assert.equal(await ui.locator('#rasterizeScan').isEnabled(),true);assert.equal(await ui.locator('#layerCleanerScan').isEnabled(),true);
  report.checks.push('No snapshot/export at startup; Rasteryzuj and Layer Cleaner immediately enabled.');
  const exec=(script,format)=>frame.evaluate(([s,f])=>ktxRasterizeTest(s,f),[script,format]);
  const exports=()=>page.evaluate(()=>previewScripts.filter(s=>s.includes('saveToOE("png")')).length);
  const signature=()=>frame.evaluate(async()=>{const i=document.getElementById('checkPreviewImage'),bytes=await (await fetch(i.src)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');});
  const state=()=>exec(readState.replace('return out;','return {layers:out,active:+d.activeLayer.id};'));
  const history=()=>exec('var d=app.activeDocument;var out={};try{out.length=+d.historyStates.length;}catch(e){out.length=null;}return out;');
  const layout=()=>frame.evaluate(()=>{const rect=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};return {image:rect('checkPreviewImage'),stage:rect('checkPreviewStage'),modal:rect('checkPreviewModal'),navigation:rect('checkPreviewLeft')};});
  const stable=()=>frame.waitForFunction(()=>!document.getElementById('checkPreviewImage').getAnimations().some(a=>a.playState==='running'));
  const close=async()=>{await ui.locator('#checkPreviewClose').click();await frame.waitForFunction(()=>!document.getElementById('checkPreviewImage').hasAttribute('src'));};
  await ui.locator('#checkPreviewSection summary').click();
  assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);
  await exec("var d=app.documents.add(1280,720,72,'Historia podglądu');var l=d.artLayers.add();l.name='Próba historii';return true;");
  const simpleHistoryBefore=await history();assert.ok(simpleHistoryBefore.length<20);
  await ui.locator('#thumbnailPreviewOpen').click();await ui.locator('#checkPreviewModal').waitFor({state:'visible'});
  await ui.locator('#checkPreviewRight').click();await stable();await close();
  const simpleHistoryAfter=await history();assert.deepEqual(simpleHistoryAfter,simpleHistoryBefore);
  report.historyProof={before:simpleHistoryBefore,after:simpleHistoryAfter};
  for(const [width,height] of [[1920,1080],[1080,1080],[1080,1920]]){
    const script=fixture.replace('app.documents.add(128,72','app.documents.add('+width+','+height).replace('return ids;',`
      d.activeLayer=d.layers[d.layers.length-1];var bg=d.artLayers.add();bg.name='Tło testowe';
      d.selection.select([[0,0],[${width},0],[${width},${height}],[0,${height}]]);var ink=new SolidColor();ink.rgb.hexValue='172030';d.selection.fill(ink);d.selection.deselect();
      var hero=d.artLayers.add();hero.name='Główny obiekt';d.selection.select([[${width*.3},${height*.15}],[${width*.7},${height*.15}],[${width*.7},${height*.8}],[${width*.3},${height*.8}]]);ink.rgb.hexValue='D19C53';d.selection.fill(ink);d.selection.deselect();return ids;`);
    const ids=await exec(script);
    // Finish the freshly scripted fixture's first render (text/Smart Object caches)
    // before establishing the read-only baseline, as with an already opened PSD.
    await exec('return true;','png');
    let beforePsd;
    for(let attempt=0;attempt<60;attempt++){
      beforePsd=Uint8Array.from(await exec('return true;','psd'));
      const text=readLayers(beforePsd.buffer).get(ids.text);
      if(text.channels.some(channel=>channel.bytes.length>2))break;
      // Poll fixture font completion only; production preview never waits artificially.
      if(attempt===59)throw Error('Fixture text font did not finish rendering');
      await page.waitForTimeout(250);
    }
    const before=await state(),historyBefore=await history();
    const records=readLayers(beforePsd.buffer);assert.ok(records.get(ids.decorated).mask.length);assert.ok(records.get(ids.decorated).tags.has('lfx2'));assert.ok(records.get(ids.keep).tags.has('SoLd'));
    const count=await exports();await ui.locator('#thumbnailPreviewOpen').click();await ui.locator('#checkPreviewModal').waitFor({state:'visible'});
    const initial=await layout(),first=await signature();
    const sentBefore=await page.evaluate(()=>previewScripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
    assert.equal(await ui.locator('#checkPreviewSize').textContent(),'DUŻY');assert.equal(await exports(),count+1);
    const sizes=[];
    for(const [index,name] of ['DUŻY','ŚREDNI','MAŁY','BARDZO MAŁY'].entries()){
      if(index){await ui.locator('#checkPreviewRight').click();await stable();}
      const p=await layout();assert.equal(await ui.locator('#checkPreviewSize').textContent(),name);
      assert.ok(Math.abs(p.image.width/p.image.height-width/height)<0.01);
      assert.ok(Math.abs(p.image.x+p.image.width/2-p.stage.x-p.stage.width/2)<1);
      assert.ok(Math.abs(p.image.y+p.image.height/2-p.stage.y-p.stage.height/2)<1);
      assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);
      assert.deepEqual(p.modal,initial.modal);assert.deepEqual(p.navigation,initial.navigation);
      if(index)assert.ok(p.image.width<sizes.at(-1).width*.7);
      sizes.push({name,width:p.image.width,height:p.image.height});
      if(width===1920)await page.screenshot({path:path.join(root,'test-results/050-preview-'+index+'.png')});
      assert.equal(await page.evaluate(()=>previewScripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length),sentBefore);
    }
    assert.equal(await ui.locator('#checkPreviewRight').isDisabled(),true);
    for(const name of ['MAŁY','ŚREDNI','DUŻY']){await ui.locator('#checkPreviewLeft').click();await stable();assert.equal(await ui.locator('#checkPreviewSize').textContent(),name);}
    assert.equal(await ui.locator('#checkPreviewLeft').isDisabled(),true);assert.equal(await exports(),count+1);await close();
    const historyAfter=await history();report.lastHistory={before:historyBefore,after:historyAfter};
    assert.deepEqual(await state(),before);assert.deepEqual(historyAfter,historyBefore);
    const afterPsd=Uint8Array.from(await exec('return true;','psd'));
    assert.deepEqual(readLayers(afterPsd.buffer),records,'All PSD layer records, channels, masks, styles and Smart Object data must remain identical');
    const psdEqual=crypto.createHash('sha256').update(beforePsd).digest('hex')===crypto.createHash('sha256').update(afterPsd).digest('hex');
    await exec("var d=app.activeDocument,l=d.artLayers.add();l.name='Zmiana po zamknięciu';d.activeLayer=l;d.selection.select([[0,0],[600,0],[600,600],[0,600]]);var ink=new SolidColor();ink.rgb.hexValue='CC3355';d.selection.fill(ink);d.selection.deselect();return true;");
    const newer=await exports();await ui.locator('#thumbnailPreviewOpen').click();await ui.locator('#checkPreviewModal').waitFor({state:'visible'});
    assert.notEqual(await signature(),first);assert.equal(await exports(),newer+1);assert.equal(await ui.locator('#checkPreviewSize').textContent(),'DUŻY');await close();
    report.cases.push({width,height,sizes,historyBefore,historyAfter:historyBefore,psdBytesIdentical:psdEqual,layerRecordsIdentical:true,freshAfterEdit:true});
  }
  report.checks.push('Real PNG: all four centered sizes, preserved landscape/square/portrait aspect ratios, stable modal and one export per opening.');
  report.checks.push('Opening and navigation preserve layer records, masks, styles, Smart Objects, active layer and available history state; reopening after an edit is fresh.');
  assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);console.log(JSON.stringify(report,null,2));
 }finally{fs.writeFileSync(path.join(root,'test-results/050-preview-report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
