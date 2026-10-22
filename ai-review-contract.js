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
  var validationCodes = ['INVALID_OBJECT', 'INVALID_SCORE', 'INVALID_STRENGTHS', 'INVALID_IMPROVEMENTS',
    'INVALID_ID', 'INVALID_ISSUE_KEY', 'INVALID_TITLE', 'INVALID_REASON', 'INVALID_INSTRUCTION',
    'INVALID_SUMMARY', 'INVALID_STRENGTH', 'INVALID_CATEGORY', 'INVALID_PRIORITY', 'DUPLICATE_ID', 'DUPLICATE_ISSUE_KEY'];
  function invalid(code) { var error = new Error('Niepoprawny wynik Oceny AI.'); error.validationCode = code; throw error; }
  function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key); })) invalid('INVALID_OBJECT');
  }
  function text(value, max, code) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(code);
    return value.trim();
  }
  function normalizeReview(value) {
    object(value, ['score', 'summary', 'strengths', 'improvements']);
    if (!Number.isFinite(value.score) || value.score < 0 || value.score > 10) invalid('INVALID_SCORE');
    if (!Array.isArray(value.strengths) || value.strengths.length > 3) invalid('INVALID_STRENGTHS');
    if (!Array.isArray(value.improvements) || value.improvements.length > 7) invalid('INVALID_IMPROVEMENTS');
    var ids = new Set(), issues = new Set();
    var improvements = value.improvements.map(function (item) {
      object(item, ['id', 'issueKey', 'category', 'title', 'priority', 'reason', 'instruction']);
      if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)) invalid('INVALID_ID');
      if (ids.has(item.id)) invalid('DUPLICATE_ID');
      if (typeof item.issueKey !== 'string' || !/^[a-z0-9_]{1,100}$/.test(item.issueKey)) invalid('INVALID_ISSUE_KEY');
      if (issues.has(item.issueKey)) invalid('DUPLICATE_ISSUE_KEY');
      if (!categories.includes(item.category)) invalid('INVALID_CATEGORY');
      if (!priorities.includes(item.priority)) invalid('INVALID_PRIORITY');
      if (!Array.isArray(item.instruction) || item.instruction.length < 1 || item.instruction.length > 8) invalid('INVALID_INSTRUCTION');
      ids.add(item.id); issues.add(item.issueKey);
      return {id: item.id, issueKey: item.issueKey, category: item.category, title: text(item.title, 120, 'INVALID_TITLE'),
        priority: item.priority, reason: text(item.reason, 700, 'INVALID_REASON'), instruction: item.instruction.map(function (step) { return text(step, 500, 'INVALID_INSTRUCTION'); })};
    }).sort(function (a, b) { return priorities.indexOf(a.priority) - priorities.indexOf(b.priority); });
    return {score: Math.round(value.score * 10) / 10, summary: text(value.summary, 500, 'INVALID_SUMMARY'),
      strengths: value.strengths.map(function (strength) { return text(strength, 200, 'INVALID_STRENGTH'); }), improvements: improvements};
  }
  function normalizeImprovements(value, review) {
    if (!Array.isArray(value) || value.length !== review.improvements.length) throw new Error('Niepoprawne statusy poprawek.');
    return review.improvements.map(function (item) {
      var saved = value.find(function (entry) { return entry && entry.id === item.id; });
      if (!saved || saved.issueKey !== item.issueKey || !statuses.includes(saved.status)) throw new Error('Niepoprawny status poprawki.');
      return Object.assign({}, item, {status: saved.status});
    });
  }
  // Keep the stricter UTF-16 and cross-item uniqueness checks in normalizeReview.
  function textSchema(max) { return {type: 'string', minLength: 1, maxLength: max,
    pattern: '\\S'}; }
  var improvementSchema = {type: 'object', additionalProperties: false,
    properties: {id: {type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]{1,64}$'},
      issueKey: {type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9_]{1,100}$'}, category: {type: 'string', enum: categories},
      title: textSchema(120), priority: {type: 'string', enum: priorities}, reason: textSchema(700),
      instruction: {type: 'array', items: textSchema(500), minItems: 1, maxItems: 8}},
    required: ['id', 'issueKey', 'category', 'title', 'priority', 'reason', 'instruction']};
  var schema = {type: 'object', additionalProperties: false,
    properties: {score: {type: 'number', minimum: 0, maximum: 10}, summary: textSchema(500),
      strengths: {type: 'array', items: textSchema(200), maxItems: 3},
      improvements: {type: 'array', items: improvementSchema, maxItems: 7}},
    required: ['score', 'summary', 'strengths', 'improvements']};
  return Object.freeze({categories: categories, priorities: priorities, statuses: statuses,
    maxPayloadBytes: maxPayloadBytes, validationCodes: validationCodes, normalizeReview: normalizeReview,
    normalizeImprovements: normalizeImprovements, schema: schema});
});
