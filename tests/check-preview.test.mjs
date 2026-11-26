import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const root=new URL('../',import.meta.url);
const harness=`<!doctype html><iframe id="plugin" src="/plugin.html" style="width:420px;height:800px"></iframe><script>
window.scripts=[];window.exports=0;window.version=0;window.delay=20;
const plugin=document.getElementById('plugin');
window.doc={name:'Fixture.psd',source:'local,0,Fixture.psd',width:1920,height:1080};
const app={get documents(){return doc?[doc]:[];},get activeDocument(){return doc;},echoToOE(value){plugin.contentWindow.postMessage(value,location.origin);}};
window.bytes=function(){const c=document.createElement('canvas');c.width=doc.width;c.height=doc.height;const x=c.getContext('2d');x.fillStyle=version?'#bb4455':'#335577';x.fillRect(0,0,c.width,c.height);return Uint8Array.from(atob(c.toDataURL().split(',')[1]),v=>v.charCodeAt(0));};
function save(format){if(format!=='png')throw Error('Unexpected export');exports++;const png=bytes();setTimeout(()=>{plugin.contentWindow.postMessage(png.buffer,location.origin);plugin.contentWindow.postMessage('done',location.origin);},delay);}
doc.saveToOE=save;
addEventListener('message',event=>{if(event.source!==plugin.contentWindow||typeof event.data!=='string')return;scripts.push(event.data);try{new Function('app',event.data)(app);}catch(error){console.error(error);}setTimeout(()=>plugin.contentWindow.postMessage('done',location.origin),0);});
</script>`;

test('CHECK & PREVIEW: shared PNG, navigation, read-only session isolation and responsive layout',{timeout:120000},async t=>{
  const server=http.createServer(async(req,res)=>{try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/')return res.end(harness);
    if(!/^\/[\w.-]+$/.test(path))throw Error('Invalid path');
    const body=await readFile(new URL(path.slice(1),root));
    res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'text/html');res.end(body);
  }catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});
    const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    const frame=page.frames().find(f=>f.url().endsWith('/plugin.html'));
    await frame.waitForLoadState('domcontentloaded');
    const ui=page.frameLocator('#plugin'),modal=ui.locator('#checkPreviewModal');
    const label=ui.locator('#checkPreviewSize'),left=ui.locator('#checkPreviewLeft'),right=ui.locator('#checkPreviewRight');
    const exports=()=>page.evaluate(()=>window.exports);
    const open=async()=>{await ui.locator('#thumbnailPreviewOpen').click();await modal.waitFor({state:'visible'});};
    const close=async()=>{await ui.locator('#checkPreviewClose').click();await modal.waitFor({state:'hidden'});await frame.waitForFunction(()=>!document.getElementById('checkPreviewImage').hasAttribute('src'));};
    const layout=()=>frame.evaluate(()=>{const rect=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};return {image:rect('checkPreviewImage'),stage:rect('checkPreviewStage'),modal:rect('checkPreviewModal'),navigation:rect('checkPreviewLeft')};});
    const stable=()=>frame.waitForFunction(()=>!document.getElementById('checkPreviewImage').getAnimations().some(a=>a.playState==='running'));
    await t.test('startup exports nothing and future checks are disabled',async()=>{
      assert.equal(await exports(),0);assert.equal(await ui.locator('#checkPreviewSection').getAttribute('open'),null);
      await ui.locator('#checkPreviewSection summary').click();
      assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),3);
      for(const name of ['Blur Check','Contrast Check','Focus Preview'])assert.ok(await ui.getByRole('button',{name:new RegExp(name)}).isDisabled());
      assert.equal(await exports(),0);
    });
    await t.test('one click captures one PNG, opens DUŻY and keeps other tools enabled during loading',async()=>{
      await page.evaluate(()=>delay=300);
      await ui.locator('#thumbnailPreviewOpen').evaluate(b=>{b.click();b.click();});
      assert.equal(await ui.locator('#thumbnailPreviewOpen').isDisabled(),true);
      assert.equal(await ui.locator('#rasterizeScan').isEnabled(),true);assert.equal(await ui.locator('#layerCleanerScan').isEnabled(),true);
      await modal.waitFor({state:'visible'});assert.equal(await exports(),1);assert.equal(await label.textContent(),'DUŻY');
      assert.equal(await left.isDisabled(),true);assert.equal(await right.isEnabled(),true);
    });
    let largest, snapshotScripts;
    await t.test('large preview is centered, complete and preserves 16:9',async()=>{
      largest=await layout();assert.ok(largest.image.width>300);
      snapshotScripts=await page.evaluate(()=>scripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
      assert.ok(Math.abs(largest.image.width/largest.image.height-16/9)<0.01);
      assert.ok(Math.abs(largest.image.x+largest.image.width/2-largest.stage.x-largest.stage.width/2)<1);
      assert.ok(Math.abs(largest.image.y+largest.image.height/2-largest.stage.y-largest.stage.height/2)<1);
    });
    for(const name of ['ŚREDNI','MAŁY','BARDZO MAŁY'])await t.test('right arrow selects '+name+' locally without moving the modal',async()=>{
      const before=await layout();await right.click();await stable();const after=await layout();
      assert.equal(await label.textContent(),name);assert.equal(await exports(),1);
      assert.equal(await page.evaluate(()=>scripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length),snapshotScripts);
      assert.ok(after.image.width<before.image.width*0.7);assert.deepEqual(after.modal,largest.modal);assert.deepEqual(after.navigation,largest.navigation);
      assert.ok(Math.abs(after.image.x+after.image.width/2-after.stage.x-after.stage.width/2)<1);
      assert.ok(Math.abs(after.image.y+after.image.height/2-after.stage.y-after.stage.height/2)<1);
    });
    await t.test('smallest stops at the right edge',async()=>{assert.equal(await right.isDisabled(),true);await right.evaluate(b=>b.click());assert.equal(await label.textContent(),'BARDZO MAŁY');});
    await t.test('left arrow reverses all levels without wrapping or exporting',async()=>{
      for(const name of ['MAŁY','ŚREDNI','DUŻY']){await left.click();await stable();assert.equal(await label.textContent(),name);}
      assert.equal(await left.isDisabled(),true);await left.evaluate(b=>b.click());assert.equal(await label.textContent(),'DUŻY');assert.equal(await exports(),1);
    });
    await t.test('short size transition is present and the UI contains no image dimensions',async()=>{
      const duration=await ui.locator('#checkPreviewImage').evaluate(e=>getComputedStyle(e).transitionDuration);assert.equal(duration,'0.18s, 0.18s');
      assert.doesNotMatch(await modal.innerText(),/\d+\s*[×x]\s*\d+/);assert.equal(await modal.locator('img').count(),1);
    });
    await t.test('layout adapts to a narrow panel without cropping or moving its center',async()=>{
      await page.locator('#plugin').evaluate(e=>{e.style.width='280px';e.style.height='500px';});
      await frame.waitForFunction(()=>document.getElementById('checkPreviewStage').clientWidth<250);await stable();
      const p=await layout();assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);
      assert.ok(Math.abs(p.image.width/p.image.height-16/9)<0.01);
      assert.ok(Math.abs(p.image.x+p.image.width/2-p.stage.x-p.stage.width/2)<1);
      await page.locator('#plugin').evaluate(e=>{e.style.width='420px';e.style.height='800px';});
      await frame.waitForFunction(()=>document.getElementById('checkPreviewStage').clientWidth>300);await stable();
    });
    await t.test('closing revokes the image and restores focus',async()=>{
      await close();assert.equal(await ui.locator('#checkPreviewImage').getAttribute('src'),null);assert.equal(await ui.locator('#thumbnailPreviewOpen').evaluate(e=>document.activeElement===e),true);
    });
    await t.test('reopening captures the new image and resets to DUŻY',async()=>{
      await page.evaluate(()=>{version++;delay=10;});await open();assert.equal(await exports(),2);assert.equal(await label.textContent(),'DUŻY');
      assert.deepEqual(await frame.evaluate(async()=>{const i=document.getElementById('checkPreviewImage'),c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');x.drawImage(i,0,0,1,1);return Array.from(x.getImageData(0,0,1,1).data);}),[187,68,85,255]);await close();
    });
    await t.test('Escape closes the modal and reduced-motion preference disables the transition',async()=>{
      await page.emulateMedia({reducedMotion:'reduce'});await open();
      assert.equal(await ui.locator('#checkPreviewImage').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
      await page.keyboard.press('Escape');await frame.waitForFunction(()=>!document.getElementById('checkPreviewImage').hasAttribute('src'));
      assert.equal(await modal.isVisible(),false);await page.emulateMedia({reducedMotion:'no-preference'});
    });
    for(const [width,height] of [[1080,1080],[1080,1920]])await t.test('aspect ratio '+width+'×'+height+' survives every level',async()=>{
      await page.evaluate(([w,h])=>{doc.width=w;doc.height=h;},[width,height]);await open();
      for(let i=0;i<4;i++){if(i){await right.click();await stable();}const p=await layout();assert.ok(Math.abs(p.image.width/p.image.height-width/height)<0.01);assert.ok(p.image.width<=p.stage.width&&p.image.height<=p.stage.height);}
      await close();
    });
    await t.test('shared snapshot leaves AI notes, result, statuses and previous images untouched',async()=>{
      await frame.evaluate(async()=>{const s=ktxAiReviewSession,c=await s.capture({disableButtons:false});await s.acceptPreview(c);
        const item=id=>({id,issueKey:id,category:'composition',priority:'medium',title:'Popraw układ',reason:'Popraw czytelność',instruction:['Oceń kompozycję.']});
        const r={score:7.5,summary:'Ocena testowa',strengths:['Czytelny temat'],improvements:[item('first'),item('second')]};
        await s.acceptReview(r,c,'Moje uwagi');await s.acceptReview(r,c,'Moje uwagi');await s.setImprovementStatus('first','done');await s.setImprovementStatus('second','discarded');
      });
      const saved=()=>frame.evaluate(()=>JSON.stringify(ktxAiReviewSession.getState(),(key,value)=>value instanceof Blob?{type:value.type,size:value.size}:value));
      const before=await saved();await open();await right.click();await close();assert.equal(await saved(),before);
    });
    await t.test('no document shows a message and never opens an empty modal',async()=>{
      await page.evaluate(()=>doc=null);const count=await exports();await ui.locator('#thumbnailPreviewOpen').click();
      await ui.locator('#checkPreviewStatus').filter({hasText:'Brak otwartego dokumentu'}).waitFor();assert.equal(await modal.isVisible(),false);assert.equal(await exports(),count);
      assert.equal(await ui.locator('#thumbnailPreviewOpen').isEnabled(),true);
    });
    assert.deepEqual(errors,[]);
    await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
