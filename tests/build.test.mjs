import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {REVIEW_INSTRUCTIONS} from '../worker/ai-review-worker.mjs';
import layerMetadata from '../photopea-layer-tree.js';
import instructionRules from '../photopea-instruction-rules.js';

test('deployable Worker bundle imports and preserves schema regex anchors', async () => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], {cwd: new URL('../', import.meta.url)});
  const built = await import('../build/worker.mjs?build-test');
  const body = built.openAIRequest({image:{dataUrl:'data:image/png;base64,offline'},notes:'',previous:null,discardedImprovements:[]});
  assert.equal(body.instructions, REVIEW_INSTRUCTIONS, 'Deployable bundle must contain the current quality prompt.');
  const tree = layerMetadata.normalize({layers: [{name:'Arrow',kind:'SMARTOBJECT',visible:true,parent:null,position:0}]});
  const withTree = built.openAIRequest({image:{dataUrl:'data:image/png;base64,offline'},notes:'',previous:null,
    discardedImprovements:[],layerTree:tree});
  const context = withTree.input[0].content.find(part => part.text?.startsWith('Metadane struktury'));
  assert.deepEqual(JSON.parse(context.text.split('\n')[1]).layerTree, tree);
  assert.ok(withTree.instructions.includes(instructionRules.guidance()));
  const properties = body.text.format.schema.properties.improvements.items.properties;
  assert.equal(properties.id.pattern, '^[a-zA-Z0-9_-]{1,64}$');
  assert.equal(properties.issueKey.pattern, '^[a-z0-9_]{1,100}$');
  assert.equal(properties.title.pattern, '\\S');
  const response = await built.default.fetch(new Request('https://worker.example/health'), {});
  assert.equal(response.status, 200);
});
