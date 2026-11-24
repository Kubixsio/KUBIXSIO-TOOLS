(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ktxCompositionLines = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const origin = 'https://www.photopea.com', prefix = 'KTX_COMPOSITION_LINES|';
  const style = Object.freeze({color:'7DDFFF', opacity:35, thickness:2,
    names:{cross:'LINIE POMOCNICZE — KRZYŻ', grid:'LINIE POMOCNICZE — SIATKA'}});

  function geometry(width, height, mode) {
    if (mode !== 'cross' && mode !== 'grid') throw 'INVALID_MODE';
    if (!isFinite(width) || !isFinite(height) || width < 2 || height < 2 ||
        Math.floor(width) !== width || Math.floor(height) !== height) throw 'INVALID_SIZE';
    var fractions = mode === 'cross' ? [0.5] : [1/3, 2/3], rectangles = [];
    for (var i = 0; i < fractions.length; i++) {
      var x = Math.max(0, Math.min(width - 2, Math.round(width * fractions[i] - 1)));
      rectangles.push([x, 0, x + 2, height]);
    }
    for (var j = 0; j < fractions.length; j++) {
      var y = Math.max(0, Math.min(height - 2, Math.round(height * fractions[j] - 1)));
      rectangles.push([0, y, width, y + 2]);
    }
    return rectangles;
  }

  // One synchronous native operation, starting only after DODAJ LINIE.
  function operate(mode, token, settings) {
    function px(value) {
      if (value && typeof value === 'object') value = value.as('px');
      return +value;
    }
    if (!app.documents.length) return {error:'NO_DOCUMENT'};
    if (mode !== 'cross' && mode !== 'grid') return {error:'INVALID_MODE'};
    var doc = app.activeDocument, width = px(doc.width), height = px(doc.height);
    var layerName = mode === 'cross' ? settings.names.cross : settings.names.grid;
    var rectangles = geometry(width, height, mode), before = [], previous = [], walked = 0;
    function collect(layers, depth, records) {
      if (depth > 64) throw 'UNSAFE_TREE';
      for (var i = 0; i < layers.length; i++) {
        if (++walked > 3000) throw 'UNSAFE_TREE';
        var layer = layers[i], id = +layer.id;
        if (!isFinite(id) || before.indexOf(id) !== -1 && records === before) throw 'UNSAFE_TREE';
        records.push(id);
        if (records === before && layer.typename === 'ArtLayer' && layer.kind === LayerKind.NORMAL &&
            !layer.isBackgroundLayer && (layer.name === settings.names.cross || layer.name === settings.names.grid)) {
          previous.push({id:id, locked:layer.allLocked === true});
        }
        if (layer.typename === 'LayerSet') collect(layer.layers, depth + 1, records);
      }
    }
    function select(id) {
      var chosen = null;
      function locate(layers, path) {
        for (var i = 0; i < layers.length; i++) {
          var next = path.concat([i]);
          if (+layers[i].id === id) chosen = next;
          else if (layers[i].typename === 'LayerSet') locate(layers[i].layers, next);
        }
      }
      locate(doc.layers, []);
      if (!chosen) throw 'DOCUMENT_CHANGED';
      // Return only an index path from the recursive walk; native layer wrappers are unstable.
      var layer = doc.layers[chosen[0]];
      for (var n = 1; n < chosen.length; n++) layer = layer.layers[chosen[n]];
      doc.activeLayer = layer;
      if (+doc.activeLayer.id !== id) throw 'VERIFICATION_FAILED';
    }
    function exists(id) {
      var ids = []; walked = 0; collect(doc.layers, 0, ids);
      return ids.indexOf(id) !== -1;
    }
    collect(doc.layers, 0, before);
    var original = doc.activeLayer ? +doc.activeLayer.id : null;
    var createdId = null, result = null, stage = 'draw';
    try {
      var added = doc.artLayers.add(); createdId = +added.id;
      added.name = 'KTX LINES ' + token;
      if (+doc.layers[0].id !== createdId) added.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
      select(createdId);
      var ink = new SolidColor(); ink.rgb.hexValue = settings.color;
      for (var r = 0; r < rectangles.length; r++) {
        var box = rectangles[r];
        doc.selection.select([[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]]);
        doc.selection.fill(ink);
      }
      doc.selection.deselect();
      stage = 'settings';
      if (+doc.layers[0].id !== createdId) added.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
      select(createdId); added = doc.activeLayer;
      added.name = layerName;
      added.opacity = settings.opacity;
      added.blendMode = BlendMode.NORMAL;
      added.allLocked = true;
      var actual = doc.activeLayer;
      if (+doc.layers[0].id !== createdId || actual.name !== layerName ||
          actual.allLocked !== true || Math.abs(+actual.opacity - settings.opacity) > 100/255 ||
          String(actual.blendMode) !== String(BlendMode.NORMAL)) throw 'VERIFICATION_FAILED';
      // Replace only exact reserved names on ordinary pixel layers, after the new layer is ready.
      stage = 'replace';
      for (var p = 0; p < previous.length; p++) {
        select(previous[p].id); var old = doc.activeLayer;
        old.allLocked = false; old.remove();
      }
      select(createdId); actual = doc.activeLayer;
      result = {id:createdId, name:String(actual.name), width:width, height:height,
        opacity:+actual.opacity, locked:actual.allLocked === true, lines:rectangles.length,
        rectangles:rectangles, replaced:previous.length};
    } catch (error) {
      result = {error:'PHOTOPEA_ERROR', stage:stage, detail:String(error)};
      if (createdId !== null) {
        try {if (exists(createdId)) {select(createdId); doc.activeLayer.allLocked = false; doc.activeLayer.remove();}}
        catch (cleanupError) {result.detail += ' | ' + String(cleanupError);}
      }
      for (var q = 0; q < previous.length; q++) {
        try {if (exists(previous[q].id)) {select(previous[q].id); doc.activeLayer.allLocked = previous[q].locked;}}
        catch (lockError) {result.detail += ' | ' + String(lockError);}
      }
    }
    try {
      doc.selection.deselect();
      app.activeDocument = doc;

      if (original !== null && exists(original)) select(original);
      else if (doc.layers.length > 1) doc.activeLayer = doc.layers[1];
    } catch (restoreError) {result = {error:'RESTORE_FAILED', detail:String(restoreError)};}
    return result;
  }
  function buildScript(marker, mode, token) {
    return '(function(){' + geometry.toString() + ';' + operate.toString() +
      ';var result;try{result=operate(' + JSON.stringify(mode) + ',' + JSON.stringify(token) + ',' + JSON.stringify(style) +
      ');}catch(e){result={error:"PHOTOPEA_ERROR",detail:String(e)};}app.echoToOE(' + JSON.stringify(marker) + '+JSON.stringify(result));})();';
  }
  const messages = {NO_DOCUMENT:'Otwórz dokument w Photopea, aby dodać linie.',
    INVALID_MODE:'Wybierz KRZYŻ lub SIATKĘ.', BUSY:'Poczekaj na zakończenie bieżącej operacji Photopea.',
    NOT_EMBEDDED:'Otwórz plugin jako panel w Photopea.', TIMEOUT:'Photopea nie potwierdziła dodania linii. Sprawdź warstwy.',
    PHOTOPEA_ERROR:'Nie udało się dodać linii pomocniczych.', RESTORE_FAILED:'Sprawdź dokument po dodaniu linii.'};
  const failure = (code, detail) => Object.assign(new Error((messages[code] || messages.PHOTOPEA_ERROR) + (detail ? ' ' + detail : '')), {code});
  let pending = false;
  function add(mode) {
    if (mode !== 'cross' && mode !== 'grid') return Promise.reject(failure('INVALID_MODE'));
    const host = window.parent, gate = window.ktxSaveToOEGate;
    if (host === window) return Promise.reject(failure('NOT_EMBEDDED'));
    if (pending || gate?.owner || document.getElementById('dot')?.classList.contains('busy') ||
        typeof watermarkStage !== 'undefined' && watermarkStage !== 'idle' ||
        typeof vignetteStage !== 'undefined' && vignetteStage !== 'idle' || window.folderizeBusy) return Promise.reject(failure('BUSY'));
    pending = true;
    if (gate) gate.owner = 'composition-lines';
    const token = window.crypto.randomUUID(), marker = prefix + token + '|';
    return new Promise((resolve, reject) => {
      let reply = null, settled = false;
      function finish(error, drain = false) {
        if (!drain) {
          window.clearTimeout(timer); window.removeEventListener('message', receive); pending = false;
          if (gate?.owner === 'composition-lines') {
            gate.owner = null;
            for (const script of gate.queue.splice(0)) window.postScript(script);
          }
        }
        if (settled) return; settled = true;
        if (error) reject(error); else resolve(reply);
      }
      function receive(event) {
        if (event.source !== host || event.origin !== origin) return;
        if (settled && event.data === 'done') {finish(null); return;}
        if (typeof event.data === 'string' && event.data.startsWith(marker)) {
          try {reply = JSON.parse(event.data.slice(marker.length));} catch (_) {reply = {error:'PHOTOPEA_ERROR'};}
        } else if (reply && event.data === 'done') finish(reply.error ? failure(reply.error, reply.detail) : null);
      }
      const timer = window.setTimeout(() => finish(failure('TIMEOUT'), true), 20000);
      window.addEventListener('message', receive);
      try {host.postMessage(buildScript(marker, mode, token), origin);} catch (error) {finish(failure('PHOTOPEA_ERROR', String(error)));}
    });
  }
  return Object.freeze({geometry, buildScript, add, style});
});
