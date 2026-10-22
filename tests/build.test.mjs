import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('deployable Worker bundle imports and preserves schema regex anchors', async () => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], {cwd: new URL('../', import.meta.url)});
  const built = await import('../build/worker.mjs?build-test');
  const body = built.openAIRequest({image:{dataUrl:'data:image/png;base64,offline'},notes:'',previous:null,discardedImprovements:[]});
  const properties = body.text.format.schema.properties.improvements.items.properties;
  assert.equal(properties.id.pattern, '^[a-zA-Z0-9_-]{1,64}$');
  assert.equal(properties.issueKey.pattern, '^[a-z0-9_]{1,100}$');
  assert.equal(properties.title.pattern, '\\S');
  const response = await built.default.fetch(new Request('https://worker.example/health'), {});
  assert.equal(response.status, 200);
});
