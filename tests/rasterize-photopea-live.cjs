// Runs the local build inside an isolated real Photopea session.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {readLayers} = require('../rasterize-psd.js');
const {attachmentsPreserved} = require('../rasterize.js');

const createFixture = `
var d = app.documents.add(128,72,72,"KTX Rasteryzuj 030 test"), ids = {};
function pixel(name, x, y, color) {
  var layer = d.artLayers.add(); layer.name = name; d.activeLayer = layer;
  d.selection.select([[x,y],[x+22,y],[x+22,y+20],[x,y+20]]);
  var ink = new SolidColor(); ink.rgb.hexValue = color;
  d.selection.fill(ink); d.selection.deselect();
  return layer;
}
function smart(name,x,y,color) {
  pixel(name,x,y,color);
  executeAction(stringIDToTypeID("newPlacedLayer"),undefined,DialogModes.NO);
  return d.activeLayer;
}
function makeStyle() {
  var action = new ActionDescriptor(), target = new ActionReference();
  target.putEnumerated(charIDToTypeID("Lyr "),charIDToTypeID("Ordn"),charIDToTypeID("Trgt"));
  action.putReference(charIDToTypeID("null"),target);
  var layer = new ActionDescriptor(), effects = new ActionDescriptor(), overlay = new ActionDescriptor();
  overlay.putBoolean(charIDToTypeID("enab"),true);
  overlay.putEnumerated(charIDToTypeID("Md  "),charIDToTypeID("BlnM"),charIDToTypeID("Nrml"));
  overlay.putUnitDouble(charIDToTypeID("Opct"),charIDToTypeID("#Prc"),65);
  var color = new ActionDescriptor();
  color.putDouble(charIDToTypeID("Rd  "),255);
  color.putDouble(charIDToTypeID("Grn "),100);
  color.putDouble(charIDToTypeID("Bl  "),0);
  overlay.putObject(charIDToTypeID("Clr "),charIDToTypeID("RGBC"),color);
  effects.putObject(charIDToTypeID("SoFi"),charIDToTypeID("SoFi"),overlay);
  layer.putObject(charIDToTypeID("Lefx"),charIDToTypeID("Lefx"),effects);
  action.putObject(charIDToTypeID("T   "),charIDToTypeID("Lyr "),layer);
  executeAction(charIDToTypeID("setd"),action,DialogModes.NO);
}
function makeMask() {
  var action = new ActionDescriptor(), channel = new ActionReference(), at = new ActionReference();
  channel.putClass(charIDToTypeID("Chnl"));
  action.putReference(charIDToTypeID("null"),channel);
  at.putEnumerated(charIDToTypeID("Chnl"),charIDToTypeID("Chnl"),charIDToTypeID("Msk "));
  action.putReference(charIDToTypeID("At  "),at);
  action.putEnumerated(charIDToTypeID("Usng"),charIDToTypeID("UsrM"),charIDToTypeID("RvlS"));
  executeAction(charIDToTypeID("Mk  "),action,DialogModes.NO);
}
var l = smart("Render",4,8,"335599"); ids.keep = l.id;
l = l.duplicate(); d.activeLayer = l; l.name = "Render"; l.visible = false; ids.hidden = l.id;
l = smart("Z filtrem",48,6,"55aa44"); ids.filtered = l.id; l.applyGaussianBlur(2);
l = smart("Styl + maska + baza",16,34,"a05599"); ids.decorated = l.id;
l.blendMode = BlendMode.OVERLAY; l.opacity = 72;
makeStyle();
d.selection.select([[0,0],[32,0],[32,72],[0,72]]); makeMask(); d.selection.deselect();
l = smart("Przypięty Smart Object",28,30,"33eeff"); ids.clipped = l.id;
var clip = new ActionDescriptor(), clipTarget = new ActionReference();
clipTarget.putEnumerated(charIDToTypeID("Lyr "),charIDToTypeID("Ordn"),charIDToTypeID("Trgt"));
clip.putReference(charIDToTypeID("null"),clipTarget);
executeAction(stringIDToTypeID("groupEvent"),clip,DialogModes.NO);
l = smart("W grupie",76,28,"9955bb"); ids.nested = l.id;
var outer = d.layerSets.add(); outer.name = "Grupa"; ids.outer = outer.id;
var inner = d.layerSets.add(); inner.name = "Podgrupa"; inner.move(outer,ElementPlacement.INSIDE); ids.inner = inner.id;
l.move(inner,ElementPlacement.INSIDE);
d.activeLayer = outer;
l = d.artLayers.add(); l.kind = LayerKind.TEXT; l.textItem.contents = "KTX"; l.name = "Tekst"; ids.text = l.id;
l = pixel("Piksele",102,7,"eeaa77"); ids.pixel = l.id;
return ids;
`;
const readState = `
function walk(layers,parent,out) {
  for(var i=0;i<layers.length;i++){
    var l=layers[i],g=l.typename==="LayerSet";
    out.push({id:Number(l.id),parent:parent,name:l.name,kind:Number(l.kind),visible:l.visible,
      opacity:Number(l.opacity),blend:String(l.blendMode),group:g});
    if(g)walk(l.layers,Number(l.id),out);
  }
}
var d=app.activeDocument, out=[];walk(d.layers,null,out);return out;
`;
const testBridge = `
<script>
window.ktxRasterizeTest = function (script, format) {
  return new Promise((resolve,reject)=>{
    const marker='RASTERIZE_TEST|'+crypto.randomUUID()+'|';
    let result, buffer;
    const timeout=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Photopea test bridge timeout'));},20000);
    function receive(event) {
      if(event.source!==parent||event.origin!=='https://www.photopea.com')return;
      if(typeof event.data==='string'&&event.data.startsWith(marker))result=JSON.parse(event.data.slice(marker.length));
      else if(format&&event.data instanceof ArrayBuffer)buffer=event.data;
      else if(event.data==='done'&&result!==undefined){
        clearTimeout(timeout);removeEventListener('message',receive);
        if(result?.error)reject(Error(result.error));
        else resolve(format?Array.from(new Uint8Array(buffer)):result);
      }
    }
    addEventListener('message',receive);
    const quote=JSON.stringify(marker);
    parent.postMessage('try{var result=(function(){'+script+'})();app.echoToOE('+quote+'+JSON.stringify(result));'+
      (format?'app.activeDocument.saveToOE('+JSON.stringify(format)+');':'')+
      '}catch(e){app.echoToOE('+quote+'+JSON.stringify({error:String(e)}));}','https://www.photopea.com');
  });
};
</script>
`;
const production = 'https://www.photopea.com';
const pluginUrl = 'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';

async function main() {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
  fs.mkdirSync(output, {recursive:true});
  const report = {checks: [], errors: [], aiRequests: 0};
  const externalFile = process.argv[2];
  const externalUrl = pluginUrl.replace('plugin.html','fixture-linked.psd');
  const browser = await chromium.launch({headless:true, executablePath:process.env.KTX_TEST_BROWSER});
  let status;
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname.includes('openai') || url.hostname.endsWith('workers.dev')) {
        report.aiRequests++;
        return route.abort();
      }
      if (/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname)) return route.abort();
      if (url.hostname !== 'kubixsio.github.io' || !url.pathname.startsWith('/KUBIXSIO-TOOLS/')) return route.continue();
      const name = path.basename(url.pathname);
      if (externalFile && url.href === externalUrl) {
        return route.fulfill({body:fs.readFileSync(externalFile),contentType:'application/octet-stream'});
      }
      let body = fs.readFileSync(path.join(root,name));
      if (name==='plugin.html') body = body.toString().replace('</body>',testBridge+'</body>');
      const contentType = name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html';
      return route.fulfill({body,contentType});
    });
    const config = {files:[externalFile ? externalUrl : pluginUrl.replace('plugin.html','watermark-full.png')],
      environment:{plugins:[{name:'KUBIXSIO TOOLS',url:pluginUrl}]}};
    await page.goto(production + '/#' + encodeURIComponent(JSON.stringify(config)));
    await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
    const ui = page.frameLocator('iframe[src="'+pluginUrl+'"]');
    const open = ui.locator('#rasterizeScan');
    status = ui.locator('#rasterizeStatus');
    const apply = ui.locator('#rasterizeApply'), cancel = ui.locator('#rasterizeCancel');
    const checks = ui.locator('#rasterizeList input');
    await open.waitFor();
    const frame = page.frames().find(f=>f.url()===pluginUrl);
    await frame.waitForFunction(()=>!document.getElementById('rasterizeScan').disabled&&!window.ktxSaveToOEGate?.owner);
    const atTop = () => frame.evaluate(() => document.querySelector('.wrap > .section').contains(document.getElementById('rasterize')));
    assert.equal(await atTop(), true);
    const exec = (script, format) => frame.evaluate(([script,format])=>window.ktxRasterizeTest(script,format),[script,format]);
    const exportDocument = async format => Uint8Array.from(await exec('return true;',format));
    const docs = 'var out=[];for(var i=0;i<app.documents.length;i++){var d=app.documents[i];out.push({source:String(d.source),name:String(d.name)});}return out;';
    if (externalFile) report.externalInput = {documents:await exec(docs), layers:await exec(readState)};
    async function pixels(bytes) {
      return frame.evaluate(async bytes=>{
        const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        return Array.from(context.getImageData(0,0,canvas.width,canvas.height).data);
      },Array.from(bytes));
    }

    const ids = await exec(createFixture);
    report.ids = ids;
    const before = await exec(readState);
    report.before = before;
    const beforeRecords = readLayers((await exportDocument('psd')).buffer);
    report.beforeProof = [...beforeRecords].map(([id,r])=>[id,r.filterFree,r.clipping,r.mask.length,[...r.tags.keys()]]);
    assert.ok(beforeRecords.get(ids.decorated).mask.length > 0);
    assert.ok(beforeRecords.get(ids.decorated).tags.has('lfx2'));
    const commonSource = beforeRecords.get(ids.keep).sourceId;
    assert.ok(commonSource);
    assert.equal(beforeRecords.get(ids.hidden).sourceId,commonSource);
    assert.equal(beforeRecords.get(ids.clipped).clipping,1);
    assert.equal(beforeRecords.get(ids.filtered).filterFree,false);
    assert.equal(before.find(row=>row.id===ids.nested).parent,ids.inner);
    const beforePng = await exportDocument('png');

    await open.click();
    await status.getByText('Warstwy do rasteryzacji: 5',{exact:true}).waitFor({timeout:35000});
    const actual = await checks.evaluateAll(nodes=>nodes.map(n=>Number(n.value)).sort((a,b)=>a-b));
    const selected = [ids.hidden, ids.decorated, ids.clipped, ids.nested].sort((a,b)=>a-b);
    assert.deepEqual(actual,[...selected,ids.keep].sort((a,b)=>a-b));
    assert.equal(await checks.evaluateAll(nodes=>nodes.every(n=>n.checked)),true);
    assert.deepEqual(await exec(readState),before);
    report.checks.push('Skan pokazał 5 kwalifikujących się warstw; filtrowana, grupy, tekst i piksele pozostały poza listą i bez zmian.');
    await ui.locator('#rasterize').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'030-real-photopea-scan.png')});

    await cancel.click();
    assert.equal(await atTop(), true);
    assert.equal(await ui.locator('#rasterizePanel').isVisible(),false);
    assert.deepEqual(await exec(readState),before);
    assert.deepEqual(await pixels(await exportDocument('png')),await pixels(beforePng));
    report.checks.push('ANULUJ zachował wszystkie warstwy i obraz.');

    await open.click();
    await status.getByText('Warstwy do rasteryzacji: 5',{exact:true}).waitFor();
    for (const checkbox of await checks.all()) await checkbox.uncheck();
    assert.equal(await apply.isEnabled(),false);
    assert.equal(await atTop(), true);
    for (const id of selected) await ui.locator('#rasterizeList input[value="'+id+'"]').check();
    assert.equal(await apply.innerText(),'RASTERYZUJ 4 WARSTWY');
    await apply.click();
    await status.getByText('Zrasteryzowane warstwy: 4',{exact:true}).waitFor({timeout:45000});
    assert.equal(await atTop(), false);
    assert.equal(await frame.evaluate(() => document.getElementById('rasterize').previousElementSibling.id), 'layerCleaner');
    const after=await exec(readState), afterRecords=readLayers((await exportDocument('psd')).buffer);
    report.after=after;
    const expected=before.map(row=>selected.includes(row.id)?{...row,kind:0}:row);
    assert.deepEqual(after,expected);
    for (const [id,record] of beforeRecords) {
      assert.ok(attachmentsPreserved(record,afterRecords.get(id)), 'PSD attachments changed for layer '+id);
    }
    assert.ok(afterRecords.get(ids.keep).tags.has('SoLd'));
    assert.equal(afterRecords.get(ids.keep).sourceId,commonSource);
    assert.ok(afterRecords.get(ids.filtered).tags.has('SoLd') && !afterRecords.get(ids.filtered).filterFree);
    for (const id of selected) assert.ok(!afterRecords.get(id).tags.has('SoLd'));
    report.checks.push('Cztery zaznaczone ID stały się pikselami; odznaczony Smart Object o tej samej nazwie oraz filtrowany zachowały typ.');
    report.checks.push('Odczyt PSD potwierdził zachowanie edytowalnej maski z jej danymi, stylu, clippingu, krycia i trybów mieszania.');
    const originalPixels = await pixels(beforePng), finalPixels = await pixels(await exportDocument('png'));
    assert.deepEqual(finalPixels,originalPixels);
    report.checks.push('Kompozycja PNG identyczna piksel w piksel; nazwy, widoczność, kolejność i grupy zachowane.');
    await ui.locator('#rasterize').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'030-real-photopea-result.png')});

    await page.getByRole('button',{name:/Przesunięcie \(V\)|Move Tool \(V\)/}).click();
    await page.keyboard.press('Control+z');
    const undoTypes = await exec(readState);
    report.oneUndoRestored = selected.filter(id=>undoTypes.find(row=>row.id===id).kind===1).length;
    assert.ok(report.oneUndoRestored > 0);
    await page.keyboard.press('Control+Shift+z');
    assert.deepEqual(await exec(readState),after);
    report.checks.push('Jedno Ctrl+Z przywróciło ' + report.oneUndoRestored + ' z 4 Smart Objectów.');

    await open.click();
    await status.getByText('Warstwy do rasteryzacji: 1',{exact:true}).waitFor();
    await exec('var d=app.activeDocument;d.artLayers.add().name="Zmieniony dokument";return true;');
    await apply.click();
    await status.getByText('Dokument zmienił się',{exact:false}).waitFor({timeout:45000});
    assert.equal((await exec(readState)).find(row=>row.id===ids.keep).kind,1);
    report.checks.push('Zmiana dokumentu po skanie zablokowała rasteryzację.');
    if (externalFile) {
      const activated = await exec('var found=false;for(var i=0;i<app.documents.length;i++){var d=app.documents[i];if(String(d.source)==='+
        JSON.stringify(report.externalInput.documents[0].source)+'){app.activeDocument=d;found=true;}}return found;');
      assert.equal(activated,true);
      const state = await exec(readState), external = state.find(layer=>layer.kind===1);
      report.externalInput.afterSwitch = state;
      if (!external) {
        const data = Uint8Array.from(fs.readFileSync(externalFile));
        assert.ok([...readLayers(data.buffer).values()].some(record=>record.tags.has('SoLE') && record.filterFree));
        await open.click();
        await status.getByText('Nie znaleziono warstw do rasteryzacji.',{exact:true}).waitFor();
        report.externalFormat = 'Photopea otworzyła rekord SoLE jako warstwę pikselową';
      } else {
        const psd = readLayers((await exportDocument('psd')).buffer);
        const externalRecord = psd.get(external.id);
        assert.ok(externalRecord?.filterFree);
        report.externalFormat = externalRecord.tags.has('SoLE') ? 'SoLE' : 'SoLd';
        const composite = await pixels(await exportDocument('png'));
        await open.click();
        await status.getByText('Warstwy do rasteryzacji: 1',{exact:true}).waitFor();
        assert.equal(await checks.first().inputValue(),String(external.id));
        await apply.click();
        await status.getByText('Zrasteryzowane warstwy: 1',{exact:true}).waitFor({timeout:45000});
        assert.equal((await exec(readState)).find(layer=>layer.id===external.id).kind,0);
        assert.deepEqual(await pixels(await exportDocument('png')),composite);
        report.checks.push('Zaimportowany zewnętrznie podlinkowany Smart Object stał się pikselami z tym samym ID i kompozycją.');
      }
    }
    await frame.evaluate(() => location.reload());
    await open.waitFor();
    await frame.waitForFunction(() => document.getElementById('rasterize').previousElementSibling?.id === 'layerCleaner');
    assert.equal(await atTop(), false);
    report.checks.push('Rasteryzuj pozostaje na górze po anulowaniu i odznaczeniu wszystkich; po sukcesie i ponownym otwarciu na tym samym PSD pozostaje za Layer Cleaner.');
    assert.deepEqual(report.errors,[]);
    assert.equal(report.aiRequests,0);
    console.log(report.checks.join('\n'));
    if (report.externalFormat) console.log(report.externalFormat);
  } catch (error) {
    report.panelStatus = await status?.textContent({timeout:1000}).catch(()=>null);
    console.error(report.panelStatus, report.errors);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output,'030-integration-report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
