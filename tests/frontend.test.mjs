import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const root = new URL('../', import.meta.url);
const key = 'offline-test-access-key-0123456789abcdef';
const advice = (id, priority) => ({id, issueKey: id + '_problem', category: 'background', title: 'Poprawka ' + id,
  priority, reason: 'Konkretny problem <img src=x onerror=alert(1)>.', instruction: ['Odszukaj odpowiednią warstwę tła.', 'Dodaj lokalną korektę z maską.']});
const firstResult = {score: 8.6, summary: 'Czytelna miniaturka.', strengths: ['Spójne światło', 'Czytelny napis'],
  improvements: [advice('low', 'low'), advice('high', 'high'), advice('medium', 'medium')]};
const noChanges = {score: 9.2, summary: 'Miniaturka jest gotowa.', strengths: ['Spójna kompozycja'], improvements: []};
const harness = `<!doctype html><html><body style="margin:0;background:#15171b">
<iframe id="plugin" src="/plugin.html" style="width:430px;height:1400px;border:0"></iframe>
<script>
var version=0, receivedScripts=[], plugin=document.getElementById('plugin');
var documentSequence=0;
function documentFixture(name){return {name:name,source:'local,'+(documentSequence++)+','+name,width:64,height:36,saveToOE:function(){
  var canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;var ctx=canvas.getContext('2d');
  ctx.fillStyle=version?'#777777':'#eeeeee';ctx.fillRect(0,0,64,36);
  var bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
  setTimeout(function(){plugin.contentWindow.postMessage(bytes.buffer,location.origin);plugin.contentWindow.postMessage('done',location.origin);},50);
}};}
var doc=documentFixture('Thumbnail.psd'), documents=[doc];var app={echoToOE:function(text){plugin.contentWindow.postMessage(text,location.origin);}};
// Photopea creates fresh document wrappers on every access. Object identity is not stable.
Object.defineProperty(app,'documents',{get:function(){return documents.map(function(d){return Object.assign({},d);});}});
Object.defineProperty(app,'activeDocument',{get:function(){return Object.assign({},doc);},set:function(d){doc=d;}});
window.changeDocument=function(name){var next=documentFixture(name);documents.push(next);app.activeDocument=next;};
window.addEventListener('message',function(event){if(event.source!==plugin.contentWindow||typeof event.data!=='string')return;
  receivedScripts.push(event.data);try{new Function('app',event.data)(app);}catch(error){console.error(error);}
  setTimeout(function(){plugin.contentWindow.postMessage('done',location.origin);},5);
});
</script></body></html>`;
test('frontend: preview, cards, persistence, reanalysis, errors and document/export isolation', {timeout: 120000}, async () => {
  let result = firstResult, failure = null, delay = 100, calls = [], accessCalls = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/access' || path === '/analyze') {
        response.setHeader('Content-Type', 'application/json');
        if (request.headers.authorization !== 'Bearer ' + key || failure === 'UNAUTHORIZED') {
          response.statusCode = 401; response.end(JSON.stringify({error:{code:'UNAUTHORIZED'}})); return;
        }
        if (path === '/access') { accessCalls++; response.end('{"ok":true}'); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        calls.push(JSON.parse(Buffer.concat(chunks).toString()));
        await new Promise(resolve => setTimeout(resolve, delay));
        response.end(JSON.stringify(result)); return;
      }
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      if (path === '/') { response.end(harness); return; }
      if (path === '/ai-review-config.js') { response.end("window.ktxAiReviewConfig={endpoint:location.origin+'/analyze'};"); return; }
      if (!/^\/[a-zA-Z0-9.-]+$/.test(path)) throw new Error('Invalid local path');
      response.end(await readFile(new URL(path.slice(1), root)));
    } catch (_) { response.statusCode = 404; response.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.KTX_TEST_BROWSER || undefined});
    const page = await browser.newPage({viewport: {width: 460, height: 1000}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).hostname !== '127.0.0.1') await route.abort(); else await route.continue();
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const frame = page.frameLocator('#plugin'), ui = name => frame.locator('#aiReview' + name);
    async function reloadPanel() {
      const navigation = page.waitForEvent('framenavigated', candidate => candidate.url().includes('/plugin.html'));
      await page.evaluate(() => document.getElementById('plugin').contentWindow.location.reload());
      await navigation;
    }
    async function previewReady() {
      await page.waitForFunction(() => !document.getElementById('plugin').contentWindow.document.getElementById('aiReviewCapture').disabled);
    }
    await ui('PreviewStatus').filter({hasText: '64 × 36 px'}).waitFor();
    assert.equal(await ui('Notes').getAttribute('placeholder'), null);
    await ui('KeyInput').fill(key); await ui('SaveKey').click();
    await ui('AccessStatus').filter({hasText: 'Połączono'}).waitFor();
    assert.equal(await ui('KeyInput').inputValue(), ''); assert.equal(accessCalls, 1);
    await ui('Notes').fill('Zachowaj spokojne kolory.');
    await ui('Capture').click(); await ui('PreviewStatus').filter({hasText: '64 × 36 px'}).waitFor();
    await previewReady();
    assert.equal(await ui('Notes').inputValue(), 'Zachowaj spokojne kolory.');
    assert.equal(calls.length, 0, 'Refreshing the same document must preserve notes without calling AI.');
    // Two synchronous clicks exercise the internal guard, not only the disabled UI.
    await ui('Analyze').evaluate(element => { element.click(); element.click(); });
    await ui('Score').filter({hasText: '8.6 / 10'}).waitFor();
    assert.equal(calls.length, 1); assert.equal(calls[0].previous, null); assert.equal(calls[0].notes, 'Zachowaj spokojne kolory.');
    const cards = frame.locator('.ai-review-card');
    assert.equal(await cards.count(), 3);
    assert.match(await cards.nth(0).innerText(), /high/); assert.match(await cards.nth(1).innerText(), /medium/);
    assert.equal(await cards.locator('img').count(), 0);
    await cards.nth(0).getByRole('button',{name:'INSTRUKCJA'}).click();
    assert.equal(await cards.nth(0).locator('ol').isVisible(), true);
    await cards.nth(0).getByRole('button',{name:'ZROBIONE',exact:true}).click();
    await cards.nth(1).getByRole('button',{name:'PORZUĆ',exact:true}).click();
    assert.equal(await cards.nth(0).getAttribute('data-status'), 'done');
    assert.equal(await cards.nth(1).getAttribute('data-status'), 'discarded'); assert.equal(await cards.count(), 3);
    await mkdir(new URL('test-results/', root), {recursive:true});
    await frame.locator('#aiReview').screenshot({path: new URL('test-results/ai-review.png', root).pathname.replace(/^\/(?=[A-Za-z]:)/,'')});
    await page.evaluate(() => { version=1; });
    await ui('Capture').click(); await ui('PreviewStatus').filter({hasText:'64 × 36 px'}).waitFor();
    await previewReady();
    // Flush pending IndexedDB writes by reloading the panel in the same Photopea tab.
    await reloadPanel();
    await ui('Score').filter({hasText:'8.6 / 10'}).waitFor();
    await ui('AccessStatus').filter({hasText:'Połączono'}).waitFor();
    assert.equal(await cards.nth(0).getAttribute('data-status'), 'done');
    assert.equal(await cards.nth(1).getAttribute('data-status'), 'discarded');
    assert.equal(await ui('Notes').inputValue(), 'Zachowaj spokojne kolory.');
    result = noChanges; await ui('Analyze').click(); await ui('Score').filter({hasText:'9.2 / 10'}).waitFor();
    assert.equal(calls.length, 2); assert.notEqual(calls[1].previous.image.dataUrl, calls[1].image.dataUrl);
    assert.deepEqual(calls[1].previous.improvements.map(item => item.status), ['done','discarded','pending']);
    assert.equal(calls[1].discardedImprovements[0].issueKey, 'medium_problem');
    assert.equal(await cards.count(), 0); assert.equal(await ui('NoChanges').isVisible(), true);
    assert.equal(await ui('ImprovementsTitle').isVisible(), false);
    await ui('Analyze').click(); await ui('AnalysisStatus').filter({hasText:'Analiza zakończona.'}).waitFor();
    assert.equal(calls[2].previous.review.improvements.length, 0);
    assert.equal(calls[2].discardedImprovements[0].issueKey, 'medium_problem');
    result = {...noChanges, score: 100}; await ui('Analyze').click();
    await ui('AnalysisStatus').filter({hasText:'Niepoprawny wynik'}).waitFor();
    assert.match(await ui('Score').innerText(), /9.2/);
    failure = 'UNAUTHORIZED'; await ui('Analyze').click();
    await ui('AccessStatus').filter({hasText:'Brak dostępu'}).waitFor();
    assert.match(await ui('Score').innerText(), /9.2/); assert.equal(await ui('PreviewImage').isVisible(), true);
    await reloadPanel();
    await ui('AccessStatus').filter({hasText:'Brak dostępu'}).waitFor();
    await ui('Score').filter({hasText:'9.2 / 10'}).waitFor();
    failure = null; await ui('KeyInput').fill(key); await ui('SaveKey').click();
    await ui('AccessStatus').filter({hasText:'Połączono'}).waitFor();
    await page.evaluate(() => changeDocument('Other.psd')); await ui('Capture').click();
    await ui('PreviewStatus').filter({hasText:'Other.psd'}).waitFor();
    await previewReady();
    assert.equal(await ui('Result').isVisible(), false); assert.equal(await ui('Notes').inputValue(), '');
    result = firstResult; await ui('Analyze').click(); await ui('Score').filter({hasText:'8.6 / 10'}).waitFor();
    assert.equal(calls.at(-1).previous, null); assert.deepEqual(calls.at(-1).discardedImprovements, []);
    // Changing the active Photopea document during an AI request rejects the stale result.
    delay = 500; result = noChanges; const count = calls.length;
    await ui('Analyze').click();
    await page.waitForFunction(() => document.getElementById('plugin').contentWindow.document.getElementById('aiReviewAnalyze').disabled);
    while (calls.length === count) await new Promise(resolve => setTimeout(resolve, 25));
    await page.evaluate(() => changeDocument('Third.psd'));
    await ui('AnalysisStatus').filter({hasText:'Dokument zmienił się'}).waitFor();
    assert.match(await ui('Score').innerText(), /8.6/); assert.equal(await cards.count(), 3);
    // Review capture owns the binary gate and queues scripts from existing features.
    await ui('Capture').click();
    const actualFrame = page.frames().find(candidate => candidate.url().includes('/plugin.html'));
    await actualFrame.waitForFunction(() => window.ktxSaveToOEGate.owner === 'ai-review');
    await actualFrame.evaluate(() => window.postScript('app.echoToOE("KTX_EXTERNAL_TEST");'));
    await ui('PreviewStatus').filter({hasText:'Third.psd'}).waitFor();
    await previewReady();
    assert.equal(await page.evaluate(() => receivedScripts.at(-1)), 'app.echoToOE("KTX_EXTERNAL_TEST");');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  }
});
