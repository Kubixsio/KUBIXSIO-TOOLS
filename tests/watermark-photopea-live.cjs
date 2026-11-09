// Optional integration check. Run with node tests/watermark-photopea-live.cjs.
// Uses real Photopea and local plugin files. AI endpoints are blocked.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const resultsDir = path.join(root, 'test-results');
  fs.mkdirSync(resultsDir, {recursive:true});
  const browser = await chromium.launch({headless:true, executablePath:process.env.KTX_TEST_BROWSER});
  const diagnostics = [], errors = [], results = [];
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.text().startsWith('WATERMARK ')) diagnostics.push(JSON.parse(message.text().slice(10)));
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname.includes('openai') || url.hostname.endsWith('workers.dev')) return route.abort();
      const prefix = '/KUBIXSIO-TOOLS/';
      if (url.hostname === 'kubixsio.github.io' && url.pathname.startsWith(prefix)) {
        const name = url.pathname.slice(prefix.length);
        assert.match(name, /^[\w.-]+$/);
        const contentType = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' :
          name.endsWith('.png') ? 'image/png' : 'text/html';
        return route.fulfill({body:fs.readFileSync(path.join(root,name)),contentType});
      }
      return route.continue();
    });
    const config = {
      files:['https://kubixsio.github.io/KUBIXSIO-TOOLS/watermark-full.png'],
      environment:{plugins:[{name:'KUBIXSIO TOOLS',url:'https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html'}]}
    };
    await page.goto('https://www.photopea.com/#'+encodeURIComponent(JSON.stringify(config)));
    await page.getByRole('button',{name:'KUT',exact:true}).click({timeout:60000});
    const frame = page.frameLocator('iframe[src="https://kubixsio.github.io/KUBIXSIO-TOOLS/plugin.html"]');
    await frame.locator('#watermarkSection summary').click();
    for (const [mode, requested] of [['corner',70],['corner',45],['full',50]]) {
      await frame.locator(mode === 'corner' ? '#watermarkCorner' : '#watermarkFull').click();
      const slider = frame.locator('#watermarkOpacity');
      await slider.focus();
      await page.keyboard.press('Home');
      for (let i=0;i<requested/5;i++) await page.keyboard.press('ArrowRight');
      assert.equal(await slider.inputValue(),String(requested));
      let onMessage, timer;
      const confirmed = new Promise((resolve,reject) => {
        timer = setTimeout(()=>reject(new Error('Photopea did not confirm readback')),20000);
        onMessage = message => {
          if (message.text().startsWith('WATERMARK ') && JSON.parse(message.text().slice(10)).stage === 'verified') resolve();
        };
        page.on('console',onMessage);
      });
      try {
        await frame.locator('#watermarkAdd').click();
        await confirmed;
      } finally {
        clearTimeout(timer);
        page.off('console',onMessage);
      }
      const actual = diagnostics.filter(item=>item.stage === 'after-settings').at(-1);
      assert.ok(actual && Number.isFinite(actual.id));
      assert.ok(Math.abs(actual.opacity-requested) <= 100/255);
      assert.equal(actual.blend,mode === 'full' ? 'over' : 'norm');
      results.push({mode,requested,id:actual.id,opacity:actual.opacity,blendMode:actual.blend});
    }
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(resultsDir,'012-real-photopea.png')});
    console.log(JSON.stringify(results,null,2));
  } finally {
    fs.writeFileSync(path.join(resultsDir,'012-integration-report.json'),JSON.stringify({results,diagnostics,errors},null,2));
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
