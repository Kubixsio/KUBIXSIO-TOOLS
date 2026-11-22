import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const root = new URL('../', import.meta.url);
const launch = () => chromium.launch({headless:true, executablePath:process.env.KTX_TEST_BROWSER || undefined});

test('startup sends no document scripts; scans start on click, remain local and serialize document commands', async () => {
  const harness = `<!doctype html><iframe id="plugin" src="/plugin.html" style="width:440px;height:1800px"></iframe>
  <script>
  window.scripts=[];
  const plugin=document.getElementById('plugin');
  const app={documents:[],echoToOE:data=>plugin.contentWindow.postMessage(data,location.origin)};
  addEventListener('message',event=>{
    if(event.source!==plugin.contentWindow||typeof event.data!=='string')return;
    scripts.push(event.data);
    setTimeout(()=>{new Function('app',event.data)(app);plugin.contentWindow.postMessage('done',location.origin);},200);
  });
  </script>`;
  const server = http.createServer(async (request, response) => {
    try {
      const name = new URL(request.url, 'http://localhost').pathname;
      if (name === '/') return response.end(harness);
      if (!/^\/[\w.-]+$/.test(name)) throw Error('Invalid path');
      let body = await readFile(new URL(name.slice(1), root));
      if (name === '/rasterize.js' || name === '/layer-cleaner.js') {
        body = body.toString().replace("const origin = 'https://www.photopea.com'", "const origin = 'http://" + request.headers.host + "'");
      }
      response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(body);
    } catch {response.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    const ui = page.frameLocator('#plugin');
    const frame = page.frames().find(candidate => candidate.url().endsWith('/plugin.html'));
    await frame.waitForFunction(() => window.ktxRasterize && window.ktxLayerCleaner && window.ktxAiReviewSession);
    await frame.evaluate(() => window.ktxAiReviewSession.initialize());
    assert.deepEqual(await page.evaluate(() => scripts), []);
    assert.equal(await ui.locator('#rasterizeScan').isEnabled(), true);
    assert.equal(await ui.locator('#layerCleanerScan').isEnabled(), true);
    await ui.locator('#noiseButton').click();
    assert.equal(await ui.locator('#noiseButton').getAttribute('aria-expanded'), 'true');
    // Catch unsolicited work scheduled after persistence initialization as well.
    await page.waitForTimeout(600);
    assert.deepEqual(await page.evaluate(() => scripts), []);
    for (const [prefix, marker] of [['rasterize','KTX_RASTERIZE|'], ['layerCleaner','KTX_CLEANER|']]) {
      const before = await page.evaluate(() => scripts.length);
      await ui.locator('#' + prefix + 'Scan').evaluate(button => {button.click(); button.click();});
      await frame.waitForFunction(() => !!window.ktxSaveToOEGate.owner);
      assert.equal(await ui.locator('#noiseButton').isEnabled(), true);
      assert.equal(await ui.locator('#' + (prefix === 'rasterize' ? 'layerCleaner' : 'rasterize') + 'Scan').isEnabled(), true);
      await ui.locator('#noiseButton').click();
      await frame.evaluate(() => window.postScript('app.echoToOE("QUEUED_DOCUMENT_COMMAND");'));
      await ui.locator('#' + prefix + 'Status').filter({hasText:'Brak otwartego dokumentu'}).waitFor();
      await page.waitForFunction(expected => scripts.length === expected, before + 2);
      const sent = await page.evaluate(() => scripts.slice(-2));
      assert.ok(sent[0].includes(marker));
      assert.equal(sent[1], 'app.echoToOE("QUEUED_DOCUMENT_COMMAND");');
      await ui.locator('#' + prefix + 'Cancel').click();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Rasteryzuj keeps its session position until a verified positive result, and restores the exact original slot once', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const source = await readFile(new URL('plugin.html', root), 'utf8');
    const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '').replace(/<img\b[^>]*>/g, '');
    const code = await readFile(new URL('rasterize-ui.js', root), 'utf8');
    async function fresh() {
      await page.setContent(html);
      await page.evaluate(() => {
        window.candidateCount = 3;
        window.scanCalls = 0;
        window.moves = 0;
        window.ktxRasterize = {
          async scan() {scanCalls++; return {candidates:Array.from({length:candidateCount}, (_, i) => ({id:i+1,name:'Render'}))};},
          rasterize() {return new Promise((resolve,reject) => {window.finishRasterize=resolve;window.failRasterize=reject;});}
        };
        window.originalParent = document.getElementById('rasterize').parentElement;
        window.originalNext = document.getElementById('rasterize').nextElementSibling;
        const observer = new MutationObserver(records => {
          moves += records.filter(record => [...record.addedNodes].some(node => node.id === 'rasterize')).length;
        });
        observer.observe(originalParent, {childList:true});
      });
      await page.addScriptTag({content:code});
    }
    const top = () => page.evaluate(() => document.querySelector('.wrap > .section').contains(document.getElementById('rasterize')));
    const restored = () => page.evaluate(() => {
      const element=document.getElementById('rasterize');
      return element.parentElement===originalParent && element.nextElementSibling===originalNext && element.previousElementSibling.id==='layerCleaner';
    });
    const open = page.locator('#rasterizeScan'), apply = page.locator('#rasterizeApply');
    const status = page.locator('#rasterizeStatus');
    await fresh();
    assert.equal(await top(), true);
    assert.equal(await page.evaluate(() => scanCalls), 0);
    await open.click();
    assert.equal(await top(), true);
    await page.locator('#rasterizeCancel').click();
    assert.equal(await top(), true);
    await page.evaluate(() => {candidateCount=0;});
    await open.click();
    await status.getByText('Nie znaleziono warstw do rasteryzacji.', {exact:true}).waitFor();
    assert.equal(await top(), true);
    await page.evaluate(() => {candidateCount=3;});
    await open.click();
    for (const checkbox of await page.locator('#rasterizeList input').all()) await checkbox.uncheck();
    assert.equal(await apply.isEnabled(), false);
    assert.equal(await top(), true);
    await page.locator('#rasterizeList input').first().check();
    await apply.click();
    assert.equal(await top(), true, 'Clicking apply is not confirmation');
    await page.evaluate(() => finishRasterize(0));
    await status.getByText('Zrasteryzowane warstwy: 0', {exact:true}).waitFor();
    assert.equal(await top(), true);
    await open.click(); await apply.click();
    await page.evaluate(() => failRasterize(Error('Błąd przed zmianą')));
    await status.getByText('Błąd przed zmianą', {exact:true}).waitFor();
    assert.equal(await top(), true);
    await open.click(); await apply.click();
    await page.evaluate(() => finishRasterize(1));
    await status.getByText('Zrasteryzowane warstwy: 1', {exact:true}).waitFor();
    assert.equal(await restored(), true);
    assert.equal(await page.evaluate(() => moves), 1);
    await open.click(); await apply.click();
    await page.evaluate(() => finishRasterize(3));
    await status.getByText('Zrasteryzowane warstwy: 3', {exact:true}).waitFor();
    assert.equal(await restored(), true);
    assert.equal(await page.evaluate(() => moves), 1);
    await fresh();
    assert.equal(await top(), true);
    await open.click(); await apply.click();
    await page.evaluate(() => finishRasterize(3));
    await status.getByText('Zrasteryzowane warstwy: 3', {exact:true}).waitFor();
    assert.equal(await restored(), true);
    assert.equal(await page.evaluate(() => moves), 1);
  } finally {await browser.close();}
});
