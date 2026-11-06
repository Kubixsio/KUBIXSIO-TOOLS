(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ktxPhotopeaLayerTree = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  const limits = Object.freeze({layers: 120, depth: 12, name: 100, path: 240, bytes: 48 * 1024});
  const kinds = Object.freeze({
    NORMAL: 'pixel', TEXT: 'text', SMARTOBJECT: 'smart-object',
    SOLIDFILL: 'fill', GRADIENTFILL: 'fill', PATTERNFILL: 'fill',
    BRIGHTNESSCONTRAST: 'adjustment', LEVELS: 'adjustment', CURVES: 'adjustment',
    EXPOSURE: 'adjustment', VIBRANCE: 'adjustment', HUESATURATION: 'adjustment',
    COLORBALANCE: 'adjustment', BLACKANDWHITE: 'adjustment', PHOTOFILTER: 'adjustment',
    CHANNELMIXER: 'adjustment', COLORLOOKUP: 'adjustment', INVERSION: 'adjustment',
    POSTERIZE: 'adjustment', THRESHOLD: 'adjustment', GRADIENTMAP: 'adjustment',
    SELECTIVECOLOR: 'adjustment'
  });
  const origin = 'https://www.photopea.com';
  const prefix = 'KTX_LAYER_TREE|';
  const encoder = new TextEncoder();
  let pending = false;

  // This function is also run by Photopea's scripting interpreter. Keep it self-contained.
  function collect(app, layerKind, caps, kindNames) {
    function read(object, key) {
      var value;
      // Photopea's interpreter does not reliably propagate a return from a try block.
      try { if (object != null) value = object[key]; } catch (_) {}
      return value;
    }
    function length(items) {
      var n = read(items, 'length');
      return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
    }
    function px(value) {
      try {
        if (value && typeof value === 'object') value = value.as('px');
      } catch (_) { value = null; }
      if (typeof value !== 'number') return null;
      // Photopea exposes pixel UnitValues as numbers, but Math needs their unwrapped value.
      value = +value;
      return isFinite(value) && Math.abs(value) <= 100000000
        ? Math.round(value * 100) / 100 : null;
    }
    function kindOf(layer) {
      var kind = read(layer, 'kind');
      if (typeof kind === 'string') {
        var key = kind.replace(/^LayerKind\./i, '').toUpperCase();
        if (kindNames.indexOf(key) !== -1) return key;
      }
      if (kind != null) {
        for (var i = 0; i < kindNames.length; i++) {
          var entry = read(layerKind, kindNames[i]);
          if (entry != null && entry === kind) return kindNames[i];
        }
      }
      return null;
    }
    if (length(read(app, 'documents')) === 0) return {error: 'NO_DOCUMENT'};
    var doc, docReadFailed = false;
    try { doc = app.activeDocument; } catch (_) { docReadFailed = true; }
    if (docReadFailed) return {error: 'READ_FAILED'};
    if (!doc) return {error: 'NO_DOCUMENT'};
    var top = read(doc, 'layers');
    if (length(top) === null) return {error: 'LAYERS_UNAVAILABLE'};
    var rows = [], truncated = false, visited = 0, bytes = 40;
    function size(row) {
      var json = JSON.stringify(row), total = 1;
      for (var i = 0; i < json.length; i++) {
        var code = json.charCodeAt(i);
        total += code < 128 ? 1 : code < 2048 ? 2 : 3;
      }
      return total;
    }
    var stack = [{layers: top, parent: null, next: 0, count: length(top)}];
    while (stack.length > 0) {
      var frame = stack[stack.length - 1];
      if (frame.next >= frame.count) { stack.pop(); continue; }
      if (visited >= caps.layers) { truncated = true; break; }
      var position = frame.next;
      frame.next = position + 1;
      visited++;
      var layer = read(frame.layers, position);
      if (!layer) { truncated = true; continue; }
      var children = read(layer, 'layers'), childCount = length(children);
      var group = read(layer, 'typename') === 'LayerSet' || childCount !== null;
      var name = read(layer, 'name'), visible = read(layer, 'visible');
      if (typeof name === 'string' && name.length > caps.name) truncated = true;
      var row = {
        name: typeof name === 'string' ? name.slice(0, caps.name) : null,
        kind: group ? 'GROUP' : kindOf(layer),
        visible: typeof visible === 'boolean' ? visible : null,
        parent: frame.parent, position: position
      };
      var bounds = read(layer, 'bounds');
      if (length(bounds) === 4) {
        var box = [px(read(bounds, 0)), px(read(bounds, 1)), px(read(bounds, 2)), px(read(bounds, 3))];
        if (box.indexOf(null) === -1 && box[2] >= box[0] && box[3] >= box[1]) row.bounds = box;
      }
      bytes += size(row);
      if (bytes > caps.bytes) { truncated = true; break; }
      var index = rows.length;
      rows.push(row);
      if (group && childCount === null) truncated = true;
      if (childCount > 0) {
        if (stack.length >= caps.depth) truncated = true;
        else stack.push({layers: children, parent: index, next: 0, count: childCount});
      }
    }
    return {layers: rows, truncated: truncated};
  }

  function failure(code) {
    const messages = {
      NO_DOCUMENT: 'Brak otwartego dokumentu w Photopea.',
      LAYERS_UNAVAILABLE: 'Photopea nie udostępniła listy warstw.',
      READ_FAILED: 'Nie udało się odczytać warstw.',
      INVALID_DATA: 'Photopea zwróciła niepoprawne metadane.',
      TOO_LARGE: 'Metadane warstw przekroczyły limit.',
      BUSY: 'Poczekaj, aż zakończy się odczyt lub eksport Photopea.',
      NOT_EMBEDDED: 'Otwórz plugin jako panel w Photopea.',
      TIMEOUT: 'Photopea nie odpowiedziała na odczyt warstw.',
      DOCUMENT_CHANGED: 'Dokument zmienił się podczas pobierania warstw. Odśwież podgląd.'
    };
    return Object.assign(new Error(messages[code]), {code});
  }

  function buildScript(id, expectedSource) {
    return '(function(){var prefix=' + JSON.stringify(prefix + id + '|') +
      ';' + collect.toString() + ';try{var tree;' +
      (expectedSource === undefined ? '' : 'if(String(app.activeDocument.source)!==' + JSON.stringify(expectedSource) +
        ')tree={error:"DOCUMENT_CHANGED"};else ') +
      'tree=collect(app,typeof LayerKind==="undefined"?null:LayerKind,' +
      JSON.stringify(limits) + ',' + JSON.stringify(Object.keys(kinds)) +
      ');app.echoToOE(prefix+JSON.stringify(tree));}catch(_){app.echoToOE(prefix+JSON.stringify({error:"READ_FAILED"}));}})();';
  }

  function normalize(raw) {
    if (!raw || !Array.isArray(raw.layers) || raw.layers.length > limits.layers) throw failure('INVALID_DATA');
    const layers = [];
    let truncated = raw.truncated === true, bytes = 40;
    for (const row of raw.layers) {
      if (!row || !Number.isSafeInteger(row.position) || row.position < 0 ||
          (row.parent !== null && (!Number.isSafeInteger(row.parent) || row.parent < 0 ||
            layers[row.parent]?.type !== 'group'))) throw failure('INVALID_DATA');
      const parent = row.parent === null ? null : layers[row.parent];
      const indexPath = [...(parent?.indexPath ?? []), row.position];
      if (indexPath.length > limits.depth) throw failure('INVALID_DATA');
      const label = typeof row.name === 'string' ? row.name.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
      const name = label.slice(0, limits.name) || null;
      // Escape slash in individual names; indexPath disambiguates identical names in the same group.
      const segment = (name ?? '?').replace(/%/g, '%25').replace(/\//g, '%2F');
      const fullPath = parent ? parent.path + '/' + segment : segment;
      const path = fullPath.slice(0, limits.path);
      if (label.length > limits.name || fullPath.length > limits.path) truncated = true;
      const visible = typeof row.visible === 'boolean' ? row.visible : null;
      const ancestorVisibility = parent ? parent.effectiveVisible : true;
      const effectiveVisible = visible === false || ancestorVisibility === false ? false :
        visible === true && ancestorVisibility === true ? true : null;
      const type = row.kind === 'GROUP' ? 'group' : Object.hasOwn(kinds, row.kind) ? kinds[row.kind] : 'unknown';
      const layer = {name, type, visible, effectiveVisible, path, indexPath};
      if (Array.isArray(row.bounds) && row.bounds.length === 4 && row.bounds.every(Number.isFinite) &&
          row.bounds[2] >= row.bounds[0] && row.bounds[3] >= row.bounds[1]) layer.bounds = row.bounds.slice();
      bytes += encoder.encode(JSON.stringify(layer)).length + 1;
      if (bytes > limits.bytes) { truncated = true; break; }
      layers.push(layer);
    }
    return {layers, truncated};
  }

  // Revalidate the wire format on both sides. Only the documented, bounded fields survive.
  // Invalid or unavailable context must never prevent an otherwise valid visual review.
  function normalizeContext(value) {
    try {
      if (!value || !Array.isArray(value.layers) || value.layers.length > limits.layers ||
          typeof value.truncated !== 'boolean' || encoder.encode(JSON.stringify(value)).length > limits.bytes) return null;
      const parents = new Map(), rows = [];
      const kindByType = Object.fromEntries(Object.entries(kinds).map(([kind, type]) => [type, kind]));
      kindByType.group = 'GROUP';
      kindByType.unknown = null;
      for (const layer of value.layers) {
        if (!layer || !Object.hasOwn(kindByType, layer.type) ||
            !(layer.name === null || typeof layer.name === 'string' && layer.name.length <= limits.name) ||
            !(layer.visible === null || typeof layer.visible === 'boolean') ||
            !Array.isArray(layer.indexPath) || !layer.indexPath.length || layer.indexPath.length > limits.depth ||
            !layer.indexPath.every(index => Number.isSafeInteger(index) && index >= 0)) return null;
        const key = layer.indexPath.join('/'), parentKey = layer.indexPath.slice(0, -1).join('/');
        const parent = parentKey ? parents.get(parentKey) : null;
        if (parents.has(key) || parentKey && parent === undefined) return null;
        const row = {name: layer.name, kind: kindByType[layer.type], visible: layer.visible,
          parent, position: layer.indexPath.at(-1)};
        if (Array.isArray(layer.bounds) && layer.bounds.length === 4 &&
            layer.bounds.every(n => Number.isFinite(n) && Math.abs(n) <= 100000000)) row.bounds = layer.bounds;
        parents.set(key, rows.length);
        rows.push(row);
      }
      return normalize({layers: rows, truncated: value.truncated});
    } catch (_) { return null; }
  }

  async function readActiveDocument(expectedSource) {
    const host = window.parent;
    if (host === window) throw failure('NOT_EMBEDDED');
    if (pending || window.ktxSaveToOEGate?.owner) throw failure('BUSY');
    const id = window.crypto.randomUUID();
    const marker = prefix + id + '|';
    pending = true;
    return new Promise((resolve, reject) => {
      function finish(error, result) {
        window.clearTimeout(timer);
        window.removeEventListener('message', receive);
        pending = false;
        if (error) reject(error);
        else resolve(result);
      }
      function receive(event) {
        if (event.source !== host || event.origin !== origin ||
            typeof event.data !== 'string' || !event.data.startsWith(marker)) return;
        const payload = event.data.slice(marker.length);
        try {
          if (payload.length > limits.bytes || encoder.encode(payload).length > limits.bytes) throw failure('TOO_LARGE');
          const raw = JSON.parse(payload);
          if (raw?.error) throw failure(['NO_DOCUMENT', 'LAYERS_UNAVAILABLE', 'DOCUMENT_CHANGED'].includes(raw.error) ? raw.error : 'READ_FAILED');
          finish(null, normalize(raw));
        } catch (error) { finish(error?.code ? error : failure('INVALID_DATA')); }
      }
      const timer = window.setTimeout(() => finish(failure('TIMEOUT')), 8000);
      window.addEventListener('message', receive);
      try { host.postMessage(buildScript(id, expectedSource), origin); }
      catch (_) { finish(failure('READ_FAILED')); }
    });
  }

  return Object.freeze({buildScript, normalize, normalizeContext, readActiveDocument, limits});
});
