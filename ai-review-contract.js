(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ktxAiReviewContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var categories = ['composition', 'lighting', 'color', 'background', 'subject', 'text', 'effects', 'depth', 'other'];
  var priorities = ['high', 'medium', 'low'];
  var statuses = ['pending', 'done', 'discarded'];
  var maxPayloadBytes = 16 * 1024 * 1024;
  function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(function (key) { return !keys.includes(key); })) throw new Error('Niepoprawny format Oceny AI.');
  }
  function text(value, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Niepoprawny tekst Oceny AI.');
    return value.trim();
  }
  function normalizeReview(value) {
    object(value, ['score', 'summary', 'strengths', 'improvements']);
    if (!Number.isFinite(value.score) || value.score < 0 || value.score > 10 ||
        !Array.isArray(value.strengths) || value.strengths.length > 3 ||
        !Array.isArray(value.improvements) || value.improvements.length > 7) throw new Error('Niepoprawny wynik Oceny AI.');
    var ids = new Set(), issues = new Set();
    var improvements = value.improvements.map(function (item) {
      object(item, ['id', 'issueKey', 'category', 'title', 'priority', 'reason', 'instruction']);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || typeof item.id !== 'string' || ids.has(item.id) ||
          typeof item.issueKey !== 'string' || !/^[a-z0-9_]{1,100}$/.test(item.issueKey) || issues.has(item.issueKey) ||
          !categories.includes(item.category) || !priorities.includes(item.priority) ||
          !Array.isArray(item.instruction) || item.instruction.length < 1 || item.instruction.length > 8)
        throw new Error('Niepoprawna poprawka Oceny AI.');
      ids.add(item.id); issues.add(item.issueKey);
      return {id: item.id, issueKey: item.issueKey, category: item.category, title: text(item.title, 120),
        priority: item.priority, reason: text(item.reason, 700), instruction: item.instruction.map(function (step) { return text(step, 500); })};
    }).sort(function (a, b) { return priorities.indexOf(a.priority) - priorities.indexOf(b.priority); });
    return {score: Math.round(value.score * 10) / 10, summary: text(value.summary, 500),
      strengths: value.strengths.map(function (strength) { return text(strength, 200); }), improvements: improvements};
  }
  function normalizeImprovements(value, review) {
    if (!Array.isArray(value) || value.length !== review.improvements.length) throw new Error('Niepoprawne statusy poprawek.');
    return review.improvements.map(function (item) {
      var saved = value.find(function (entry) { return entry && entry.id === item.id; });
      if (!saved || saved.issueKey !== item.issueKey || !statuses.includes(saved.status)) throw new Error('Niepoprawny status poprawki.');
      return Object.assign({}, item, {status: saved.status});
    });
  }
  var stringSchema = {type: 'string'};
  var improvementSchema = {type: 'object', additionalProperties: false,
    properties: {id: stringSchema, issueKey: stringSchema, category: {type: 'string', enum: categories},
      title: stringSchema, priority: {type: 'string', enum: priorities}, reason: stringSchema,
      instruction: {type: 'array', items: stringSchema, minItems: 1, maxItems: 8}},
    required: ['id', 'issueKey', 'category', 'title', 'priority', 'reason', 'instruction']};
  var schema = {type: 'object', additionalProperties: false,
    properties: {score: {type: 'number', minimum: 0, maximum: 10}, summary: stringSchema,
      strengths: {type: 'array', items: stringSchema, maxItems: 3},
      improvements: {type: 'array', items: improvementSchema, maxItems: 7}},
    required: ['score', 'summary', 'strengths', 'improvements']};
  return Object.freeze({categories: categories, priorities: priorities, statuses: statuses,
    maxPayloadBytes: maxPayloadBytes, normalizeReview: normalizeReview,
    normalizeImprovements: normalizeImprovements, schema: schema});
});
