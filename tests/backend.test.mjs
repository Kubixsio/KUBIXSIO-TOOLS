import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import contract from '../ai-review-contract.js';
import {createWorker, validateRequest, openAIRequest} from '../worker/ai-review-worker.mjs';

const migration = await readFile(new URL('../worker/migrations/001-ai-review.sql', import.meta.url), 'utf8');
const key = 'offline-test-access-key-0123456789abcdef';
const origin = 'https://kubixsio.github.io';
const image = {mimeType: 'image/png', width: 1, height: 1,
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lMkAAAAASUVORK5CYII='};
const advice = (id = 'imp_1', priority = 'high') => ({id, issueKey: id + '_background_left', category: 'background',
  title: 'Przyciemnij lewy fragment tła', priority, reason: 'Jasny fragment konkuruje z napisem.',
  instruction: ['Odszukaj warstwę tła przez przełączanie widoczności.', 'Dodaj Krzywe i ogranicz korektę miękką maską.']});
const review = (improvements = []) => ({score: 8.6, summary: 'Czytelna kompozycja i spójna kolorystyka.', strengths: ['Czytelny napis'], improvements});
const payload = () => ({schemaVersion: 1, documentKey: 'review:12345678-1234-1234-1234-123456789abc', image: {...image},
  notes: '', previous: null, discardedImprovements: []});
function setup(legacy = []) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE ai_attempts(id TEXT PRIMARY KEY,day_key TEXT,month_key TEXT);');
  legacy.forEach((entry, i) => sqlite.prepare('INSERT INTO ai_attempts VALUES(?,?,?)').run(String(i), entry.day, entry.month));
  sqlite.exec(migration);
  const db = {prepare(sql) { return {bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async run() { return sqlite.prepare(sql).run(...args); }
  }; }}; }};
  return {sqlite, env: {REVIEW_DB: db, AI_ACCESS_KEY: key, OPENAI_API_KEY: 'offline-server-secret', OPENAI_MODEL: 'gpt-4.1-mini-2025-04-14'}};
}
function request(body = payload(), options = {}) {
  return new Request('https://worker.example/analyze', {method: 'POST', headers: {'Origin': origin,
    'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', ...options.headers}, body: JSON.stringify(body)});
}
function fixture(result = review(), status = 'completed') {
  return new Response(JSON.stringify({status, output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(result)}]}]}));
}
test('review accepts 0–7 necessary improvements and sorts priority', () => {
  for (let count = 0; count <= 7; count++) assert.equal(contract.normalizeReview(review(Array.from({length: count}, (_, i) => advice('imp_' + i)))).improvements.length, count);
  const result = contract.normalizeReview(review([advice('low', 'low'), advice('high', 'high'), advice('medium', 'medium')]));
  assert.deepEqual(result.improvements.map(item => item.priority), ['high', 'medium', 'low']);
  assert.throws(() => contract.normalizeReview(review(Array.from({length: 8}, (_, i) => advice('imp_' + i)))));
  assert.throws(() => contract.normalizeReview(review([advice(), advice()])));
  assert.throws(() => contract.normalizeReview({...review(), score: 11}));
  assert.throws(() => contract.normalizeReview(review([{...advice(), status: 'done'}])));
});
test('PNG validation rejects remote URLs, wrong dimensions, broken signatures and oversized images', () => {
  assert.doesNotThrow(() => validateRequest(payload()));
  for (const change of [{dataUrl: 'https://example.org/image.png'}, {width: 2}, {height: 5000}, {dataUrl: image.dataUrl.replace('iVBOR', 'AAAAA')}]) {
    assert.throws(() => validateRequest({...payload(), image: {...image, ...change}}));
  }
  assert.throws(() => validateRequest({...payload(), notes: 'a'.repeat(4001)}));
  assert.throws(() => validateRequest({...payload(), oldField: true}));
});
test('reanalysis sends both complete images, done/discarded states and stable discarded context', () => {
  const input = payload(), previousReview = review([advice('done'), advice('discarded')]);
  input.previous = {image: {...image}, review: previousReview, improvements: previousReview.improvements.map((item, i) => ({id: item.id, issueKey: item.issueKey, status: i ? 'discarded' : 'done'}))};
  input.discardedImprovements = [{issueKey: 'old_subject_position', category: 'subject', title: 'Przesuń postać w lewo'}];
  const body = openAIRequest(validateRequest(input));
  assert.equal(body.input[0].content.filter(item => item.type === 'input_image').length, 2);
  assert.equal(body.text.format.strict, true); assert.equal(body.store, false);
  assert.match(body.input[0].content.at(-1).text, /"status":"done"/);
  assert.match(body.input[0].content.at(-1).text, /old_subject_position/);
  assert.match(body.instructions, /Nie zwracaj porzuconej porady pod innym tytułem/);
  assert.match(body.instructions, /Status done oznacza próbę zmiany/);
});
test('CORS, access verification and failed auth never invoke OpenAI', async () => {
  const {env, sqlite} = setup(); let calls = 0;
  const worker = createWorker({fetchUpstream: async () => { calls++; return fixture(); }});
  const preflight = await worker.fetch(new Request('https://worker.example/analyze', {method: 'OPTIONS', headers: {Origin: origin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'}}), env);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const forbidden = await worker.fetch(request(payload(), {headers: {Origin: 'https://attacker.example'}}), env);
  assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
  const badKey = await worker.fetch(request(payload(), {headers: {Authorization: 'Bearer wrong-key-012345678901234567890123'}}), env);
  assert.equal(badKey.status, 401);
  const access = await worker.fetch(new Request('https://worker.example/access', {headers: {Origin: origin, Authorization: 'Bearer ' + key}}), env);
  assert.deepEqual(await access.json(), {ok: true}); assert.equal(calls, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_review_attempts').get().n, 0);
});
test('invalid/oversized payloads and missing configuration fail before a paid reservation', async () => {
  const {env, sqlite} = setup(); let calls = 0;
  const worker = createWorker({fetchUpstream: async () => { calls++; return fixture(); }});
  assert.equal((await worker.fetch(request({...payload(), notes: 5}), env)).status, 400);
  assert.equal((await worker.fetch(request(payload(), {headers: {'Content-Length': String(17 * 1024 * 1024)}}), env)).status, 413);
  const streamed = new Request('https://worker.example/analyze', {method: 'POST', headers: {Origin: origin, Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'}, body: ' '.repeat(17 * 1024 * 1024)});
  assert.equal((await worker.fetch(streamed, env)).status, 413);
  assert.equal((await worker.fetch(request(), {...env, OPENAI_API_KEY: ''})).status, 503);
  assert.equal((await worker.fetch(request(), {...env, AI_ACCESS_KEY: ''})).status, 503);
  assert.equal(calls, 0); assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_review_attempts').get().n, 0);
});
test('concurrent requests cannot exceed five daily paid attempts', async () => {
  const {env, sqlite} = setup(); let calls = 0;
  const worker = createWorker({fetchUpstream: async () => { calls++; return fixture(review([advice()])); }});
  const responses = await Promise.all(Array.from({length: 20}, () => worker.fetch(request(), env)));
  assert.equal(responses.filter(response => response.status === 200).length, 5);
  assert.equal(calls, 5); assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_review_attempts').get().n, 5);
  assert.equal(responses.filter(response => response.status === 429).length, 15);
});
test('legacy daily and monthly usage survive the migration', async () => {
  const now = new Date().toISOString(), day = now.slice(0,10), month = now.slice(0,7);
  const daily = setup(Array.from({length: 4}, () => ({day, month})));
  const worker = createWorker({fetchUpstream: async () => fixture()});
  assert.equal((await worker.fetch(request(), daily.env)).status, 200);
  assert.equal((await (await worker.fetch(request(), daily.env)).json()).error.code, 'DAILY_LIMIT');
  const otherDay = day.endsWith('-01') ? month + '-02' : month + '-01';
  const monthly = setup(Array.from({length: 49}, () => ({day: otherDay, month})));
  assert.equal((await worker.fetch(request(), monthly.env)).status, 200);
  assert.equal((await (await worker.fetch(request(), monthly.env)).json()).error.code, 'MONTHLY_LIMIT');
  daily.sqlite.exec(migration);
  assert.equal(daily.sqlite.prepare('SELECT COUNT(*) AS n FROM ai_review_attempts').get().n, 5);
});
test('failed, incomplete, refused and invalid upstream responses consume a slot and expose no secrets', async () => {
  const cases = [
    {fetch: async () => { throw new Error(key); }, code: 'OPENAI_UNAVAILABLE'},
    {fetch: async () => fixture(review(), 'incomplete'), code: 'OPENAI_INCOMPLETE'},
    {fetch: async () => fixture({...review(), score: 999}), code: 'OPENAI_INVALID_RESULT'},
    {fetch: async () => new Response(JSON.stringify({status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: key}]}]})), code: 'OPENAI_REFUSAL'}
  ];
  for (const entry of cases) {
    const {env, sqlite} = setup(); const response = await createWorker({fetchUpstream: entry.fetch}).fetch(request(), env);
    const text = await response.text(); assert.equal(JSON.parse(text).error.code, entry.code); assert.ok(!text.includes(key));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ai_review_attempts').get().n, 1);
    assert.equal(sqlite.prepare('SELECT state FROM ai_review_attempts').get().state, 'failed');
  }
});
test('AI request uses only the fixed official endpoint, server key and complete structured result', async () => {
  const {env} = setup(); let seen;
  const worker = createWorker({fetchUpstream: async (url, options) => { seen = {url, options}; return fixture(review([advice()])); }});
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200); assert.equal((await response.json()).score, 8.6);
  assert.equal(seen.url, 'https://api.openai.com/v1/responses'); assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, 'Bearer offline-server-secret');
  assert.ok(!JSON.stringify(JSON.parse(seen.options.body)).includes(key));
});
