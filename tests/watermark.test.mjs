import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const root = new URL('../', import.meta.url);
const unit = n => ({as: () => n, value: n, valueOf: () => n});
const core = await readFile(new URL('plugin-v35-core.js', root), 'utf8');
const extra = await readFile(new URL('plugin-v35-extra.js', root), 'utf8');

for (const mode of ['corner', 'full']) {
  for (const opacity of [mode === 'corner' ? 70 : 50, 35, 0, 100]) {
    test(`${mode} watermark at ${opacity}% uses the chosen asset and preserves existing document layers`, () => {
      const writes = []; let rasterized = false, active;
      const old = {id: 1, name: 'Background', isBackgroundLayer: true};
      const doc = {name: 'Miniaturka', width: unit(600), height: unit(900), layers: [old]};
      let script, opened, listener;
      const context = vm.createContext({URL, console, document: {getElementById: () => null},
        window: {location: {href: 'https://example.test/plugin.html'}, parent: {postMessage: s => { script = s; }},
          ktxWatermarkControls: {getOptions: () => ({mode, opacity})}, addEventListener: (_type, fn) => { listener = fn; }}});
      vm.runInContext(core + '\n' + extra + '\nsetStatus=function(){};', context);
      const app = {activeDocument: doc, echoToOE: message => listener({data: message}), open: url => { opened = url; }};
      const env = {app, AnchorPosition: {MIDDLECENTER: 'center'}, BlendMode: {OVERLAY: 'overlay'},
        RasterizeType: {ENTIRELAYER: 'all'}, ElementPlacement: {PLACEBEFORE: 'before'}};
      vm.runInContext('runWatermark()', context);
      vm.runInNewContext(script, env);
      listener({data: 'done'});
      vm.runInNewContext(script, env);
      assert.equal(opened, mode === 'corner' ? 'https://kubixsio.github.io/KUBIXSIO-TOOLS/watermarkFULLHD.png' : 'https://example.test/watermark-full.png');
      let box = [13, 19, 1293, 739];
      const added = {id: 2, name: 'Imported PNG', get bounds() { return box.map(unit); }, rasterize() { rasterized = true; },
        resize(x, y) { box = [box[0], box[1], box[0] + (box[2]-box[0])*x/100, box[1] + (box[3]-box[1])*y/100]; },
        translate(x, y) { box = box.map((v, i) => v + (i % 2 ? y : x)); }};
      doc.layers.unshift(added);
      const backing = [added, old];
      const wrapper = layer => new Proxy(layer, {
        set(target, key, value) {
          if (key === 'opacity' || key === 'blendMode') {
            assert.equal(active.id, added.id);
            assert.equal(rasterized, true);
            writes.push([key, value]);
          }
          target[key] = value; return true;
        }
      });
      Object.defineProperty(doc, 'layers', {get: () => backing.map(wrapper)});
      Object.defineProperty(doc, 'activeLayer', {get: () => wrapper(active), set: layer => { active = backing.find(l => l.id === layer.id); }});
      assert.notEqual(doc.layers[0], doc.layers[0], 'Photopea returns fresh wrappers');

      listener({data: 'done'});
      vm.runInNewContext(script, env);
      assert.match(script, /doc\.activeLayer\.opacity = job\.opacity/);
      assert.ok(script.includes('"opacity":' + opacity));
      assert.match(script, /doc\.activeLayer\.blendMode = BlendMode\.OVERLAY/);
      assert.doesNotMatch(script, /doc\.layers\[0\]\s*!==\s*layer/);
      assert.equal(added.opacity, opacity);
      assert.deepEqual(writes, mode === 'full' ? [['opacity', opacity], ['blendMode', 'overlay']] : [['opacity', opacity]]);
      assert.equal(added.name, mode === 'full' ? 'WATERMARK NA CAŁOŚĆ' : 'WATERMARK');
      assert.deepEqual(doc.layers.map(l => [l.id,l.name]), [[2,added.name],[1,old.name]]);
      if (mode === 'full') { assert.equal(added.blendMode, 'overlay'); assert.deepEqual(box, [0, 0, 600, 900]); }
      else { assert.equal(added.blendMode, undefined); assert.deepEqual(box, [13, 19, 613, 919]); }
      assert.equal(vm.runInContext('watermarkStage', context), 'idle');
    });
  }
}

test('watermark UI is collapsed, has one 5% slider, remembers per-mode opacity and uses the exact supplied PNG', async () => {
  assert.equal(createHash('sha256').update(await readFile(new URL('watermark-full.png', root))).digest('hex'), 'fa4057d360211e66576ead8d0af5500446f64cd874198e0ab4dcf5a18b215211');
  const server = http.createServer(async (req, res) => {
    const name = req.url.split('?')[0].slice(1) || 'plugin.html';
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(await readFile(new URL(name, root)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.KTX_TEST_BROWSER || undefined});
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:' + server.address().port);
    const section = page.locator('#watermarkSection'), slider = page.locator('#watermarkOpacity');
    assert.equal(await section.getAttribute('open'), null);
    await section.locator('summary').click();
    assert.equal(await section.locator('input[type=range]').count(), 1);
    assert.equal(await slider.getAttribute('step'), '5');
    assert.equal(await slider.inputValue(), '70');
    await slider.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await slider.inputValue(), '75');
    assert.equal(await page.locator('#watermarkOpacityValue').textContent(), '75%');
    await page.getByRole('button',{name:'NA CAŁOŚĆ',exact:true}).click();
    assert.equal(await slider.inputValue(), '50');
    await slider.focus(); await page.keyboard.press('Home');
    assert.equal(await slider.inputValue(), '0');
    await page.keyboard.press('End'); assert.equal(await slider.inputValue(), '100');
    await page.getByRole('button',{name:'W ROGU',exact:true}).click();
    assert.equal(await slider.inputValue(), '75');
    await page.locator('#watermarkSection').screenshot({path:new URL('test-results/watermark-ui.png',root).pathname.replace(/^\/(?=[A-Za-z]:)/,'')});
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
