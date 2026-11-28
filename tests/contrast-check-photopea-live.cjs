// Real Photopea, local plugin files, disposable PSDs and blocked OpenAI endpoints.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),{readLayers}=require('../rasterize-psd.js');
const root=path.resolve(__dirname,'..'),plugin='https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
const source=fs.readFileSync(path.join(root,'tests/rasterize-photopea-live.cjs'),'utf8');
const extract=name=>vm.runInNewContext(source.match(new RegExp('const '+name+' = (`[\\s\\S]*?`);'))[1]);
const bridge=extract('testBridge'),fixture=extract('createFixture'),readState=extract('readState');
const realImage=process.env.KTX_CONTRAST_IMAGE||path.join(root,'obrobkaporadnik.jpg'),realUrl=plugin.replace('plugin.html','contrast-real'+path.extname(realImage));
const report={checks:[],cases:[],errors:[],aiRequests:0};
async function main(){
 const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
 let page;
 try{
  page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>report.errors.push(e.message));
  await page.addInitScript(()=>{if(location.hostname==='www.photopea.com'){window.contrastScripts=[];addEventListener('message',e=>{if(e.origin==='https://kubixsio.github.io'&&typeof e.data==='string')contrastScripts.push(e.data);});}});
  await page.route('**/*',route=>{const u=new URL(route.request().url());
    if(u.hostname.includes('openai')||u.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
    if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(u.hostname))return route.abort();
    if(u.hostname!=='kubixsio.github.io'||!u.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
    if(u.href===realUrl)return route.fulfill({body:fs.readFileSync(realImage),contentType:realImage.endsWith('.png')?'image/png':'image/jpeg',headers:{'access-control-allow-origin':'*'}});
    const name=path.basename(u.pathname);let body=fs.readFileSync(path.join(root,name));if(name==='plugin.html')body=body.toString().replace('</body>',bridge+'</body>');
    return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
  });
  await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify({files:[realUrl],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}})));
  await page.getByText(/^contrast-real/).first().waitFor({timeout:15000});
  await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
  const ui=page.frameLocator('iframe[src="'+plugin+'"]');await ui.locator('#contrastCheckOpen').waitFor({state:'attached'});
  let frame=await(await page.locator('iframe[src="'+plugin+'"]').elementHandle()).contentFrame();await frame.waitForLoadState('domcontentloaded');
  const exec=(s,f)=>frame.evaluate(([s,f])=>ktxRasterizeTest(s,f),[s,f]);
  const state=()=>exec(readState.replace('return out;','return {layers:out,active:+d.activeLayer.id,history:+d.historyStates.length};'));
  const exports=()=>page.evaluate(()=>contrastScripts.filter(s=>s.includes('saveToOE("png")')).length);
  const sent=()=>page.evaluate(()=>contrastScripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const open=async()=>{await ui.locator('#contrastCheckOpen').click();await ui.locator('#contrastModal').waitFor();};
  const close=async()=>{await ui.locator('#contrastClose').click();await frame.waitForFunction(()=>!document.getElementById('contrastImage').hasAttribute('src'));};
  const layout=()=>frame.evaluate(()=>{const b=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:b('contrastModal'),stage:b('contrastStage'),image:b('contrastImage'),controls:b('contrastOriginal')};});
  const signature=()=>frame.evaluate(async()=>{const b=await(await fetch(document.getElementById('contrastImage').src)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).join(',');});
  // Hash larger real-document exports inside the browser instead of serializing millions of numbers.
  const exportHash=format=>frame.evaluate(format=>new Promise((resolve,reject)=>{
    const marker='CONTRAST_HASH|'+crypto.randomUUID();let tagged=false,bytes=null;
    const timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Export hash timeout'));},30000);
    async function receive(e){if(e.source!==parent||e.origin!=='https://www.photopea.com')return;
      if(e.data===marker)tagged=true;else if(tagged&&e.data instanceof ArrayBuffer)bytes=e.data;
      else if(tagged&&e.data==='done'&&bytes){clearTimeout(timer);removeEventListener('message',receive);resolve(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join(''));}
    }
    addEventListener('message',receive);parent.postMessage('app.echoToOE('+JSON.stringify(marker)+');app.activeDocument.saveToOE('+JSON.stringify(format)+');','https://www.photopea.com');
  }),format);
  const pixels=()=>frame.evaluate(async()=>{const bytes=await(await fetch(document.getElementById('contrastImage').src)).arrayBuffer(),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);const d=x.getImageData(0,0,c.width,c.height).data,hist=new Map();let colored=0,changed=0,opaque=0;for(let i=0;i<d.length;i+=4)if(d[i+3]){opaque++;hist.set(d[i],(hist.get(d[i])||0)+1);if(d[i]!==d[i+1]||d[i]!==d[i+2])colored++;if(window.previousContrastPixels&&previousContrastPixels.length===d.length&&previousContrastPixels[i]!==d[i])changed++;}window.previousContrastPixels=new Uint8Array(d);return {palette:[...hist.keys()].sort((a,b)=>a-b),hist:[...hist],colored,opaque,difference:changed/opaque};});
  assert.equal(await exports(),0);await ui.locator('#checkPreviewSection summary').click();assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);
  // A real colored thumbnail is checked before the structured PSD fixtures.
  for(let i=0;i<60;i++){
    try{if(await exec('return app.documents.length>0;'))break;}
    catch(error){if(!/Execution context was destroyed|Frame was detached/.test(String(error)))throw error;frame=await(await page.locator('iframe[src="'+plugin+'"]').elementHandle()).contentFrame();await frame.waitForLoadState('domcontentloaded');}
    if(i===59)throw Error('Real image did not load');await page.waitForTimeout(250);
  }
  await exportHash('png');const realBefore=await state(),realPsd=await exportHash('psd'),realCount=await exports();
  await open();const realLayout=await layout(),realMessages=await sent(),realLevels=[];
  for(const [i,name]of ['LEKKI','ŚREDNI','MOCNY'].entries()){
    if(i)await ui.locator('#contrastRight').click();assert.equal(await ui.locator('#contrastLevel').textContent(),name);const p=await pixels();assert.equal(p.colored,0);assert.ok(p.palette.length>=3&&p.palette.length<=[12,6,4][i]);if(i)assert.ok(p.difference>.15);
    realLevels.push({name,palette:p.palette,hist:p.hist,difference:p.difference});assert.deepEqual(await layout(),realLayout);assert.equal(await sent(),realMessages);assert.equal(await exports(),realCount+1);
    await page.screenshot({path:path.join(root,'test-results/053-real-contrast-'+i+'.png')});
  }
  await ui.locator('#contrastOriginal').click();assert.ok((await pixels()).colored>10000);await page.screenshot({path:path.join(root,'test-results/053-real-original.png')});await ui.locator('#contrastEnabled').click();assert.equal(await ui.locator('#contrastLevel').textContent(),'MOCNY');
  await close();assert.deepEqual(await state(),realBefore);assert.equal(await exportHash('psd'),realPsd);report.realGraphic={levels:realLevels,readOnly:true};
  await exec("var d=app.documents.add(1280,720,72,'Historia contrast');var l=d.artLayers.add();l.name='Historia';return true;");
  const simpleBefore=await state();assert.ok(simpleBefore.history<20);await open();await ui.locator('#contrastOriginal').click();await ui.locator('#contrastEnabled').click();await close();assert.deepEqual(await state(),simpleBefore);report.historyProof={before:simpleBefore.history,after:simpleBefore.history};
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920]]){
    const script=fixture.replace('app.documents.add(128,72','app.documents.add('+w+','+h).replace('return ids;',`
      d.activeLayer=d.layers[d.layers.length-1];var bg=d.artLayers.add();bg.name='Tło testowe';d.selection.select([[0,0],[${w},0],[${w},${h}],[0,${h}]]);var ink=new SolidColor();ink.rgb.hexValue='141E32';d.selection.fill(ink);d.selection.deselect();
      var hero=d.artLayers.add();hero.name='Kolorowy obiekt';d.selection.select([[${w*.4},${h*.15}],[${w*.8},${h*.15}],[${w*.8},${h*.8}],[${w*.4},${h*.8}]]);ink.rgb.hexValue='E6AA50';d.selection.fill(ink);d.selection.deselect();var detail=d.artLayers.add();detail.name='Drobne detale';for(var n=0;n<40;n++){var xx=${w}*(.05+n*.005);d.selection.select([[xx,${h*.15}],[xx+${w*.005},${h*.15}],[xx+${w*.005},${h*.85}],[xx,${h*.85}]]);ink.rgb.hexValue=n%2?'FAE6B4':'224488';d.selection.fill(ink);}d.selection.deselect();return ids;`);
    const ids=await exec(script);await exec('return true;','png');let beforePsd;
    for(let i=0;i<60;i++){beforePsd=Uint8Array.from(await exec('return true;','psd'));if(readLayers(beforePsd.buffer).get(ids.text).channels.some(c=>c.bytes.length>2))break;if(i===59)throw Error('Fixture font did not render');await page.waitForTimeout(250);}
    const before=await state(),records=readLayers(beforePsd.buffer),count=await exports();
    assert.ok(records.get(ids.decorated).mask.length);assert.ok(records.get(ids.decorated).tags.has('lfx2'));assert.ok(records.get(ids.keep).tags.has('SoLd'));
    await open();assert.equal(await exports(),count+1);assert.equal(await ui.locator('#contrastEnabled').getAttribute('aria-pressed'),'true');
    const initial=await layout(),first=await signature(),url=await ui.locator('#contrastImage').getAttribute('src'),messages=await sent();
    assert.ok(Math.abs(initial.image.width/initial.image.height-w/h)<0.01);assert.ok(initial.image.width<=initial.stage.width&&initial.image.height<=initial.stage.height);
    assert.ok(Math.abs(initial.image.x+initial.image.width/2-initial.stage.x-initial.stage.width/2)<1);assert.ok(Math.abs(initial.image.y+initial.image.height/2-initial.stage.y-initial.stage.height/2)<1);
    const levels=[];
    for(const [i,name]of ['LEKKI','ŚREDNI','MOCNY'].entries()){
      if(i)await ui.locator('#contrastRight').click();assert.equal(await ui.locator('#contrastLevel').textContent(),name);const p=await pixels();
      assert.equal(p.colored,0);assert.ok(p.palette.length<=([12,6,4][i]));assert.ok(p.palette.length>=3);if(i)assert.ok(p.difference>.15,JSON.stringify(p));
      assert.deepEqual(await layout(),initial);levels.push({name,palette:p.palette,difference:p.difference});
    }
    assert.equal(await ui.locator('#contrastRight').isDisabled(),true);
    for(const [id,name]of [['contrastLeft','ŚREDNI'],['contrastLeft','LEKKI'],['contrastRight','ŚREDNI'],['contrastRight','MOCNY'],['contrastOriginal','MOCNY'],['contrastEnabled','MOCNY'],['contrastLeft','ŚREDNI'],['contrastOriginal','ŚREDNI'],['contrastEnabled','ŚREDNI']]){
      await ui.locator('#'+id).click();assert.equal(await ui.locator('#contrastLevel').textContent(),name);const p=await pixels();
      if(id==='contrastOriginal')assert.ok(p.colored>p.opaque*.2);else assert.deepEqual(p.palette,levels.find(l=>l.name===name).palette);
      assert.deepEqual(await layout(),initial);assert.equal(await sent(),messages);assert.equal(await exports(),count+1);
    }
    await close();assert.deepEqual(await state(),before);
    const afterPsd=Uint8Array.from(await exec('return true;','psd'));assert.deepEqual(readLayers(afterPsd.buffer),records);
    const hash=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(hash(afterPsd),hash(beforePsd));
    await exec("var d=app.activeDocument,l=d.artLayers.add();l.name='Nowy kolor';d.selection.select([[0,0],[600,0],[600,600],[0,600]]);var ink=new SolidColor();ink.rgb.hexValue='CC3355';d.selection.fill(ink);d.selection.deselect();return true;");
    await open();assert.notEqual(await signature(),first);assert.equal(await ui.locator('#contrastEnabled').getAttribute('aria-pressed'),'true');await close();
    report.cases.push({width:w,height:h,levels,originalMemory:true,stableModal:true,oneSnapshot:true,psdBytesIdentical:true,freshAfterEdit:true});
  }
  report.checks.push('Brightness zones use 12/6/4 tones, retain midtones and remember the level. All controls are local and preserve layout.');
  report.checks.push('Landscape, square and portrait retain proportions; PSD bytes and history stay identical; reopening after edit is fresh.');
  assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);console.log(JSON.stringify(report,null,2));
 }catch(error){if(page){report.failure=String(error);report.tabs=await page.locator('[draggable]').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,title:n.title})));await page.screenshot({path:path.join(root,'test-results/053-harness-failure.png')});}throw error;
 }finally{fs.writeFileSync(path.join(root,'test-results/053-contrast-report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
