import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url);
// Reuse the existing read-only Photopea/PNG fixture, not a second export implementation.
const source=await readFile(new URL('check-preview.test.mjs',import.meta.url),'utf8');
const harness=vm.runInNewContext(source.match(/const harness=(`[\s\S]*?`);/)[1]);
test('Grayscale Check: actual rendered pixels, one snapshot, read-only state and stable layout',{timeout:120000},async t=>{
 const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;
   if(p==='/')return res.end(harness);if(!/^\/[\w.-]+$/.test(p))throw Error('Invalid path');
   res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(p.slice(1),root)));
 }catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port);
  const frame=page.frames().find(f=>f.url().endsWith('/plugin.html'));await frame.waitForLoadState('domcontentloaded');
  const ui=page.frameLocator('#plugin'),modal=ui.locator('#grayscaleModal'),image=ui.locator('#grayscaleImage');
  const open=async()=>{await ui.locator('#grayscaleCheckOpen').click();await modal.waitFor();};
  const close=async()=>{await ui.locator('#grayscaleClose').click();await frame.waitForFunction(()=>!document.getElementById('grayscaleImage').hasAttribute('src'));};
  const sent=()=>page.evaluate(()=>scripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const exports=()=>page.evaluate(()=>window.exports);
  const layout=()=>frame.evaluate(()=>{const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:box('grayscaleModal'),stage:box('grayscaleStage'),image:box('grayscaleImage'),controls:box('grayscaleOriginal')};});
  const pixel=async()=>frame.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);return Array.from(x.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data);},Array.from(await image.screenshot()));
  await t.test('startup has no snapshot or grayscale work; only three future checks remain disabled',async()=>{
    assert.equal(await exports(),0);assert.equal(await image.getAttribute('src'),null);assert.equal(await image.getAttribute('class'),null);
    await ui.locator('#checkPreviewSection summary').click();assert.equal(await ui.locator('#grayscaleCheckOpen').isEnabled(),true);
    assert.equal(await ui.locator('#thumbnailPreviewOpen').isEnabled(),true);
    assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),3);
  });
  await t.test('click obtains one PNG and uses a local loading state',async()=>{
    await page.evaluate(()=>delay=250);await ui.locator('#grayscaleCheckOpen').evaluate(b=>{b.click();b.click();});
    assert.equal(await ui.locator('#grayscaleCheckOpen').isDisabled(),true);
    for(const id of ['rasterizeScan','layerCleanerScan','thumbnailPreviewOpen'])assert.equal(await ui.locator('#'+id).isEnabled(),true);
    await modal.waitFor();assert.equal(await exports(),1);
  });
  await t.test('modal defaults to GRAYSCALE and contains one large image, without size controls or scores',async()=>{
    assert.equal(await ui.locator('#grayscaleTitle').textContent(),'GRAYSCALE CHECK');
    assert.equal(await ui.locator('#grayscaleGray').getAttribute('aria-pressed'),'true');
    assert.equal(await ui.locator('#grayscaleOriginal').getAttribute('aria-pressed'),'false');assert.equal(await modal.locator('img').count(),1);
    assert.doesNotMatch(await modal.innerText(),/DUŻY|MAŁY|DOBRZE|ŹLE|\d+\s*\/\s*10/);
  });
  await t.test('real browser screenshot removes chroma with neutral luminance and no extra contrast or brightness',async()=>{
    const rgba=await pixel();assert.ok(Math.abs(rgba[0]-rgba[1])<=1&&Math.abs(rgba[1]-rgba[2])<=1);
    const luminance=51*.2126+85*.7152+119*.0722;assert.ok(Math.abs(rgba[0]-luminance)<=1);
    assert.equal(await image.evaluate(e=>getComputedStyle(e).filter),'grayscale(1)');
  });
  await t.test('ORYGINAŁ displays the unchanged original PNG',async()=>{
    const url=await image.getAttribute('src');await ui.locator('#grayscaleOriginal').click();
    assert.equal(await image.getAttribute('src'),url);assert.deepEqual(await pixel(),[51,85,119,255]);
    assert.equal(await image.evaluate(e=>getComputedStyle(e).filter),'none');
  });
  await t.test('repeated toggles are immediate, stable and send no further Photopea messages',async()=>{
    const before=await layout(),count=await sent(),pngs=await exports(),url=await image.getAttribute('src');
    for(const id of ['grayscaleGray','grayscaleOriginal','grayscaleGray','grayscaleOriginal']){
      await ui.locator('#'+id).click();assert.equal(await ui.locator('#'+id).getAttribute('aria-pressed'),'true');
      assert.deepEqual(await layout(),before);assert.equal(await image.getAttribute('src'),url);
      assert.equal(await image.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
      assert.equal(await sent(),count);assert.equal(await exports(),pngs);
    }
  });
  await t.test('closing releases the snapshot and restores focus',async()=>{
    await close();assert.equal(await modal.isVisible(),false);assert.equal(await ui.locator('#grayscaleCheckOpen').evaluate(e=>document.activeElement===e),true);
  });
  await t.test('reopening captures a new image and resets to grayscale',async()=>{
    await page.evaluate(()=>{version++;delay=10;});const before=await exports();await open();assert.equal(await exports(),before+1);
    assert.equal(await ui.locator('#grayscaleGray').getAttribute('aria-pressed'),'true');await ui.locator('#grayscaleOriginal').click();assert.deepEqual(await pixel(),[187,68,85,255]);await close();
  });
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920],[1600,400]])await t.test('full, centered composition preserves '+w+'×'+h,async()=>{
    await page.evaluate(([w,h])=>{doc.width=w;doc.height=h;},[w,h]);await open();const p=await layout();
    assert.ok(Math.abs(p.image.width/p.image.height-w/h)<0.01);assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);
    assert.ok(Math.abs(p.image.x+p.image.width/2-p.stage.x-p.stage.width/2)<1);assert.ok(Math.abs(p.image.y+p.image.height/2-p.stage.y-p.stage.height/2)<1);
    await close();
  });
  await t.test('snapshot leaves the AI session untouched and Escape closes the check',async()=>{
    await frame.evaluate(async()=>{const s=ktxAiReviewSession,c=await s.capture({disableButtons:false});await s.acceptPreview(c);await s.setNotes('Zachowaj uwagi');});
    const saved=()=>frame.evaluate(()=>JSON.stringify(ktxAiReviewSession.getState(),(k,v)=>v instanceof Blob?{size:v.size,type:v.type}:v));
    const before=await saved();await open();await ui.locator('#grayscaleOriginal').click();await page.keyboard.press('Escape');
    await frame.waitForFunction(()=>!document.getElementById('grayscaleImage').hasAttribute('src'));assert.equal(await saved(),before);
  });
  await t.test('Thumbnail Preview remains in color and retains all four sizes',async()=>{
    await ui.locator('#thumbnailPreviewOpen').click();await ui.locator('#checkPreviewModal').waitFor();
    assert.equal(await ui.locator('#checkPreviewImage').evaluate(e=>getComputedStyle(e).filter),'none');
    assert.equal(await ui.locator('#checkPreviewSize').textContent(),'DUŻY');
    for(const name of ['ŚREDNI','MAŁY','BARDZO MAŁY']){await ui.locator('#checkPreviewRight').click();assert.equal(await ui.locator('#checkPreviewSize').textContent(),name);}
    await ui.locator('#checkPreviewClose').click();
  });
  await t.test('missing document shows a message without opening the modal or exporting',async()=>{
    await page.evaluate(()=>doc=null);const before=await exports();await ui.locator('#grayscaleCheckOpen').click();
    await ui.locator('#grayscaleStatus').filter({hasText:'Brak otwartego dokumentu'}).waitFor();assert.equal(await modal.isVisible(),false);assert.equal(await exports(),before);
    assert.equal(await ui.locator('#grayscaleCheckOpen').isEnabled(),true);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
