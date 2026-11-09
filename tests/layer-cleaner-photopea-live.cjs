// Optional test against the REAL Photopea interpreter and full plugin button workflow.
// Local plugin files are routed into an isolated browser context; nothing is deployed.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const fixtureScript = `
var d=app.documents.add(128,72,72,"KTX Layer Cleaner 020 test"), ids={};
function pixel(name,empty){var l=d.artLayers.add();l.name=name;if(!empty){d.activeLayer=l;d.selection.select([[0,0],[16,0],[16,16],[0,16]]);var color=new SolidColor();color.rgb.hexValue="559966";d.selection.fill(color);d.selection.deselect();}return l;}
var l=pixel("Ukryta pixel",false);l.visible=false;ids.hidden=l.id;
l=pixel("Ukryty Smart Object",false);executeAction(stringIDToTypeID("newPlacedLayer"),undefined,DialogModes.NO);l=d.activeLayer;l.visible=false;ids.smart=l.id;
l=d.artLayers.add();l.kind=LayerKind.TEXT;l.name="Ukryty tekst";l.textItem.contents="Tekst";l.visible=false;ids.text=l.id;
l=pixel("Widoczna opacity zero",false);l.opacity=0;ids.zero=l.id;
l=pixel("Pusta pixel",true);ids.empty=l.id;
l=pixel("Pusta ze stylem",true);ids.style=l.id;
var set=new ActionDescriptor(),ref=new ActionReference();ref.putEnumerated(charIDToTypeID("Lyr "),charIDToTypeID("Ordn"),charIDToTypeID("Trgt"));set.putReference(charIDToTypeID("null"),ref);
var layerDesc=new ActionDescriptor(),fx=new ActionDescriptor(),overlay=new ActionDescriptor();overlay.putBoolean(charIDToTypeID("enab"),true);overlay.putEnumerated(charIDToTypeID("Md  "),charIDToTypeID("BlnM"),charIDToTypeID("Nrml"));overlay.putUnitDouble(charIDToTypeID("Opct"),charIDToTypeID("#Prc"),100);var rgb=new ActionDescriptor();rgb.putDouble(charIDToTypeID("Rd  "),255);rgb.putDouble(charIDToTypeID("Grn "),100);rgb.putDouble(charIDToTypeID("Bl  "),0);overlay.putObject(charIDToTypeID("Clr "),charIDToTypeID("RGBC"),rgb);fx.putObject(charIDToTypeID("SoFi"),charIDToTypeID("SoFi"),overlay);layerDesc.putObject(charIDToTypeID("Lefx"),charIDToTypeID("Lefx"),fx);set.putObject(charIDToTypeID("T   "),charIDToTypeID("Lyr "),layerDesc);executeAction(charIDToTypeID("setd"),set,DialogModes.NO);
l=pixel("Pusta z maska",true);ids.mask=l.id;
var mask=new ActionDescriptor(),channel=new ActionReference();channel.putClass(charIDToTypeID("Chnl"));mask.putReference(charIDToTypeID("null"),channel);var at=new ActionReference();at.putEnumerated(charIDToTypeID("Chnl"),charIDToTypeID("Chnl"),charIDToTypeID("Msk "));mask.putReference(charIDToTypeID("At  "),at);mask.putEnumerated(charIDToTypeID("Usng"),charIDToTypeID("UsrM"),charIDToTypeID("RvlA"));executeAction(charIDToTypeID("Mk  "),mask,DialogModes.NO);
var g=d.layerSets.add();g.name="Ukryta grupa";g.visible=false;ids.hiddenGroup=g.id;
l=pixel("Wlasna widocznosc ON",false);l.move(g,ElementPlacement.INSIDE);l.visible=true;ids.inherited=l.id;
l=pixel("Wlasna widocznosc OFF",false);l.move(g,ElementPlacement.INSIDE);l.visible=false;ids.ownHidden=l.id;
app.activeDocument=d;d.activeLayer=d.layers[d.layers.length-1];
g=d.layerSets.add();g.name="Grupa zero";g.opacity=0;ids.zeroGroup=g.id;
d.activeLayer=d.layers[d.layers.length-1];g=d.layerSets.add();g.name="Pusta grupa";ids.emptyGroup=g.id;
d.activeLayer=d.layers[d.layers.length-1];l=pixel("Render duplikat",false);l.visible=false;ids.sameKeep=l.id;
d.activeLayer=d.layers[d.layers.length-1];l=pixel("Render duplikat",false);l.visible=false;ids.sameDelete=l.id;
return ids;
`;
const listScript = `function walk(layers,out){for(var i=0;i<layers.length;i++){var l=layers[i];out.push({id:Number(l.id),name:l.name,group:l.typename==="LayerSet",visible:l.visible,opacity:Number(l.opacity),kind:Number(l.kind)});if(l.typename==="LayerSet")walk(l.layers,out);}}var out=[];walk(app.activeDocument.layers,out);return out;`;
async function main() {
  const root=path.resolve(__dirname,'..'), dir=path.join(root,'test-results');fs.mkdirSync(dir,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
  const report={checks:[],errors:[],aiRequests:0};
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    page.on('pageerror',e=>report.errors.push(e.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname.includes('openai')||url.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
      if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname))return route.abort();
      if(url.hostname==='kubixsio.github.io'&&url.pathname.startsWith('/KUBIXSIO-TOOLS/')){
        const name=url.pathname.slice('/KUBIXSIO-TOOLS/'.length);assert.match(name,/^[\w.-]+$/);
        let body=fs.readFileSync(path.join(root,name));
        if(name==='plugin.html')body=body.toString().replace('</body>',`<script>
          window.cleanerTestExec=function(script){var id=crypto.randomUUID(),marker='CLEANER_TEST|'+id+'|';return new Promise((resolve,reject)=>{var result,timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Native Photopea script timeout'))},20000);function receive(e){if(e.source!==parent||e.origin!=='https://www.photopea.com')return;if(typeof e.data==='string'&&e.data.startsWith(marker))result=JSON.parse(e.data.slice(marker.length));else if(e.data==='done'&&result!==undefined){clearTimeout(timer);removeEventListener('message',receive);if(result&&result.error)reject(Error(result.error));else resolve(result)}}addEventListener('message',receive);parent.postMessage('try{var result=(function(){'+script+'})();app.echoToOE('+JSON.stringify(marker)+'+JSON.stringify(result));}catch(e){app.echoToOE('+JSON.stringify(marker)+'+JSON.stringify({error:String(e)}));}','https://www.photopea.com')})};
        </script></body>`);
        return route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
      }
      return route.continue();
    });
    const config={files:['https://kubixsio.github.io/KUBIXSIO-TOOLS/watermark-full.png'],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html'}]}};
    await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify(config)));
    await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
    const iframe='iframe[src="https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html"]',ui=page.frameLocator(iframe);
    await ui.locator('#layerCleanerScan').waitFor();
    const frame=page.frames().find(f=>f.url().endsWith('/plugin.html'));
    await frame.waitForFunction(()=>!document.getElementById('layerCleanerScan').disabled&&!window.ktxSaveToOEGate?.owner);
    const exec=script=>frame.evaluate(script=>window.cleanerTestExec(script),script);
    const ids=await exec(fixtureScript);report.ids=ids;
    const psd=await frame.evaluate(()=>new Promise(resolve=>{
      let bytes;function receive(e){if(e.source!==parent)return;if(e.data instanceof ArrayBuffer)bytes=Array.from(new Uint8Array(e.data));else if(e.data==='done'&&bytes){removeEventListener('message',receive);resolve(bytes);}}
      addEventListener('message',receive);parent.postMessage('app.activeDocument.saveToOE("psd");','https://www.photopea.com');
    }));
    fs.writeFileSync(path.join(dir,'020-live-fixture.psd'),Buffer.from(psd));
    const before=await exec(listScript);report.before=before;
    assert.ok(before.find(l=>l.id===ids.smart).kind!==0);
    const start=ui.locator('#layerCleanerScan'),status=ui.locator('#layerCleanerStatus');
    await start.click();await status.filter({hasText:'Znaleziono'}).waitFor({timeout:45000});
    const rows=ui.locator('#layerCleanerList input');
    const found=(await rows.evaluateAll(nodes=>nodes.map(n=>Number(n.value)))).sort((a,b)=>a-b);
    report.found=found;
    report.snapshot=await frame.evaluate(()=>window.ktxLayerCleaner.scan());
    const expected=[ids.hidden,ids.smart,ids.text,ids.zero,ids.empty,ids.ownHidden,ids.sameKeep,ids.sameDelete].map(Number).sort((a,b)=>a-b);
    assert.deepEqual(found,expected);
    report.checks.push('hidden pixels / Smart Object / text, zero opacity and truly empty pixel detected; styles, mask, groups and inherited hiding protected');
    assert.deepEqual(await exec(listScript),before);report.checks.push('scan does not delete');
    await ui.locator('#layerCleaner').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(dir,'020-real-photopea-scan.png')});
    await ui.locator('#layerCleanerCancel').click();assert.deepEqual(await exec(listScript),before);report.checks.push('cancel does not delete');
    await start.click();await status.filter({hasText:'Znaleziono'}).waitFor();
    await ui.locator('#layerCleanerList input[value="'+ids.sameKeep+'"]').uncheck();
    assert.equal(await ui.locator('#layerCleanerDelete').innerText(),'USUŃ 7 WARSTW');
    await ui.locator('#layerCleanerDelete').click();
    await status.filter({hasText:'Usunięto 7 warstw'}).waitFor({timeout:45000});
    const after=await exec(listScript);report.after=after;
    const removed=expected.filter(id=>id!==ids.sameKeep);
    assert.deepEqual(after.map(l=>l.id).sort((a,b)=>a-b),before.filter(l=>!removed.includes(l.id)).map(l=>l.id).sort((a,b)=>a-b));
    assert.ok(after.some(l=>l.id===ids.sameKeep));assert.ok(!after.some(l=>l.id===ids.sameDelete));
    report.checks.push('7 selected IDs removed, unchecked same-name ID and every group preserved; native readback verified');
    await start.click();await status.filter({hasText:'Znaleziono'}).waitFor();
    await exec('function find(layers){for(var i=0;i<layers.length;i++){if(layers[i].id==='+ids.sameKeep+'){layers[i].visible=true;}if(layers[i].typename==="LayerSet")find(layers[i].layers);}}find(app.activeDocument.layers);return true;');
    await ui.locator('#layerCleanerDelete').click();await status.filter({hasText:'Dokument zmienił się'}).waitFor({timeout:45000});
    assert.ok((await exec(listScript)).some(l=>l.id===ids.sameKeep));report.checks.push('changed document rejects deletion');
    await ui.locator('#layerCleaner').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(dir,'020-real-photopea-result.png')});
    assert.equal(report.aiRequests,0);assert.deepEqual(report.errors,[]);
    console.log(JSON.stringify(report,null,2));
  } finally {fs.writeFileSync(path.join(dir,'020-integration-report.json'),JSON.stringify(report,null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
