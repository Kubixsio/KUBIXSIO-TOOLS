(function () {
  'use strict';
  var contract = window.ktxAiReviewContract;
  var DB_NAME = 'kubixsio-ai-review-v1', SESSION_KEY = 'kubixsio-ai-review-tab-v1';
  var database, sessionId, initialization, writes = Promise.resolve(), persistenceReady = false;
  var state = emptyState(), listeners = [], captureJob = null;
  var originalPostScript = window.postScript;
  var gate = window.ktxSaveToOEGate || {owner: null, externalBufferSeen: false, externalErrorSeen: false, queue: []};
  window.ktxSaveToOEGate = gate;
  var SAVE_TO_OE = /\bsaveToOE\s*\(/;

  function emptyState() {
    return {version: 1, meta: null, previewPng: null, reviewedPreviewPng: null,
      previousPreviewPng: null, notes: '', reviewResult: null, previousReview: null,
      improvements: [], discardedImprovements: [], previewRevision: 0, lastUpdated: null};
  }
  function clone(value) { return structuredClone(value); }
  function emit() { listeners.forEach(function (listener) { listener(clone(state)); }); }
  function transaction(storeName, mode, operation) {
    return new Promise(function (resolve, reject) {
      var tx = database.transaction(storeName, mode), result;
      var request = operation(tx.objectStore(storeName));
      if (request) request.onsuccess = function () { result = request.result; };
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Nie udało się zapisać danych lokalnie.')); };
    });
  }
  function initialize() {
    if (initialization) return initialization;
    initialization = (async function () {
      try {
        sessionId = sessionStorage.getItem(SESSION_KEY);
        if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId)) {
          sessionId = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, sessionId);
        }
        database = await new Promise(function (resolve, reject) {
          var request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = function () {
            request.result.createObjectStore('sessions', {keyPath: 'sessionId'});
            request.result.createObjectStore('settings');
          };
          request.onsuccess = function () { resolve(request.result); };
          request.onerror = request.onblocked = function () { reject(new Error('IndexedDB jest niedostępne.')); };
        });
        database.onversionchange = function () { database.close(); persistenceReady = false; };
        persistenceReady = true;
      } catch (_) { persistenceReady = false; }
      return {ready: persistenceReady};
    })();
    return initialization;
  }
  function enqueue(operation) {
    var next = writes.then(async function () {
      await initialize();
      if (!persistenceReady) throw new Error('Zapis lokalny jest niedostępny.');
      return operation();
    });
    writes = next.catch(function () {}); return next;
  }
  function persist() {
    state.lastUpdated = new Date().toISOString();
    var snapshot = clone(state);
    return enqueue(function () { return transaction('sessions', 'readwrite', function (store) {
      return store.put({sessionId: sessionId, snapshot: snapshot});
    }); });
  }
  async function loadForDocument(meta) {
    await initialize();
    if (!persistenceReady) return null;
    await writes;
    var record = await transaction('sessions', 'readonly', function (store) { return store.get(sessionId); });
    var saved = record && record.snapshot;
    if (!saved || saved.version !== 1 || !saved.meta || saved.meta.documentKey !== meta.documentKey) return null;
    try {
      if (!(saved.previewPng instanceof Blob) || saved.previewPng.type !== 'image/png' ||
          typeof saved.notes !== 'string' || saved.notes.length > 4000 || !Number.isSafeInteger(saved.previewRevision) || saved.previewRevision < 0) return null;
      if (saved.reviewResult) {
        saved.reviewResult = contract.normalizeReview(saved.reviewResult);
        saved.improvements = contract.normalizeImprovements(saved.improvements, saved.reviewResult);
        if (!(saved.reviewedPreviewPng instanceof Blob)) return null;
      } else if (saved.improvements.length) return null;
      if (!Array.isArray(saved.discardedImprovements) || saved.discardedImprovements.length > 100) return null;
      saved.discardedImprovements = saved.discardedImprovements.map(function (item) {
        return Object.assign({}, contract.normalizeReview({score: 0, summary: 'Historia', strengths: [],
          improvements: [withoutStatus(item)]}).improvements[0], {status: 'discarded'});
      });
      return saved;
    } catch (_) { return null; }
  }
  function withoutStatus(item) { var result = Object.assign({}, item); delete result.status; return result; }
  async function acceptPreview(captured) {
    if (!state.meta || state.meta.documentKey !== captured.meta.documentKey) {
      state = await loadForDocument(captured.meta) || emptyState();
    }
    state.meta = captured.meta; state.previewPng = captured.png; state.previewRevision++;
    emit(); await persist(); return clone(state);
  }
  function setNotes(notes) { state.notes = String(notes).slice(0, 4000); emit(); return persist(); }
  function setImprovementStatus(id, status) {
    if (!contract.statuses.includes(status)) throw new Error('Niepoprawny status.');
    var item = state.improvements.find(function (entry) { return entry.id === id; });
    if (!item) throw new Error('Nie znaleziono poprawki.');
    item.status = status;
    state.discardedImprovements = state.discardedImprovements.filter(function (entry) { return entry.issueKey !== item.issueKey; });
    if (status === 'discarded') state.discardedImprovements.push(clone(item));
    if (state.discardedImprovements.length > 100) state.discardedImprovements.shift();
    emit(); return persist();
  }
  function acceptReview(result, captured, notes) {
    var normalized = contract.normalizeReview(result);
    if (!state.meta || captured.meta.documentKey !== state.meta.documentKey) throw new Error('Dokument zmienił się podczas analizy.');
    state.previousReview = state.reviewResult ? {result: clone(state.reviewResult), improvements: clone(state.improvements)} : null;
    state.previousPreviewPng = state.reviewedPreviewPng;
    state.reviewResult = normalized; state.reviewedPreviewPng = captured.png;
    state.improvements = normalized.improvements.map(function (item) { return Object.assign({}, item, {status: 'pending'}); });
    state.notes = notes; emit(); return persist();
  }
  function getAccessKey() {
    return enqueue(function () { return transaction('settings', 'readonly', function (store) { return store.get('accessKey'); }); });
  }
  function setAccessKey(key) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(key)) return Promise.reject(new Error('Klucz musi mieć 32–512 znaków, bez spacji.'));
    return enqueue(function () { return transaction('settings', 'readwrite', function (store) { return store.put(key, 'accessKey'); }); });
  }

  // Photopea returns untagged binary exports. Keep the shared export gate so
  // ASSETS continues using its existing code and never receives a review PNG.
  function runQueuedScripts() {
    while (!gate.owner && gate.queue.length) {
      var script = gate.queue.shift();
      if (SAVE_TO_OE.test(script)) { gate.owner = 'external'; gate.externalBufferSeen = gate.externalErrorSeen = false; }
      originalPostScript(script); if (gate.owner) break;
    }
  }
  function releaseGate(owner) {
    if (gate.owner !== owner) return;
    gate.owner = null; gate.externalBufferSeen = gate.externalErrorSeen = false; runQueuedScripts();
  }
  window.postScript = function (script) {
    script = String(script == null ? '' : script);
    if (gate.owner === 'ai-review' || SAVE_TO_OE.test(script) && gate.owner) { gate.queue.push(script); return; }
    if (SAVE_TO_OE.test(script)) { gate.owner = 'external'; gate.externalBufferSeen = gate.externalErrorSeen = false; }
    return originalPostScript(script);
  };
  function finishCapture(error, result) {
    var job = captureJob; if (!job || job.finishing) return;
    job.finishing = true; clearTimeout(job.timer);
    setTimeout(function () {
      if (captureJob !== job) return;
      captureJob = null;
      job.buttons.forEach(function (entry) { entry.button.disabled = entry.disabled; });
      releaseGate('ai-review');
      if (error) job.reject(error); else job.resolve(result);
    }, 350);
  }
  function armTimeout(message, delay) {
    clearTimeout(captureJob.timer);
    captureJob.timer = setTimeout(function () { finishCapture(new Error(message)); }, delay);
  }
  function send(script) {
    var job = captureJob;
    setTimeout(function () { if (captureJob === job && !job.finishing) originalPostScript(script); }, 0);
  }
  function documentMetadataScript(id) {
    return 'try{var d=app.activeDocument;if(!d)throw new Error("Brak otwartego dokumentu w Photopea.");' +
      'var entries=window.ktxAiReviewDocuments||(window.ktxAiReviewDocuments=[]);' +
      'for(var i=entries.length-1;i>=0;i--){var found=false;for(var j=0;j<app.documents.length;j++)if(entries[i].document===app.documents[j])found=true;if(!found)entries.splice(i,1);}' +
      'var key=null;for(var i=0;i<entries.length;i++)if(entries[i].document===d)key=entries[i].key;' +
      'if(!key){key="review:"+' + JSON.stringify(id) + ';entries.push({document:d,key:key});}' +
      'function px(v){try{return v.as("px")}catch(_){}return Number(v)}' +
      'app.echoToOE("KTX_AI_META|"+' + JSON.stringify(id) + '+"|"+JSON.stringify({name:String(d.name||"Bez nazwy"),width:Math.round(px(d.width)),height:Math.round(px(d.height)),documentKey:key}));' +
      '}catch(e){app.echoToOE("KTX_AI_ERROR|"+' + JSON.stringify(id) + '+"|"+String(e.message||e));}';
  }
  function capture(options) {
    options = options || {};
    var dot = document.getElementById('dot');
    if (captureJob || gate.owner || dot && dot.classList.contains('busy') ||
        typeof vignetteStage !== 'undefined' && vignetteStage !== 'idle' ||
        typeof watermarkStage !== 'undefined' && watermarkStage !== 'idle' || window.folderizeBusy)
      return Promise.reject(new Error('Poczekaj, aż Photopea zakończy obecne działanie lub eksport.'));
    if (window.parent === window) return Promise.reject(new Error('Otwórz plugin jako panel w Photopea.'));
    return new Promise(function (resolve, reject) {
      var id = crypto.randomUUID();
      captureJob = {id: id, phase: 'ping', meta: null, resolve: resolve, reject: reject,
        metadataOnly: !!options.metadataOnly, onStatus: options.onStatus || function () {}, buttons: []};
      gate.owner = 'ai-review';
      captureJob.buttons = Array.from(document.querySelectorAll('button')).map(function (button) {
        var entry = {button: button, disabled: button.disabled}; button.disabled = true; return entry;
      });
      armTimeout('Photopea nie odpowiedziała. Spróbuj odświeżyć podgląd.', 10000);
      send('app.echoToOE("KTX_AI_PING|"+' + JSON.stringify(id) + ');');
    });
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    var buffer = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
    if (gate.owner === 'external') {
      if (buffer) gate.externalBufferSeen = true;
      else if (typeof data === 'string' && data.indexOf('KTX_ASSET_EXPORT_ERR|') === 0) gate.externalErrorSeen = true;
      else if (data === 'done' && (gate.externalBufferSeen || gate.externalErrorSeen)) releaseGate('external');
      return;
    }
    var job = captureJob;
    if (gate.owner !== 'ai-review' || !job) return;
    if (job.finishing) { if (data === 'done' || buffer) event.stopImmediatePropagation(); return; }
    if (data === 'KTX_AI_PING|' + job.id && job.phase === 'ping') {
      event.stopImmediatePropagation(); job.source = event.source; job.origin = event.origin;
      job.phase = 'meta'; armTimeout('Photopea nie zwróciła danych dokumentu.', 10000);
      send(documentMetadataScript(job.id)); return;
    }
    if (job.phase === 'ping' || event.source !== job.source || event.origin !== job.origin) return;
    if (buffer && job.phase === 'export') {
      event.stopImmediatePropagation();
      var bytes = new Uint8Array(buffer);
      if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71)
        { finishCapture(new Error('Photopea zwróciła niepoprawny PNG.')); return; }
      var view = new DataView(buffer);
      if (view.getUint32(16) !== job.meta.width || view.getUint32(20) !== job.meta.height)
        { finishCapture(new Error('Wymiary PNG nie pasują do dokumentu. Odśwież podgląd.')); return; }
      finishCapture(null, {meta: job.meta, png: new Blob([buffer], {type: 'image/png'})}); return;
    }
    if (typeof data !== 'string') return;
    var metaPrefix = 'KTX_AI_META|' + job.id + '|', errorPrefix = 'KTX_AI_ERROR|' + job.id + '|';
    if (data.indexOf(errorPrefix) === 0) {
      event.stopImmediatePropagation(); finishCapture(new Error(data.slice(errorPrefix.length))); return;
    }
    if (data.indexOf(metaPrefix) === 0 && job.phase === 'meta') {
      event.stopImmediatePropagation();
      try {
        job.meta = JSON.parse(data.slice(metaPrefix.length));
        if (!Number.isSafeInteger(job.meta.width) || job.meta.width <= 0 || !Number.isSafeInteger(job.meta.height) || job.meta.height <= 0 ||
            typeof job.meta.documentKey !== 'string' || !/^review:[a-f0-9-]{36}$/.test(job.meta.documentKey)) throw new Error();
      } catch (_) { finishCapture(new Error('Niepoprawne dane dokumentu.')); return; }
      if (job.metadataOnly) { finishCapture(null, {meta: job.meta}); return; }
      job.phase = 'export'; job.onStatus('Pobieranie podglądu...');
      armTimeout('Photopea nie zwróciła PNG. Spróbuj odświeżyć podgląd.', 60000);
      send('try{var entries=window.ktxAiReviewDocuments||[],d=app.activeDocument,key=null;for(var i=0;i<entries.length;i++)if(entries[i].document===d)key=entries[i].key;' +
        'if(key!==' + JSON.stringify(job.meta.documentKey) + ')throw new Error("Dokument zmienił się podczas pobierania.");d.saveToOE("png");}' +
        'catch(e){app.echoToOE("KTX_AI_ERROR|"+' + JSON.stringify(job.id) + '+"|"+String(e.message||e));}'); return;
    }
    if (data === 'done') event.stopImmediatePropagation();
  }, true);
  window.ktxAiReviewSession = Object.freeze({initialize: initialize, capture: capture, acceptPreview: acceptPreview,
    getState: function () { return clone(state); }, subscribe: function (listener) { listeners.push(listener); },
    setNotes: setNotes, setImprovementStatus: setImprovementStatus, acceptReview: acceptReview,
    getAccessKey: getAccessKey, setAccessKey: setAccessKey});
})();
