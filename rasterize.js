(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./rasterize-psd.js') : root.ktxRasterizePsd);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ktxRasterize = api;
})(typeof window === 'object' ? window : null, function (psd) {
  'use strict';
  const origin = 'https://www.photopea.com', prefix = 'KTX_RASTERIZE|';
  const limits = Object.freeze({layers: 3000, depth: 64});

  // Executed by Photopea's scripting interpreter. Layer wrappers are not stable
  // across reads, so the snapshot and confirmation use IDs throughout.
  function operate(mode, payload, caps) {
    if (!app.documents.length) return {error: 'NO_DOCUMENT'};
    var doc = app.activeDocument, source = String(doc.source || ''), matches = 0;
    for (var i = 0; i < app.documents.length; i++) {
      if (String(app.documents[i].source) === source) matches++;
    }
    if (!source || matches !== 1) return {error: 'AMBIGUOUS_DOCUMENT'};
    var refs = [], smartKind = LayerKind.SMARTOBJECT, pixelKind = LayerKind.NORMAL;
    function snapshot() {
      var rows = [], seen = [];
      refs = [];
      function visit(layers, parent, depth) {
        if (depth > caps.depth) throw 'UNSAFE_TREE';
        for (var i = 0; i < layers.length; i++) {
          if (rows.length >= caps.layers) throw 'UNSAFE_TREE';
          var layer = layers[i], id = Number(layer.id), type = layer.typename;
          if (!isFinite(id) || id < 0 || Math.floor(id) !== id || seen.indexOf(id) !== -1 ||
              (type !== 'ArtLayer' && type !== 'LayerSet')) throw 'UNSAFE_TREE';
          seen.push(id);
          var group = type === 'LayerSet';
          var kind = layer.kind;
          rows.push({id: id, parent: parent, name: String(layer.name), group: group,
            kind: String(kind), smart: !group && smartKind != null && kind === smartKind,
            locked: layer.allLocked === true, visible: layer.visible === true,
            opacity: Number(layer.opacity), blend: String(layer.blendMode)});
          refs.push(layer);
          if (group) visit(layer.layers, id, depth + 1);
        }
      }
      visit(doc.layers, null, 0);
      return {source: source, name: String(doc.name), historyLength: doc.historyStates.length, layers: rows};
    }

    var before = snapshot();
    if (mode === 'scan') {
      var exporting = false;
      for (var i = 0; i < before.layers.length; i++) if (before.layers[i].smart && !before.layers[i].locked) exporting = true;
      return {meta: before, exporting: exporting};
    }
    if (!payload || JSON.stringify(before) !== JSON.stringify(payload.meta)) return {error: 'DOCUMENT_CHANGED'};
    if (mode !== 'apply' || !payload.ids || !payload.ids.length) return {error: 'INVALID_SELECTION'};
    var selected = [], targets = [], count = 0;
    for (var i = 0; i < payload.ids.length; i++) {
      var id = payload.ids[i], at = -1;
      for (var j = 0; j < before.layers.length; j++) if (before.layers[j].id === id) at = j;
      if (at < 0 || selected.indexOf(id) !== -1 || payload.verified.indexOf(id) === -1) return {error: 'INVALID_SELECTION'};
      if (!before.layers[at].smart || before.layers[at].locked) return {error: 'INVALID_SELECTION'};
      selected.push(id);
      targets.push(refs[at]);
    }
    var originalActive = doc.activeLayer, originalId = originalActive ? Number(originalActive.id) : null;
    var failed = false;
    try {
      for (var i = 0; i < payload.ids.length; i++) {
        var id = payload.ids[i];
        // This is Photopea's native layer-only action. RasterizeType.ENTIRELAYER
        // is deliberately avoided; this action keeps outer styles and masks.
        doc.activeLayer = targets[i];
        var target = new ActionReference();
        target.putIdentifier(charIDToTypeID('Lyr '), id);
        var descriptor = new ActionDescriptor();
        descriptor.putReference(charIDToTypeID('null'), target);
        executeAction(stringIDToTypeID('rasterizeLayer'), descriptor, DialogModes.NO);
        if (Number(doc.activeLayer.id) !== id || doc.activeLayer.kind !== pixelKind) throw 'RASTERIZE_FAILED';
        count++;
      }
    } catch (_) { failed = true; }
    if (failed) return {error: 'RASTERIZE_FAILED', count: count};
    var after = snapshot();
    if (before.layers.length !== after.layers.length) return {error: 'RASTERIZE_FAILED', count: count};
    for (var i = 0; i < before.layers.length; i++) {
      var oldRow = before.layers[i], newRow = after.layers[i];
      if (selected.indexOf(oldRow.id) !== -1) {
        oldRow.kind = String(pixelKind);
        oldRow.smart = false;
      }
      if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) return {error: 'RASTERIZE_FAILED', count: count};
    }
    if (originalId !== null) {
      for (var i = 0; i < after.layers.length; i++) {
        if (after.layers[i].id === originalId) doc.activeLayer = refs[i];
      }
    }
    return {count: count, exporting: true};
  }

  function buildScript(marker, mode, payload) {
    return '(function(){' + operate.toString() + ';try{var result=operate(' +
      JSON.stringify(mode) + ',' + JSON.stringify(payload ?? null) + ',' + JSON.stringify(limits) +
      ');app.echoToOE(' + JSON.stringify(marker) + '+JSON.stringify(result));' +
      'if(result.exporting)app.activeDocument.saveToOE("psd");' +
      '}catch(e){app.echoToOE(' + JSON.stringify(marker) + '+JSON.stringify({error:String(e)==="UNSAFE_TREE"?"UNSAFE_TREE":"PHOTOPEA_ERROR"}));}})();';
  }

  const messages = {
    NO_DOCUMENT: 'Brak otwartego dokumentu w Photopea.',
    AMBIGUOUS_DOCUMENT: 'Nie można jednoznacznie rozpoznać dokumentu. Otwórz go tylko raz.',
    UNSAFE_TREE: 'Nie można bezpiecznie odczytać drzewa warstw.',
    DOCUMENT_CHANGED: 'Dokument zmienił się od skanowania. Wykonaj ponowny skan.',
    INVALID_SELECTION: 'Nie można potwierdzić wybranych warstw. Wykonaj ponowny skan.',
    RASTERIZE_FAILED: 'Nie udało się potwierdzić całej rasteryzacji. Sprawdź warstwy i Historię Photopea.',
    BUSY: 'Poczekaj, aż Photopea zakończy bieżącą operację.',
    NOT_EMBEDDED: 'Otwórz plugin jako panel w Photopea.',
    TIMEOUT: 'Photopea nie potwierdziła operacji. Sprawdź dokument i Historię.',
    PHOTOPEA_ERROR: 'Photopea zgłosiła błąd. Sprawdź dokument i Historię.'
  };
  function failure(code) {
    return Object.assign(new Error(messages[code] || messages.PHOTOPEA_ERROR), {code});
  }
  let pending = false;
  function request(mode, payload) {
    const host = window.parent, gate = window.ktxSaveToOEGate;
    if (host === window) return Promise.reject(failure('NOT_EMBEDDED'));
    if (pending || gate?.owner || document.getElementById('dot')?.classList.contains('busy') ||
        typeof watermarkStage !== 'undefined' && watermarkStage !== 'idle' ||
        typeof vignetteStage !== 'undefined' && vignetteStage !== 'idle' || window.folderizeBusy)
      return Promise.reject(failure('BUSY'));
    pending = true;
    if (gate) gate.owner = 'rasterize';
    const buttons = mode === 'scan' ? [] :
      Array.from(document.querySelectorAll('button'), button => ({button, disabled: button.disabled}));
    for (const {button} of buttons) button.disabled = true;
    const marker = prefix + window.crypto.randomUUID() + '|';
    return new Promise((resolve, reject) => {
      let reply, buffer;
      function cleanup() {
        window.clearTimeout(timer);
        window.removeEventListener('message', receive);
        pending = false;
        for (const {button, disabled} of buttons) button.disabled = disabled;
        if (gate?.owner === 'rasterize') {
          gate.owner = null;
          for (const queued of gate.queue.splice(0)) window.postScript(queued);
        }
      }
      function receive(event) {
        if (event.source !== host || event.origin !== origin) return;
        if (typeof event.data === 'string' && event.data.startsWith(marker)) {
          try { reply = JSON.parse(event.data.slice(marker.length)); }
          catch (_) { reply = {error: 'PHOTOPEA_ERROR'}; }
        } else if (reply?.exporting && event.data instanceof ArrayBuffer) {
          if (event.data.byteLength <= psd.maxBytes) buffer = event.data;
        } else if (reply && event.data === 'done') {
          cleanup();
          if (reply.error) reject(failure(reply.error));
          else resolve({reply, buffer});
        }
      }
      // Keep the export gate until Photopea's tagged response and final done;
      // an asynchronous PSD must not reach a subsequent PNG export.
      const timer = window.setTimeout(() => reject(failure('TIMEOUT')), 30000);
      window.addEventListener('message', receive);
      try { host.postMessage(buildScript(marker, mode, payload), origin); }
      catch (_) { cleanup(); reject(failure('PHOTOPEA_ERROR')); }
    });
  }
  function eligible(meta, records) {
    return meta.layers.filter(layer => layer.smart && !layer.group && !layer.locked && records.get(layer.id)?.filterFree)
      .map(({id, name}) => ({id, name}));
  }
  async function readScan() {
    const {reply, buffer} = await request('scan');
    let records = new Map(), digest = null;
    if (buffer) {
      try {
        records = psd.readLayers(buffer);
        const hash = new Uint8Array(await window.crypto.subtle.digest('SHA-256', buffer));
        digest = Array.from(hash).join(',');
      } catch (_) {
        records = new Map();
      }
    }
    return {snapshot: {meta: reply.meta, candidates: eligible(reply.meta, records), digest}, records};
  }
  async function scan() {
    return (await readScan()).snapshot;
  }

  function attachmentsPreserved(before, after) {
    if (!after || before.clipping !== after.clipping || before.blend !== after.blend ||
        before.opacity !== after.opacity || (before.flags & 2) !== (after.flags & 2)) return false;
    function sameBytes(a, b) {
      return !!a === !!b && (!a || a.length === b.length && a.every((byte, i) => byte === b[i]));
    }
    if (!sameBytes(before.mask, after.mask) || !sameBytes(before.blendingRanges, after.blendingRanges)) return false;
    for (const tag of ['lfx2', 'lrFX', 'lmfx', 'lfxs', 'vmsk', 'vsms', 'iOpa', 'clbl', 'infx', 'knko']) {
      if (!sameBytes(before.tags.get(tag), after.tags.get(tag))) return false;
    }
    const beforeMasks = before.channels.filter(channel => channel.id < -1);
    const afterMasks = after.channels.filter(channel => channel.id < -1);
    return beforeMasks.length === afterMasks.length && beforeMasks.every((channel, i) =>
      channel.id === afterMasks[i].id && sameBytes(channel.bytes, afterMasks[i].bytes));
  }

  async function rasterize(snapshot, ids) {
    if (!snapshot?.digest || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !snapshot.candidates.some(row => row.id === id))) throw failure('INVALID_SELECTION');
    const {snapshot: fresh, records: before} = await readScan();
    const verified = fresh.candidates.map(row => row.id);
    if (snapshot.digest !== fresh.digest || JSON.stringify(snapshot.meta) !== JSON.stringify(fresh.meta) ||
        ids.some(id => !verified.includes(id))) throw failure('DOCUMENT_CHANGED');
    const {reply, buffer} = await request('apply', {meta: fresh.meta, ids, verified});
    try {
      if (!buffer || reply.count !== ids.length) throw failure('RASTERIZE_FAILED');
      const after = psd.readLayers(buffer);
      if (before.size !== after.size) throw failure('RASTERIZE_FAILED');
      for (const [id, record] of before) {
        const current = after.get(id);
        if (!attachmentsPreserved(record, current)) throw failure('RASTERIZE_FAILED');
        if (ids.includes(id) && ['SoLd', 'SoLE', 'PlLd', 'plLd'].some(tag => current.tags.has(tag))) {
          throw failure('RASTERIZE_FAILED');
        }
      }
    } catch (_) {
      throw failure('RASTERIZE_FAILED');
    }
    return reply.count;
  }
  return Object.freeze({buildScript, eligible, attachmentsPreserved, scan, rasterize});
});
