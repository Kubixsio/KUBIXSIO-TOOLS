// Isolated real Photopea with local release files. No deployment and no AI requests.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..'), plugin = 'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
const api = require('../composition-lines.js');
const source = fs.readFileSync(path.join(root,'tests/rasterize-photopea-live.cjs'),'utf8');
const bridge = vm.runInNewContext(source.match(/const testBridge = (`[\s\S]*?`);/)[1]);
const report = {checks:[],cases:[],errors:[],aiRequests:0};
const readState = `
  function px(v){if(v&&typeof v==='object')v=v.as('px');return +v;}
  function walk(layers,parent,out){for(var i=0;i<layers.length;i++){var l=layers[i],b=l.bounds;
    out.push({id:Number(l.id),parent:parent,name:String(l.name),type:String(l.typename),kind:Number(l.kind),
      visible:l.visible,locked:l.allLocked,opacity:Number(l.opacity),blend:String(l.blendMode),
      bounds:[px(b[0]),px(b[1]),px(b[2]),px(b[3])]});
    if(l.typename==='LayerSet')walk(l.layers,Number(l.id),out);}}
  var out=[];walk(app.activeDocument.layers,null,out);return {layers:out,active:Number(app.activeDocument.activeLayer.id),documents:app.documents.length};`;

async function main() {
  const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    page.on('pageerror',error=>report.errors.push(error.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname.includes('openai')||url.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
      if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname))return route.abort();
      if(url.hostname!=='kubixsio.github.io'||!url.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
      const name=path.basename(url.pathname);
      let body=fs.readFileSync(path.join(root,name));
      if(name==='plugin.html')body=body.toString().replace('</body>',bridge+'</body>');
      return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
    });
    const config={files:[plugin.replace('plugin.html','watermark-full.png')],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}};
    await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify(config)));
    await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
    const ui=page.frameLocator('iframe[src="'+plugin+'"]');
    await ui.locator('#compositionLinesAdd').waitFor();
    const frame=page.frames().find(f=>f.url()===plugin);
    await frame.waitForFunction(()=>window.ktxCompositionLines&&window.ktxRasterizeTest);
    const exec=(script,format)=>frame.evaluate(([script,format])=>window.ktxRasterizeTest(script,format),[script,format]);
    await frame.evaluate(()=>{
      window.lastLinesReply=null;
      addEventListener('message',event=>{if(event.source===parent&&event.origin==='https://www.photopea.com'&&typeof event.data==='string'&&event.data.startsWith('KTX_COMPOSITION_LINES|')){
        lastLinesReply=JSON.parse(event.data.slice(event.data.indexOf('|',event.data.indexOf('|')+1)+1));
      }});
    });
    async function add(mode) {
      await ui.locator(mode==='cross'?'#compositionLinesCross':'#compositionLinesGrid').click();
      await frame.evaluate(()=>{window.lastLinesReply=null;});
      await ui.locator('#compositionLinesAdd').click();
      await frame.waitForFunction(()=>window.lastLinesReply!==null,{},{timeout:25000});
      const reply=await frame.evaluate(()=>lastLinesReply);
      assert.equal(reply.error,undefined,JSON.stringify(reply));
      await ui.locator('#compositionLinesStatus').getByText(mode==='cross'?'Dodano KRZYŻ.':'Dodano SIATKĘ.',{exact:true}).waitFor();
      return reply;
    }
    async function create(width,height) {
      return exec(`var d=app.documents.add(${width},${height},72,'LINES_040');
        var g=d.layerSets.add();g.name='Grupa';var inner=d.layerSets.add();inner.name='Podgrupa';inner.move(g,ElementPlacement.INSIDE);
        var l=d.artLayers.add();l.name='UŻYTKOWNIK — LINIE';d.activeLayer=l;
        d.selection.select([[10,10],[40,10],[40,40],[10,40]]);var ink=new SolidColor();ink.rgb.hexValue='559966';d.selection.fill(ink);d.selection.deselect();
        l.move(inner,ElementPlacement.INSIDE);d.activeLayer=l;
        return {source:String(d.source),name:String(d.name),active:Number(l.id)};`);
    }
    async function inspectPixels(width,height,mode) {
      const hidden=await exec(`var d=app.activeDocument, ids=[];for(var i=0;i<d.layers.length;i++){var l=d.layers[i];if(l.name!==${JSON.stringify(api.style.names[mode])}&&l.visible){ids.push(Number(l.id));l.visible=false;}}return ids;`);
      const bytes=await exec('return true;','png');
      const pixels=await frame.evaluate(async bytes=>{
        const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const data=context.getImageData(0,0,canvas.width,canvas.height).data;
        function runs(length,index){const result=[];let start=null;for(let i=0;i<=length;i++){
          const on=i<length&&data[index(i)+3]>0;
          if(on&&start===null)start=i;
          if(!on&&start!==null){result.push([start,i]);start=null;}
        }return result;}
        let count=0, sample=null;
        for(let i=0;i<data.length;i+=4)if(data[i+3]){count++;if(!sample)sample=Array.from(data.slice(i,i+4));}
        return {width:canvas.width,height:canvas.height,vertical:runs(canvas.width,x=>(3*canvas.width+x)*4),
          horizontal:runs(canvas.height,y=>(y*canvas.width+3)*4),count,sample};
      },bytes);
      const rectangles=api.geometry(width,height,mode), split=mode==='cross'?1:2;
      assert.equal(pixels.width,width);assert.equal(pixels.height,height);
      assert.deepEqual(pixels.vertical,rectangles.slice(0,split).map(b=>[b[0],b[2]]));
      assert.deepEqual(pixels.horizontal,rectangles.slice(split).map(b=>[b[1],b[3]]));
      assert.equal(pixels.count,2*height*split+2*width*split-4*split*split);
      assert.equal(pixels.sample[3],89);
      assert.ok(pixels.sample.slice(0,3).every((value,i)=>Math.abs(value-[125,223,255][i])<=1));
      await exec('var ids='+JSON.stringify(hidden)+';for(var i=0;i<app.activeDocument.layers.length;i++){var l=app.activeDocument.layers[i];if(ids.indexOf(Number(l.id))!==-1)l.visible=true;}return true;');
      return pixels;
    }
    const dimensions=process.env.KTX_LINES_SMOKE?[[1280,720]]:[[1280,720],[1920,1080],[1080,1080],[1080,1920],[1001,703],[3840,2160]];
    for(const [width,height] of dimensions) {
      const document=await create(width,height), before=await exec(readState);
      for(const mode of ['cross','cross','grid','cross','grid','grid']) {
        const reply=await add(mode), actual=await exec(readState);
        report.lastState={before,actual,reply};
        const helpers=actual.layers.filter(l=>l.type==='ArtLayer'&&l.kind===0&&Object.values(api.style.names).includes(l.name));
        assert.equal(helpers.length,1);const layer=helpers[0];
        assert.equal(actual.layers[0].id,layer.id);assert.equal(layer.parent,null);assert.equal(layer.name,api.style.names[mode]);
        assert.equal(layer.locked,true);assert.ok(Math.abs(layer.opacity-35)<=100/255);assert.equal(layer.blend,'norm');
        assert.equal(actual.documents,before.documents);assert.equal(actual.active,before.active);
        assert.deepEqual(actual.layers.filter(l=>l.id!==layer.id),before.layers);
        const pixels=await inspectPixels(width,height,mode);
        report.cases.push({width,height,mode,id:layer.id,opacity:layer.opacity,lines:reply.lines,vertical:pixels.vertical,horizontal:pixels.horizontal});
      }
      if(width===1280){
        await ui.locator('#compositionLines').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(root,'test-results/040-lines-grid.png')});
        await exec('app.activeDocument.activeLayer=app.activeDocument.layers[0];return true;');
        const lockedBefore=await exec(readState), helperId=lockedBefore.layers[0].id;
        await page.locator('div[draggable="true"][title="LINES_040.psd"]').click();
        await page.keyboard.press('v');await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        const lockedAfter=await exec(readState);
        assert.deepEqual(lockedAfter.layers.find(l=>l.id===helperId).bounds,lockedBefore.layers[0].bounds);
        await exec('var d=app.activeDocument;d.activeLayer=d.layers[1].layers[0].layers[0];return true;');
        const movingBefore=await exec(readState);
        await page.locator('div[draggable="true"][title="LINES_040.psd"]').click();
        await page.keyboard.press('v');await page.keyboard.press('ArrowRight');
        const movingAfter=await exec(readState);
        const pixelBefore=movingBefore.layers.find(l=>l.id===document.active);
        const pixelAfter=movingAfter.layers.find(l=>l.id===document.active);
        assert.deepEqual(pixelAfter.bounds,[pixelBefore.bounds[0]+1,pixelBefore.bounds[1],pixelBefore.bounds[2]+1,pixelBefore.bounds[3]]);
        assert.deepEqual(movingAfter.layers.find(l=>l.id===helperId).bounds,lockedBefore.layers[0].bounds);
        report.checks.push('Real Move-tool keyboard actions leave the locked helper fixed, while the original pixel layer moves by one pixel.');
        await ui.locator('#aiReviewCapture').click();
        await frame.waitForFunction(()=>{const image=document.getElementById('aiReviewPreviewImage');return !image.hidden&&image.naturalWidth===1280&&image.naturalHeight===720;});
        await ui.locator('#aiReviewNotes').fill('Regresja 0.4.0 — bez analizy AI.');
        await ui.locator('#aiReviewCapture').click();
        await frame.waitForFunction(()=>!document.getElementById('aiReviewCapture').disabled);
        assert.equal(await ui.locator('#aiReviewNotes').inputValue(),'Regresja 0.4.0 — bez analizy AI.');
        report.checks.push('Ocena AI captures the real 1280×720 PNG and preserves notes after refresh, without any AI request.');
      }
    }
    report.checks.push('Actual exported PNGs contain exactly 2px cyan lines at the center or nearest pixel to thirds, with uniform 35% layer opacity.');
    report.checks.push('Every replacement leaves one locked top-level pixel layer; original nested layers, active layer and document count are preserved.');
    assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);
    console.log(JSON.stringify(report,null,2));
  } finally {
    fs.writeFileSync(path.join(root,'test-results/040-lines-report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
