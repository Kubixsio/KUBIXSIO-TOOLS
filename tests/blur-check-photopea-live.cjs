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
  await page.addInitScript(()=>{if(location.hostname==='www.photopea.com'){window.blurScripts=[];addEventListener('message',e=>{if(e.origin==='https://kubixsio.github.io'&&typeof e.data==='string')blurScripts.push(e.data);});}});
  await page.route('**/*',route=>{const u=new URL(route.request().url());
    if(u.hostname.includes('openai')||u.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
    if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(u.hostname))return route.abort();
    if(u.hostname!=='kubixsio.github.io'||!u.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
    const name=path.basename(u.pathname);let body=fs.readFileSync(path.join(root,name));if(name==='plugin.html')body=body.toString().replace('</body>',bridge+'</body>');
    return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
  });
  await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify({files:[plugin.replace('plugin.html','watermark-full.png')],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}})));
  await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
  const ui=page.frameLocator('iframe[src="'+plugin+'"]');await ui.locator('#blurCheckOpen').waitFor({state:'attached'});
  const frame=page.frames().find(f=>f.url()===plugin);await frame.waitForLoadState('domcontentloaded');
  const exec=(s,f)=>frame.evaluate(([s,f])=>ktxRasterizeTest(s,f),[s,f]);
  const state=()=>exec(readState.replace('return out;','return {layers:out,active:+d.activeLayer.id,history:+d.historyStates.length};'));
  const exports=()=>page.evaluate(()=>blurScripts.filter(s=>s.includes('saveToOE("png")')).length);
  const sent=()=>page.evaluate(()=>blurScripts.filter(s=>!s.includes('KTX_RASTERIZE_POSITION|')).length);
  const open=async()=>{await ui.locator('#blurCheckOpen').click();await ui.locator('#blurModal').waitFor();};
  const close=async()=>{await ui.locator('#blurClose').click();await frame.waitForFunction(()=>!document.getElementById('blurImage').hasAttribute('src'));};
  const layout=()=>frame.evaluate(()=>{const b=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {modal:b('blurModal'),stage:b('blurStage'),image:b('blurImage'),controls:b('blurOriginal')};});
  const signature=()=>frame.evaluate(async()=>{const b=await(await fetch(document.getElementById('blurImage').src)).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).join(',');});
  const pixels=async()=>frame.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const x=c.getContext('2d');x.drawImage(bitmap,0,0);const d=x.getImageData(0,0,c.width,c.height).data,y=Math.floor(c.height/2);let low=-1,high=-1;
    for(let p=Math.floor(c.width*.32);p<c.width*.6;p++){const r=d[(y*c.width+p)*4];if(low<0&&r>=41)low=p;if(high<0&&r>=209)high=p;}
    return {edge:high-low,center:Array.from(x.getImageData(Math.floor(c.width*.6),y,1,1).data),background:Array.from(x.getImageData(Math.floor(c.width*.94),y,1,1).data)};
  },Array.from(await ui.locator('#blurImage').screenshot()));
  assert.equal(await exports(),0);await ui.locator('#checkPreviewSection summary').click();assert.equal(await ui.locator('#checkPreviewSection button:disabled').count(),1);
  await exec("var d=app.documents.add(1280,720,72,'Historia blur');var l=d.artLayers.add();l.name='Historia';return true;");
  const simpleBefore=await state();assert.ok(simpleBefore.history<20);await open();await ui.locator('#blurOriginal').click();await ui.locator('#blurEnabled').click();await close();assert.deepEqual(await state(),simpleBefore);report.historyProof={before:simpleBefore.history,after:simpleBefore.history};
  for(const [w,h]of [[1920,1080],[1080,1080],[1080,1920]]){
    const script=fixture.replace('app.documents.add(128,72','app.documents.add('+w+','+h).replace('return ids;',`
      d.activeLayer=d.layers[d.layers.length-1];var bg=d.artLayers.add();bg.name='Tło testowe';d.selection.select([[0,0],[${w},0],[${w},${h}],[0,${h}]]);var ink=new SolidColor();ink.rgb.hexValue='141E32';d.selection.fill(ink);d.selection.deselect();
      var hero=d.artLayers.add();hero.name='Kolorowy obiekt';d.selection.select([[${w*.4},${h*.15}],[${w*.8},${h*.15}],[${w*.8},${h*.8}],[${w*.4},${h*.8}]]);ink.rgb.hexValue='E6AA50';d.selection.fill(ink);d.selection.deselect();var detail=d.artLayers.add();detail.name='Drobne detale';for(var n=0;n<40;n++){var xx=${w}*(.05+n*.005);d.selection.select([[xx,${h*.15}],[xx+${w*.005},${h*.15}],[xx+${w*.005},${h*.85}],[xx,${h*.85}]]);ink.rgb.hexValue=n%2?'FAE6B4':'224488';d.selection.fill(ink);}d.selection.deselect();return ids;`);
    const ids=await exec(script);await exec('return true;','png');let beforePsd;
    for(let i=0;i<60;i++){beforePsd=Uint8Array.from(await exec('return true;','psd'));if(readLayers(beforePsd.buffer).get(ids.text).channels.some(c=>c.bytes.length>2))break;if(i===59)throw Error('Fixture font did not render');await page.waitForTimeout(250);}
    const before=await state(),records=readLayers(beforePsd.buffer),count=await exports();
    assert.ok(records.get(ids.decorated).mask.length);assert.ok(records.get(ids.decorated).tags.has('lfx2'));assert.ok(records.get(ids.keep).tags.has('SoLd'));
    await open();assert.equal(await exports(),count+1);assert.equal(await ui.locator('#blurEnabled').getAttribute('aria-pressed'),'true');
    const initial=await layout(),first=await signature(),url=await ui.locator('#blurImage').getAttribute('src'),messages=await sent();
    assert.ok(Math.abs(initial.image.width/initial.image.height-w/h)<0.01);assert.ok(initial.image.width<=initial.stage.width&&initial.image.height<=initial.stage.height);
    assert.ok(Math.abs(initial.image.x+initial.image.width/2-initial.stage.x-initial.stage.width/2)<1);assert.ok(Math.abs(initial.image.y+initial.image.height/2-initial.stage.y-initial.stage.height/2)<1);
    const levels=[];
    for(const [i,name]of ['LEKKI','ŚREDNI','MOCNY'].entries()){
      if(i)await ui.locator('#blurRight').click();assert.equal(await ui.locator('#blurLevel').textContent(),name);
      const p=await pixels();assert.ok(p.edge>=2,JSON.stringify(p));if(i)assert.ok(p.edge>levels[i-1].edge*1.4,JSON.stringify({levels,p}));
      assert.ok(p.center[0]-p.background[0]>150);assert.deepEqual(await layout(),initial);levels.push({name,edge:p.edge});
      if(w===1920)await page.screenshot({path:path.join(root,'test-results/052-blur-'+i+'.png')});
    }
    assert.equal(await ui.locator('#blurRight').isDisabled(),true);
    for(const [id,name]of [['blurLeft','ŚREDNI'],['blurLeft','LEKKI'],['blurRight','ŚREDNI'],['blurRight','MOCNY'],['blurOriginal','MOCNY'],['blurEnabled','MOCNY'],['blurLeft','ŚREDNI'],['blurOriginal','ŚREDNI'],['blurEnabled','ŚREDNI']]){
      await ui.locator('#'+id).click();assert.equal(await ui.locator('#blurLevel').textContent(),name);const p=await pixels();
      if(id==='blurOriginal'){assert.ok(p.edge<=1);assert.deepEqual(p.center,[230,170,80,255]);}else assert.equal(p.edge,levels.find(l=>l.name===name).edge);
      assert.deepEqual(await layout(),initial);assert.equal(await sent(),messages);assert.equal(await exports(),count+1);
    }
    await close();assert.deepEqual(await state(),before);
    const afterPsd=Uint8Array.from(await exec('return true;','psd'));assert.deepEqual(readLayers(afterPsd.buffer),records);
    const hash=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(hash(afterPsd),hash(beforePsd));
    await exec("var d=app.activeDocument,l=d.artLayers.add();l.name='Nowy kolor';d.selection.select([[0,0],[600,0],[600,600],[0,600]]);var ink=new SolidColor();ink.rgb.hexValue='CC3355';d.selection.fill(ink);d.selection.deselect();return true;");
    await open();assert.notEqual(await signature(),first);assert.equal(await ui.locator('#blurEnabled').getAttribute('aria-pressed'),'true');await close();
    report.cases.push({width:w,height:h,levels,originalMemory:true,stableModal:true,oneSnapshot:true,psdBytesIdentical:true,freshAfterEdit:true});
  }
  report.checks.push('Real screenshots prove three increasing blur widths and sharp ORIGINAL; returning to BLUR preserves the level. All controls are local and preserve layout.');
  report.checks.push('Landscape, square and portrait retain proportions; PSD bytes and history stay identical; reopening after edit is fresh.');
  assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);console.log(JSON.stringify(report,null,2));
 }finally{fs.writeFileSync(path.join(root,'test-results/052-blur-report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
