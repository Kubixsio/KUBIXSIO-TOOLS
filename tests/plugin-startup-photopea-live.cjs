// Local release files in an isolated real Photopea session. Nothing is deployed.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const baselineIndex = process.argv.indexOf('--baseline');
  const baseline = baselineIndex >= 0;
  if (baseline && !process.argv[baselineIndex + 1]) throw Error('Use --baseline <directory containing version 0.3.0>');
  const files = baseline ? path.resolve(process.argv[baselineIndex + 1]) : root;
  const report = {baseline, errors: [], aiRequests: 0};
  const pluginUrl = 'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html';
  const browser = await chromium.launch({headless: true, executablePath: process.env.KTX_TEST_BROWSER});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.addInitScript(() => {
      if (location.hostname === 'www.photopea.com') {
        window.startupScripts = [];
        addEventListener('message', event => {
          if (event.origin === 'https://kubixsio.github.io' && typeof event.data === 'string') {
            window.startupScripts.push({at: performance.now(),
              png: /saveToOE\("png"\)/.test(event.data),
              psd: /saveToOE\("psd"\)/.test(event.data),
              rasterize: event.data.includes('KTX_RASTERIZE|'),
              cleaner: event.data.includes('KTX_CLEANER|')});
          }
        });
      } else if (location.href.startsWith('https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html')) {
        window.startupStates = [];
        window.startupLongTasks = [];
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) startupLongTasks.push({at:entry.startTime, duration:entry.duration});
        }).observe({type:'longtask', buffered:true});
        document.addEventListener('click', event => {
          if (event.target.closest('#noiseButton')) window.noiseClickReceivedAt = performance.now();
        });
        function record() {
          const rasterize = document.getElementById('rasterizeScan');
          const cleaner = document.getElementById('layerCleanerScan');
          const noise = document.getElementById('noiseButton');
          if (!rasterize || !cleaner || !noise) return;
          const state = {at: performance.now(), rasterize: rasterize.disabled,
            cleaner: cleaner.disabled, noise: noise.disabled};
          const last = window.startupStates.at(-1);
          if (!last || last.rasterize !== state.rasterize || last.cleaner !== state.cleaner || last.noise !== state.noise)
            window.startupStates.push(state);
        }
        new MutationObserver(record).observe(document, {subtree:true, attributes:true, attributeFilter:['disabled']});
        addEventListener('DOMContentLoaded', () => {
          window.startupReadyAt = performance.now(); record();
        });
      }
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname.includes('openai') || url.hostname.endsWith('workers.dev')) {
        report.aiRequests++; return route.abort();
      }
      if (/doubleclick|googlesyndication|pubmatic|lijit|adnxs|media\.net/.test(url.hostname)) return route.abort();
      if (url.hostname !== 'kubixsio.github.io' || !url.pathname.startsWith('/KUBIXSIO-TOOLS/')) return route.continue();
      const name = path.basename(url.pathname);
      const contentType = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' :
        name.endsWith('.png') ? 'image/png' : 'text/html';
      return route.fulfill({body:fs.readFileSync(path.join(files, name)), contentType});
    });
    const config = {files:[pluginUrl.replace('plugin.html', 'watermark-full.png')],
      environment:{plugins:[{name:'KUBIXSIO TOOLS', url:pluginUrl}]}};
    await page.goto('https://www.photopea.com/#' + encodeURIComponent(JSON.stringify(config)));
    await page.getByRole('button', {name:'KUT', exact:true}).click({timeout:60000});
    const ui = page.frameLocator('iframe[src="' + pluginUrl + '"]');
    await ui.locator('#rasterizeScan').waitFor();
    const frame = page.frames().find(candidate => candidate.url() === pluginUrl);
    await frame.waitForFunction(() => window.startupReadyAt !== undefined);
    report.initial = await frame.evaluate(() => ({states:startupStates, readyAt:startupReadyAt}));
    // Actual browser clicks, without waiting for the document/export gate to unlock.
    report.beforeClickAfterReadyMs = await frame.evaluate(() => performance.now() - startupReadyAt);
    await ui.locator('#noiseButton').click();
    assert.equal(await ui.locator('#noiseButton').getAttribute('aria-expanded'), 'true');
    report.firstClickAfterReadyMs = await frame.evaluate(() => performance.now() - startupReadyAt);
    report.clickHandlingMs = await frame.evaluate(() => performance.now() - noiseClickReceivedAt);
    await ui.locator('#watermarkSection summary').click();
    await ui.locator('#watermarkFull').click();
    assert.equal(await ui.locator('#watermarkOpacity').inputValue(), '50');
    await page.waitForTimeout(1000); // Observation window for unsolicited startup work, not a production delay.
    report.states = await frame.evaluate(() => startupStates);
    report.longTasks = await frame.evaluate(() => startupLongTasks);
    report.scripts = await page.evaluate(() => startupScripts);
    const disabledAt = report.states.find(row => row.noise)?.at;
    const enabledAt = report.states.find(row => disabledAt !== undefined && row.at > disabledAt && !row.noise)?.at;
    report.globalBlockMs = disabledAt !== undefined && enabledAt !== undefined ? enabledAt - disabledAt : 0;
    if (!baseline) {
      assert.equal(report.scripts.length, 0, 'Startup must send no document scripts to Photopea');
      assert.ok(report.states.every(row => !row.rasterize && !row.cleaner && !row.noise));
      assert.equal(await ui.locator('.wrap > .section').first().locator('#rasterizeScan').count(), 1);
      await ui.locator('#rasterizeScan').click();
      await ui.locator('#rasterizeStatus').getByText('Nie znaleziono warstw do rasteryzacji.', {exact:true}).waitFor({timeout:45000});
      const afterRasterize = await page.evaluate(() => startupScripts);
      assert.equal(afterRasterize.filter(row => row.rasterize).length, 1);
      await ui.locator('#rasterizeCancel').click();
      assert.equal(await ui.locator('.wrap > .section').first().locator('#rasterizeScan').count(), 1);
      await ui.locator('#layerCleanerScan').click();
      await ui.locator('#layerCleanerStatus').getByText('Nie znaleziono warstw do usunięcia.', {exact:true}).waitFor({timeout:45000});
      const afterCleaner = await page.evaluate(() => startupScripts);
      assert.equal(afterCleaner.filter(row => row.cleaner).length, 1);
      report.onDemand = {rasterize:1, cleaner:1};
    }
    assert.equal(report.aiRequests, 0); assert.deepEqual(report.errors, []);
    await page.screenshot({path:path.join(root, 'test-results/031-startup-' + (baseline ? 'before' : 'after') + '.png')});
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.writeFileSync(path.join(root, 'test-results/031-startup-' + (baseline ? 'before' : 'after') + '.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
