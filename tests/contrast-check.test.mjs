import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url);
const source=await readFile(new URL('check-preview.test.mjs',import.meta.url),'utf8');
const harness=vm.runInNewContext(source.match(/const harness=(`[\s\S]*?`);/)[1]);
test('Contrast Check: luminance zones, distinct levels, original memory and snapshot isolation',{timeout:120000},async t=>{
 const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;if(p==='/')return res.end(harness);if(!/^\/[\w.-]+$/.test(p))throw Error('Invalid path');res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(p.slice(1),root)));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());await page.goto('http://127.0.0.1:'+server.address().port);
  const frame=page.frames().find(f=>f.url().endsWith('/plugin.html'));await frame.waitForLoadState('domcontentloaded');
  await page.evaluate(()=>{window.bytes=function(){const c=document.createElement('canvas');c.width=doc.width;c.height=doc.height;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,c.width,0);g.addColorStop(0,'#000000');g.addColorStop(.33,'#25658c');g.addColorStop(.66,'#c7b278');g.addColorStop(1,'#ffffff');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);if(version){x.fillStyle='#bb4455';x.fillRect(0,0,c.width*.2,c.height*.2);}return Uint8Array.from(atob(c.toDataURL().split(',')[1]),v=>v.charCodeAt(0));};});
  const ui=page.frameLocator('#plugin'),modal=ui.locator('#contrastModal'),image=ui.locator('#contrastImage');
  const open=async()=>{await ui.locator('#contrastCheckOpen').click();await modal.waitFor();},close=async()=>{await ui.locator('#contrastClose').click();await frame.waitForFunction(()=>!document.getElementById('contrastImage').hasAttribute('src'));};
  const count=()=>page.evaluate(()=>window.exports),sent=()=>page.evaluate(()=>scripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const layout=()=>frame.evaluate(()=>{const b=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:b('contrastModal'),stage:b('contrastStage'),image:b('contrastImage'),controls:b('contrastOriginal'),arrows:b('contrastLeft')};});
  const pixels=()=>frame.evaluate(async()=>{const bytes=await(await fetch(document.getElementById('contrastImage').src)).arrayBuffer(),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);const d=x.getImageData(0,0,c.width,c.height).data,hist=new Map();let colored=0;for(let i=0;i<d.length;i+=4)if(d[i+3]){hist.set(d[i],(hist.get(d[i])||0)+1);if(d[i]!==d[i+1]||d[i]!==d[i+2])colored++;}return {palette:[...hist.keys()].sort((a,b)=>a-b),hist:[...hist],colored,corner:Array.from(d.slice((c.width+1)*4,(c.width+1)*4+4)),hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).join(',')};});
  let light,medium,strong,base,messages;
  await t.test('startup performs no capture or processing; only Focus remains disabled',async()=>{
    assert.equal(await count(),0);assert.equal(await image.getAttribute('src'),null);await ui.locator('#checkPreviewSection summary').click();
    for(const id of ['thumbnailPreviewOpen','grayscaleCheckOpen','blurCheckOpen','contrastCheckOpen'])assert.equal(await ui.locator('#'+id).isEnabled(),true);
    assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);assert.equal(await ui.getByRole('button',{name:/Focus Preview/}).isDisabled(),true);
  });
  await t.test('click captures once, starts LEKKI and keeps other tools enabled while loading',async()=>{
    await page.evaluate(()=>delay=250);await ui.locator('#contrastCheckOpen').evaluate(b=>{b.click();b.click();});assert.equal(await ui.locator('#contrastCheckOpen').isDisabled(),true);
    for(const id of ['thumbnailPreviewOpen','grayscaleCheckOpen','blurCheckOpen','rasterizeScan','layerCleanerScan'])assert.equal(await ui.locator('#'+id).isEnabled(),true);
    await modal.waitFor();assert.equal(await count(),1);assert.equal(await ui.locator('#contrastLevel').textContent(),'LEKKI');assert.equal(await ui.locator('#contrastEnabled').getAttribute('aria-pressed'),'true');base=await layout();messages=await sent();
  });
  await t.test('LEKKI is achromatic and quantized into 12 fixed brightness zones',async()=>{light=await pixels();assert.equal(light.colored,0);assert.deepEqual(light.palette,[0,23,46,70,93,116,139,162,185,209,232,255]);assert.equal(await image.evaluate(e=>getComputedStyle(e).filter),'none');});
  await t.test('ŚREDNI reduces the palette to six zones and visibly differs from LEKKI',async()=>{await ui.locator('#contrastRight').click();medium=await pixels();assert.equal(await ui.locator('#contrastLevel').textContent(),'ŚREDNI');assert.deepEqual(medium.palette,[0,51,102,153,204,255]);assert.notEqual(medium.hash,light.hash);});
  await t.test('MOCNY uses four zones including two midtones, never a binary threshold',async()=>{await ui.locator('#contrastRight').click();strong=await pixels();assert.deepEqual(strong.palette,[0,85,170,255]);assert.equal(strong.colored,0);assert.notEqual(strong.hash,medium.hash);assert.ok(strong.hist.filter(([tone])=>tone===85||tone===170).every(([,n])=>n>1000));});
  await t.test('arrows stop at MOCNY and reverse through ŚREDNI to LEKKI without wrapping',async()=>{
    assert.equal(await ui.locator('#contrastRight').isDisabled(),true);await ui.locator('#contrastRight').evaluate(b=>b.click());assert.equal(await ui.locator('#contrastLevel').textContent(),'MOCNY');
    for(const name of ['ŚREDNI','LEKKI']){await ui.locator('#contrastLeft').click();assert.equal(await ui.locator('#contrastLevel').textContent(),name);}assert.equal(await ui.locator('#contrastLeft').isDisabled(),true);await ui.locator('#contrastLeft').evaluate(b=>b.click());assert.equal(await ui.locator('#contrastLevel').textContent(),'LEKKI');
  });
  for(const level of ['ŚREDNI','MOCNY'])await t.test('ORYGINAŁ restores color and CONTRAST remembers '+level,async()=>{
    await ui.locator('#contrastRight').click();await ui.locator('#contrastOriginal').click();const original=await pixels();assert.ok(original.colored>10000);assert.ok(original.palette.length>100);
    await ui.locator('#contrastEnabled').click();assert.equal(await ui.locator('#contrastLevel').textContent(),level);assert.equal((await pixels()).hash,level==='MOCNY'?strong.hash:medium.hash);
  });
  await t.test('switching never changes layout or sends any additional Photopea command',async()=>{for(const id of ['contrastOriginal','contrastEnabled','contrastLeft','contrastLeft','contrastRight','contrastRight']){await ui.locator('#'+id).click();assert.deepEqual(await layout(),base);assert.equal(await count(),1);assert.equal(await sent(),messages);assert.equal(await image.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');}});
  await t.test('modal has one image, no sliders, scores or automatic advice',async()=>{assert.equal(await modal.locator('img').count(),1);assert.equal(await modal.locator('input').count(),0);assert.doesNotMatch(await modal.innerText(),/DOBRZE|ŹLE|\d+\s*\/\s*10|\d+\s*px/);});
  await t.test('closing releases the image and reopening captures the edit at LEKKI',async()=>{await close();await page.evaluate(()=>{version++;delay=10;});const n=await count();await open();assert.equal(await count(),n+1);assert.equal(await ui.locator('#contrastLevel').textContent(),'LEKKI');assert.notEqual((await pixels()).hash,light.hash);await ui.locator('#contrastOriginal').click();assert.deepEqual((await pixels()).corner,[187,68,85,255]);await close();});
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920],[1600,400]])await t.test('full centered composition preserves '+w+'×'+h,async()=>{
    await page.evaluate(([w,h])=>{doc.width=w;doc.height=h;},[w,h]);await open();const p=await layout();assert.ok(Math.abs(p.image.width/p.image.height-w/h)<.01);assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);assert.ok(Math.abs(p.image.x+p.image.width/2-p.stage.x-p.stage.width/2)<1);assert.ok(Math.abs(p.image.y+p.image.height/2-p.stage.y-p.stage.height/2)<1);await close();
  });
  await t.test('AI session remains untouched and Escape closes the modal',async()=>{
    await frame.evaluate(async()=>{const s=ktxAiReviewSession,c=await s.capture({disableButtons:false});await s.acceptPreview(c);await s.setNotes('Moje uwagi');});const saved=()=>frame.evaluate(()=>JSON.stringify(ktxAiReviewSession.getState(),(k,v)=>v instanceof Blob?{size:v.size,type:v.type}:v));const before=await saved();await open();await ui.locator('#contrastRight').click();await page.keyboard.press('Escape');await frame.waitForFunction(()=>!document.getElementById('contrastImage').hasAttribute('src'));assert.equal(await saved(),before);
  });
  await t.test('missing document reports an error without opening or exporting',async()=>{await page.evaluate(()=>doc=null);const n=await count();await ui.locator('#contrastCheckOpen').click();await ui.locator('#contrastStatus').filter({hasText:'Brak otwartego dokumentu'}).waitFor();assert.equal(await modal.isVisible(),false);assert.equal(await count(),n);assert.equal(await ui.locator('#contrastCheckOpen').isEnabled(),true);});
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
