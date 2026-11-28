import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url);
const source=await readFile(new URL('check-preview.test.mjs',import.meta.url),'utf8');
const harness=vm.runInNewContext(source.match(/const harness=(`[\s\S]*?`);/)[1]);
test('Blur Check: rendered blur strengths, original memory, one snapshot and read-only state',{timeout:120000},async t=>{
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
  await page.evaluate(()=>{window.bytes=function(){const c=document.createElement('canvas');c.width=doc.width;c.height=doc.height;const x=c.getContext('2d');x.fillStyle=version?'#bb4455':'#141e32';x.fillRect(0,0,c.width,c.height);
    x.fillStyle='#e6aa50';x.fillRect(c.width*.4,c.height*.2,c.width*.4,c.height*.6);
    for(let i=0;i<80;i++){x.fillStyle=i%2?'#fae6b4':'#224488';x.fillRect(c.width*(.05+i*.003),c.height*.15,c.width*.003,c.height*.7);}
    return Uint8Array.from(atob(c.toDataURL().split(',')[1]),v=>v.charCodeAt(0));};});
  const ui=page.frameLocator('#plugin'),modal=ui.locator('#blurModal'),image=ui.locator('#blurImage');
  const open=async()=>{await ui.locator('#blurCheckOpen').click();await modal.waitFor();};
  const close=async()=>{await ui.locator('#blurClose').click();await frame.waitForFunction(()=>!document.getElementById('blurImage').hasAttribute('src'));};
  const count=()=>page.evaluate(()=>window.exports),sent=()=>page.evaluate(()=>scripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const layout=()=>frame.evaluate(()=>{const b=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:b('blurModal'),stage:b('blurStage'),image:b('blurImage'),controls:b('blurOriginal'),arrows:b('blurLeft')};});
  const metrics=async()=>frame.evaluate(async bytes=>{const b=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=b.width;c.height=b.height;const x=c.getContext('2d');x.drawImage(b,0,0);const d=x.getImageData(0,0,c.width,c.height).data;
    const at=(px,py)=>Array.from(d.slice((py*c.width+px)*4,(py*c.width+px)*4+4));const y=Math.floor(c.height/2);let low=-1,high=-1;
    for(let p=Math.floor(c.width*.32);p<c.width*.6;p++){const r=d[(y*c.width+p)*4];if(low<0&&r>=41)low=p;if(high<0&&r>=209)high=p;}
    return {edge:high-low,corner:at(2,2),center:at(Math.floor(c.width*.6),y)};
  },Array.from(await image.screenshot()));
  let light,medium,strong,base,scriptCount,url;
  await t.test('startup does no export or blur and only Focus remains disabled',async()=>{
    assert.equal(await count(),0);assert.equal(await image.getAttribute('src'),null);assert.equal(await modal.isVisible(),false);
    await ui.locator('#checkPreviewSection summary').click();assert.equal(await ui.locator('#blurCheckOpen').isEnabled(),true);
    assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);
  });
  await t.test('one click captures one PNG and starts LEKKI with local loading only',async()=>{
    await page.evaluate(()=>delay=250);await ui.locator('#blurCheckOpen').evaluate(b=>{b.click();b.click();});
    assert.equal(await ui.locator('#blurCheckOpen').isDisabled(),true);
    for(const id of ['thumbnailPreviewOpen','grayscaleCheckOpen','rasterizeScan','layerCleanerScan'])assert.equal(await ui.locator('#'+id).isEnabled(),true);
    await modal.waitFor();assert.equal(await count(),1);assert.equal(await ui.locator('#blurLevel').textContent(),'LEKKI');assert.equal(await ui.locator('#blurEnabled').getAttribute('aria-pressed'),'true');
    assert.equal(await ui.locator('#blurLeft').isDisabled(),true);base=await layout();scriptCount=await sent();url=await image.getAttribute('src');
  });
  await t.test('LEKKI actually softens edges without darkening the border',async()=>{
    light=await metrics();assert.ok(light.edge>=2,JSON.stringify(light));assert.ok(light.corner.slice(0,3).every((v,i)=>Math.abs(v-[20,30,50][i])<=3),JSON.stringify(light));assert.equal(light.corner[3],255);assert.ok(light.center[0]>200);
  });
  await t.test('ŚREDNI is visibly stronger than LEKKI',async()=>{
    await ui.locator('#blurRight').click();assert.equal(await ui.locator('#blurLevel').textContent(),'ŚREDNI');medium=await metrics();assert.ok(medium.edge>light.edge*1.5,JSON.stringify({light,medium}));
  });
  await t.test('MOCNY is stronger than ŚREDNI while retaining major shapes',async()=>{
    await ui.locator('#blurRight').click();assert.equal(await ui.locator('#blurLevel').textContent(),'MOCNY');strong=await metrics();assert.ok(strong.edge>medium.edge*1.5,JSON.stringify({medium,strong}));assert.ok(strong.center[0]-strong.corner[0]>150);assert.ok(strong.corner.slice(0,3).every((v,i)=>Math.abs(v-[20,30,50][i])<=3),JSON.stringify(strong));
  });
  await t.test('right edge does not wrap and UI exposes no numerical blur control',async()=>{
    assert.equal(await ui.locator('#blurRight').isDisabled(),true);await ui.locator('#blurRight').evaluate(b=>b.click());assert.equal(await ui.locator('#blurLevel').textContent(),'MOCNY');
    assert.equal(await modal.locator('input').count(),0);assert.equal(await modal.locator('img').count(),1);assert.doesNotMatch(await modal.innerText(),/\d+\s*px|DOBRZE|ŹLE|\d+\s*\/\s*10/);
  });
  for(const level of ['MOCNY','ŚREDNI'])await t.test('ORYGINAŁ restores sharp pixels and returning to BLUR remembers '+level,async()=>{
    if(level==='ŚREDNI')await ui.locator('#blurLeft').click();await ui.locator('#blurOriginal').click();assert.equal(await image.evaluate(e=>getComputedStyle(e).filter),'none');
    assert.ok((await metrics()).edge<=1);await ui.locator('#blurEnabled').click();assert.equal(await ui.locator('#blurLevel').textContent(),level);
    assert.equal((await metrics()).edge,level==='MOCNY'?strong.edge:medium.edge);
  });
  await t.test('arrows return to LEKKI and stop at the left edge',async()=>{
    await ui.locator('#blurLeft').click();assert.equal(await ui.locator('#blurLevel').textContent(),'LEKKI');assert.equal(await ui.locator('#blurLeft').isDisabled(),true);await ui.locator('#blurLeft').evaluate(b=>b.click());assert.equal(await ui.locator('#blurLevel').textContent(),'LEKKI');
  });
  await t.test('all states preserve image/modal positions and send no new document commands',async()=>{
    for(const action of ['blurRight','blurRight','blurOriginal','blurEnabled','blurLeft','blurLeft']){await ui.locator('#'+action).click();assert.deepEqual(await layout(),base);assert.equal(await sent(),scriptCount);assert.equal(await count(),1);}
  });
  await t.test('closing releases the snapshot and reopening gets a fresh image at LEKKI',async()=>{
    await close();await page.evaluate(()=>{version++;delay=10;});const before=await count();await open();assert.equal(await count(),before+1);assert.notEqual(await image.getAttribute('src'),url);
    assert.equal(await ui.locator('#blurLevel').textContent(),'LEKKI');assert.equal(await ui.locator('#blurEnabled').getAttribute('aria-pressed'),'true');await ui.locator('#blurOriginal').click();assert.deepEqual((await metrics()).corner,[187,68,85,255]);await close();
  });
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920],[1600,400]])await t.test('complete centered composition preserves '+w+'×'+h,async()=>{
    await page.evaluate(([w,h])=>{doc.width=w;doc.height=h;},[w,h]);await open();const p=await layout();assert.ok(Math.abs(p.image.width/p.image.height-w/h)<.01);
    assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);assert.ok(Math.abs(p.image.x+p.image.width/2-p.stage.x-p.stage.width/2)<1);assert.ok(Math.abs(p.image.y+p.image.height/2-p.stage.y-p.stage.height/2)<1);await close();
  });
  await t.test('AI session stays untouched and Escape closes the modal',async()=>{
    await frame.evaluate(async()=>{const s=ktxAiReviewSession,c=await s.capture({disableButtons:false});await s.acceptPreview(c);await s.setNotes('Moje uwagi');});
    const saved=()=>frame.evaluate(()=>JSON.stringify(ktxAiReviewSession.getState(),(k,v)=>v instanceof Blob?{size:v.size,type:v.type}:v));const before=await saved();await open();await ui.locator('#blurRight').click();await page.keyboard.press('Escape');await frame.waitForFunction(()=>!document.getElementById('blurImage').hasAttribute('src'));assert.equal(await saved(),before);
  });
  await t.test('missing document reports an error without opening or exporting',async()=>{
    await page.evaluate(()=>doc=null);const before=await count();await ui.locator('#blurCheckOpen').click();await ui.locator('#blurStatus').filter({hasText:'Brak otwartego dokumentu'}).waitFor();assert.equal(await modal.isVisible(),false);assert.equal(await count(),before);assert.equal(await ui.locator('#blurCheckOpen').isEnabled(),true);
  });
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
