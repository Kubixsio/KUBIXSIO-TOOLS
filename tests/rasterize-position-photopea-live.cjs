// Real Photopea, local release files, disposable documents and blocked AI endpoints.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..'), plugin = 'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
const report = {checks:[],errors:[],aiRequests:0};
const create = `var d=app.documents.add(128,72,72,'Same.psd');
  var l=d.artLayers.add();d.activeLayer=l;
  d.selection.select([[5,5],[30,5],[30,30],[5,30]]);var color=new SolidColor();color.rgb.hexValue='559966';
  d.selection.fill(color);d.selection.deselect();
  executeAction(stringIDToTypeID('newPlacedLayer'),undefined,DialogModes.NO);
  return {source:String(d.source),name:String(d.name)};`;

async function main() {
  const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    page.on('pageerror',e=>report.errors.push(e.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname.includes('openai')||url.hostname.endsWith('workers.dev')){report.aiRequests++;return route.abort();}
      if(/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname))return route.abort();
      if(url.hostname!=='kubixsio.github.io'||!url.pathname.startsWith('/KUBIXSIO-TOOLS/'))return route.continue();
      const name=path.basename(url.pathname);
      return route.fulfill({body:fs.readFileSync(path.join(root,name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'});
    });
    const config={files:[plugin.replace('plugin.html','watermark-full.png')],environment:{plugins:[{name:'KUBIXSIO TOOLS',url:plugin}]}};
    await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify(config)));
    const kut=page.getByRole('button',{name:'KUT',exact:true});
    await kut.click({timeout:60000});
    const ui=page.frameLocator('iframe[src="'+plugin+'"]');
    let frame;
    async function ready() {
      await ui.locator('#rasterizeScan').waitFor();
      frame=page.frames().find(f=>f.url()===plugin);
      await frame.waitForFunction(()=>window.ktxRasterizePosition&&window.ktxRasterize);
    }
    await ready();
    async function exec(script) {
      return frame.evaluate(script=>new Promise((resolve,reject)=>{
        const marker='POSITION_TEST|'+crypto.randomUUID()+'|';let result;
        const timer=setTimeout(()=>{removeEventListener('message',receive);reject(Error('Native script timeout'));},20000);
        function receive(event){
          if(event.source!==parent||event.origin!=='https://www.photopea.com')return;
          if(typeof event.data==='string'&&event.data.startsWith(marker))result=JSON.parse(event.data.slice(marker.length));
          else if(event.data==='done'&&result!==undefined){clearTimeout(timer);removeEventListener('message',receive);result.error?reject(Error(result.error)):resolve(result);}
        }
        addEventListener('message',receive);
        parent.postMessage('try{var r=(function(){'+script+'})();app.echoToOE('+JSON.stringify(marker)+'+JSON.stringify(r));}catch(e){app.echoToOE('+JSON.stringify(marker)+'+JSON.stringify({error:String(e)}));}','https://www.photopea.com');
      }),script);
    }
    async function top(expected) {
      await frame.waitForFunction(expected=>document.querySelector('.wrap > .section').contains(document.getElementById('rasterize'))===expected,expected,{timeout:5000});
      if(!expected)assert.equal(await ui.locator('#rasterize').evaluate(n=>n.previousElementSibling.id),'layerCleaner');
    }
    async function switchTo(source) {
      await exec('for(var i=0;i<app.documents.length;i++){if(String(app.documents[i].source)==='+JSON.stringify(source)+'){app.activeDocument=app.documents[i];return true;}}throw Error("Missing test document");');
    }
    async function rasterize() {
      await ui.locator('#rasterizeScan').click();
      await ui.locator('#rasterizeStatus').getByText('Warstwy do rasteryzacji: 1',{exact:true}).waitFor({timeout:45000});
      await ui.locator('#rasterizeApply').click();
      await ui.locator('#rasterizeStatus').getByText('Zrasteryzowane warstwy: 1',{exact:true}).waitFor({timeout:45000});
      await top(false);
    }
    const a=await exec(create);report.a=a;await top(true);
    await ui.locator('#rasterizeScan').click();
    await ui.locator('#rasterizeStatus').getByText('Warstwy do rasteryzacji: 1',{exact:true}).waitFor({timeout:45000});
    await top(true);await ui.locator('#rasterizeCancel').click();await top(true);
    await rasterize();report.checks.push('PSD A: only verified rasterization moves the section down.');
    report.registryBeforeClose=await exec('return window.ktxRasterizePositionV1;');
    await kut.click();
    report.iframeCountWhenClosed=await page.locator('iframe[src="'+plugin+'"]').count();
    await kut.click();await ready();report.registryAfterOpen=await exec('return window.ktxRasterizePositionV1;');await top(false);
    // Also destroy the iframe's JavaScript state, covering panel recreation explicitly.
    const reloaded=page.waitForEvent('framenavigated',candidate=>candidate===frame);
    await frame.evaluate(()=>location.reload());await reloaded;await ready();await top(false);
    report.checks.push('Closing/reopening KUT and recreating its iframe both preserve PSD A position.');
    const b=await exec(create);report.b=b;assert.equal(a.name,b.name);assert.notEqual(a.source,b.source);
    await top(true);await rasterize();
    await switchTo(a.source);await top(false);await switchTo(b.source);await top(false);
    const c=await exec(create);report.c=c;await top(true);
    await switchTo(a.source);await top(false);
    report.checks.push('Same-name PSD B and C are independent; A/B restore their used position when switching.');
    await exec('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);return true;');
    await switchTo(c.source);await top(true);
    const reopened=await exec(create);report.reopened=reopened;
    assert.notEqual(reopened.source,a.source);await top(true);
    report.checks.push('Closing used PSD A and reopening another same-name PSD starts unused.');
    assert.deepEqual(report.errors,[]);assert.equal(report.aiRequests,0);
    await page.screenshot({path:path.join(root,'test-results/032-position-result.png')});
    console.log(JSON.stringify(report,null,2));
  } finally {
    fs.writeFileSync(path.join(root,'test-results/032-position-report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
