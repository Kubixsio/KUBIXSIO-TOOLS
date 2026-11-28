// Real Photopea, local plugin files, disposable PSDs and blocked OpenAI endpoints.
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),{readLayers}=require('../rasterize-psd.js');
const root=path.resolve(__dirname,'..'),plugin='https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
const source=fs.readFileSync(path.join(root,'tests/rasterize-photopea-live.cjs'),'utf8');
const extract=name=>vm.runInNewContext(source.match(new RegExp('const '+name+' = (`[\\s\\S]*?`);'))[1]);
const bridge=extract('testBridge'),fixture=extract('createFixture'),readState=extract('readState');
const report={checks:[],cases:[],errors:[],aiRequests:0};
async function main(){
 const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>report.errors.push(e.message));
  await page.addInitScript(()=>{if(location.hostname==='www.photopea.com'){window.grayScripts=[];addEventListener('message',e=>{if(e.origin==='https://kubixsio.github.io'&&typeof e.data==='string')grayScripts.push(e.data);});}});
  await page.route('**/*',route=>{const u=new URL(route.request().url());
    if(u.hostname.includes('openai')||u.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
    if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(u.hostname))return route.abort();
    if(u.hostname!=='kubixsio.github.io'||!u.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
    const name=path.basename(u.pathname);let body=fs.readFileSync(path.join(root,name));if(name==='plugin.html')body=body.toString().replace('</body>',bridge+'</body>');
    return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
  });
  await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify({files:[plugin.replace('plugin.html','watermark-full.png')],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}})));
  await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
  const ui=page.frameLocator('iframe[src="'+plugin+'"]');await ui.locator('#grayscaleCheckOpen').waitFor({state:'attached'});
  const frame=page.frames().find(f=>f.url()===plugin);await frame.waitForLoadState('domcontentloaded');
  const exec=(s,f)=>frame.evaluate(([s,f])=>ktxRasterizeTest(s,f),[s,f]);
  const state=()=>exec(readState.replace('return out;','return {layers:out,active:+d.activeLayer.id,history:+d.historyStates.length};'));
  const exports=()=>page.evaluate(()=>grayScripts.filter(s=>s.includes('saveToOE("png")')).length);
  const sent=()=>page.evaluate(()=>grayScripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const open=async()=>{await ui.locator('#grayscaleCheckOpen').click();await ui.locator('#grayscaleModal').waitFor();};
  const close=async()=>{await ui.locator('#grayscaleClose').click();await frame.waitForFunction(()=>!document.getElementById('grayscaleImage').hasAttribute('src'));};
  const layout=()=>frame.evaluate(()=>{const b=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:b('grayscaleModal'),stage:b('grayscaleStage'),image:b('grayscaleImage'),controls:b('grayscaleOriginal')};});
  const signature=()=>frame.evaluate(async()=>{const b=await(await fetch(document.getElementById('grayscaleImage').src)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).join(',');});
  const pixels=async()=>frame.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let colored=0,total=0;for(let y=2;y<c.height-2;y++)for(let x=2;x<c.width-2;x++){const i=(y*c.width+x)*4;total++;if(Math.max(d[i],d[i+1],d[i+2])-Math.min(d[i],d[i+1],d[i+2])>1)colored++;}return {colored,total,center:Array.from(x.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data)};},Array.from(await ui.locator('#grayscaleImage').screenshot()));
  assert.equal(await exports(),0);await ui.locator('#checkPreviewSection summary').click();assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);
  await exec("var d=app.documents.add(1280,720,72,'Historia grayscale');var l=d.artLayers.add();l.name='Historia';return true;");
  const simpleBefore=await state();assert.ok(simpleBefore.history<20);await open();await ui.locator('#grayscaleOriginal').click();await ui.locator('#grayscaleGray').click();await close();assert.deepEqual(await state(),simpleBefore);report.historyProof={before:simpleBefore.history,after:simpleBefore.history};
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920]]){
    const script=fixture.replace('app.documents.add(128,72','app.documents.add('+w+','+h).replace('return ids;',`
      d.activeLayer=d.layers[d.layers.length-1];var bg=d.artLayers.add();bg.name='Tło testowe';d.selection.select([[0,0],[${w},0],[${w},${h}],[0,${h}]]);var ink=new SolidColor();ink.rgb.hexValue='172030';d.selection.fill(ink);d.selection.deselect();
      var hero=d.artLayers.add();hero.name='Kolorowy obiekt';d.selection.select([[${w*.3},${h*.15}],[${w*.7},${h*.15}],[${w*.7},${h*.8}],[${w*.3},${h*.8}]]);ink.rgb.hexValue='D19C53';d.selection.fill(ink);d.selection.deselect();return ids;`);
    const ids=await exec(script);await exec('return true;','png');let beforePsd;
    for(let i=0;i<60;i++){beforePsd=Uint8Array.from(await exec('return true;','psd'));if(readLayers(beforePsd.buffer).get(ids.text).channels.some(c=>c.bytes.length>2))break;if(i===59)throw Error('Fixture font did not render');await page.waitForTimeout(250);}
    const before=await state(),records=readLayers(beforePsd.buffer),count=await exports();
    assert.ok(records.get(ids.decorated).mask.length);assert.ok(records.get(ids.decorated).tags.has('lfx2'));assert.ok(records.get(ids.keep).tags.has('SoLd'));
    await open();assert.equal(await exports(),count+1);assert.equal(await ui.locator('#grayscaleGray').getAttribute('aria-pressed'),'true');
    const initial=await layout(),first=await signature(),url=await ui.locator('#grayscaleImage').getAttribute('src'),messages=await sent();
    assert.ok(Math.abs(initial.image.width/initial.image.height-w/h)<0.01);assert.ok(initial.image.width<=initial.stage.width&&initial.image.height<=initial.stage.height);
    assert.ok(Math.abs(initial.image.x+initial.image.width/2-initial.stage.x-initial.stage.width/2)<1);assert.ok(Math.abs(initial.image.y+initial.image.height/2-initial.stage.y-initial.stage.height/2)<1);
    const grayPixels=await pixels();assert.equal(grayPixels.colored,0);assert.ok(Math.abs(grayPixels.center[0]-(209*.2126+156*.7152+83*.0722))<=1);
    if(w===1920)await page.screenshot({path:path.join(root,'test-results/051-grayscale.png')});
    for(const id of ['grayscaleOriginal','grayscaleGray','grayscaleOriginal','grayscaleGray']){
      await ui.locator('#'+id).click();const p=await pixels();assert.equal(await ui.locator('#'+id).getAttribute('aria-pressed'),'true');
      if(id==='grayscaleOriginal'){assert.ok(p.colored>p.total*.5);assert.deepEqual(p.center,[209,156,83,255]);}else assert.equal(p.colored,0);
      assert.deepEqual(await layout(),initial);assert.equal(await ui.locator('#grayscaleImage').getAttribute('src'),url);assert.equal(await sent(),messages);assert.equal(await exports(),count+1);
    }
    if(w===1920){await ui.locator('#grayscaleOriginal').click();await page.screenshot({path:path.join(root,'test-results/051-original.png')});}
    await close();assert.deepEqual(await state(),before);
    const afterPsd=Uint8Array.from(await exec('return true;','psd'));assert.deepEqual(readLayers(afterPsd.buffer),records);
    const hash=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(hash(afterPsd),hash(beforePsd));
    await exec("var d=app.activeDocument,l=d.artLayers.add();l.name='Nowy kolor';d.selection.select([[0,0],[600,0],[600,600],[0,600]]);var ink=new SolidColor();ink.rgb.hexValue='CC3355';d.selection.fill(ink);d.selection.deselect();return true;");
    await open();assert.notEqual(await signature(),first);assert.equal(await ui.locator('#grayscaleGray').getAttribute('aria-pressed'),'true');await close();
    report.cases.push({width:w,height:h,grayscalePixels:grayPixels.center,neutralPixels:true,stableModal:true,oneSnapshot:true,psdBytesIdentical:true,freshAfterEdit:true});
  }
  report.checks.push('Real composited screenshots are neutral grayscale; original returns exact source colors. All toggles are local and preserve layout.');
  report.checks.push('Landscape, square and portrait retain proportions; PSD bytes and history stay identical; reopening after edit is fresh.');
  assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);console.log(JSON.stringify(report,null,2));
 }finally{fs.writeFileSync(path.join(root,'test-results/051-grayscale-report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
