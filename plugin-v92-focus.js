(function () {
  'use strict';

  var captureButton = document.getElementById('focusCapture');
  var previewBox = document.getElementById('focusPreview');
  var previewImage = document.getElementById('focusPreviewImage');
  var metaLabel = document.getElementById('focusMeta');
  var statusLabel = document.getElementById('focusStatus');
  if (!captureButton || !previewBox || !previewImage || !metaLabel || !statusLabel || typeof window.postScript !== 'function') return;

  var originalPostScript = window.postScript;
  var currentRequest = null;
  var currentObjectUrl = '';
  var disabledButtons = [];
  var SAVE_TO_OE = /\bsaveToOE\s*\(/;

  // saveToOE returns an untagged ArrayBuffer. This small gate serializes every
  // binary export without changing ASSETS. While FOCUS POINT owns the gate,
  // scripts requested by other features are held and replayed in order.
  var gate = window.ktxSaveToOEGate || {
    owner: null,
    externalBufferSeen: false,
    externalErrorSeen: false,
    queue: []
  };
  window.ktxSaveToOEGate = gate;

  function runQueuedScripts() {
    while (!gate.owner && gate.queue.length) {
      var script = gate.queue.shift();
      if (SAVE_TO_OE.test(script)) {
        gate.owner = 'external';
        gate.externalBufferSeen = false;
        gate.externalErrorSeen = false;
      }
      originalPostScript(script);
      if (gate.owner) break;
    }
  }

  window.postScript = function (script) {
    script = String(script == null ? '' : script);
    if (gate.owner === 'focus') {
      gate.queue.push(script);
      return;
    }
    if (SAVE_TO_OE.test(script)) {
      if (gate.owner) {
        gate.queue.push(script);
        return;
      }
      gate.owner = 'external';
      gate.externalBufferSeen = false;
      gate.externalErrorSeen = false;
    }
    return originalPostScript(script);
  };

  function releaseGate(owner) {
    if (gate.owner !== owner) return;
    gate.owner = null;
    gate.externalBufferSeen = false;
    gate.externalErrorSeen = false;
    runQueuedScripts();
  }

  function setFocusStatus(text, mode) {
    statusLabel.textContent = text || '';
    statusLabel.className = 'focus-status' + (mode ? ' ' + mode : '');
  }

  function lockPanel(locked) {
    if (locked) {
      disabledButtons = Array.prototype.map.call(document.querySelectorAll('button'), function (button) {
        var entry = {button: button, disabled: button.disabled};
        button.disabled = true;
        return entry;
      });
      return;
    }
    disabledButtons.forEach(function (entry) { entry.button.disabled = entry.disabled; });
    disabledButtons = [];
  }

  function clearRequest() {
    if (!currentRequest) return;
    if (currentRequest.timeoutTimer) clearTimeout(currentRequest.timeoutTimer);
    if (currentRequest.nextStepTimer) clearTimeout(currentRequest.nextStepTimer);
    if (currentRequest.settleTimer) clearTimeout(currentRequest.settleTimer);
    currentRequest = null;
    lockPanel(false);
    releaseGate('focus');
  }

  function armTimeout(id, delay, message) {
    if (!currentRequest || currentRequest.id !== id) return;
    if (currentRequest.timeoutTimer) clearTimeout(currentRequest.timeoutTimer);
    currentRequest.timeoutTimer = setTimeout(function () {
      if (!currentRequest || currentRequest.id !== id) return;
      failCapture(message);
    }, delay);
  }

  function sendFocusScript(id, script) {
    if (!currentRequest || currentRequest.id !== id || gate.owner !== 'focus') return;
    // The focus request already owns the binary-export gate. Calling the
    // original sender prevents this internal step from being queued by it.
    originalPostScript.call(window, script);
  }

  function scheduleFocusScript(id, script) {
    if (!currentRequest || currentRequest.id !== id) return;
    if (currentRequest.nextStepTimer) clearTimeout(currentRequest.nextStepTimer);
    currentRequest.nextStepTimer = setTimeout(function () {
      if (!currentRequest || currentRequest.id !== id) return;
      currentRequest.nextStepTimer = null;
      sendFocusScript(id, script);
    }, 0);
  }

  function settleRequest(delay) {
    if (!currentRequest) return;
    if (currentRequest.timeoutTimer) {
      clearTimeout(currentRequest.timeoutTimer);
      currentRequest.timeoutTimer = null;
    }
    if (currentRequest.settleTimer) clearTimeout(currentRequest.settleTimer);
    currentRequest.settleTimer = setTimeout(clearRequest, delay || 0);
  }

  function failCapture(reason) {
    setFocusStatus(reason || 'Nie udało się pobrać podglądu.', 'error');
    settleRequest(350);
  }

  function finishCapture() {
    if (!currentRequest) return;
    if (currentRequest.error) {
      failCapture(currentRequest.error);
      return;
    }
    if (!currentRequest.meta || !currentRequest.buffer || currentRequest.rendered) return;

    var request = currentRequest;
    request.rendered = true;
    var blob = new Blob([request.buffer], {type: 'image/png'});
    var nextUrl = URL.createObjectURL(blob);
    var previousUrl = currentObjectUrl;
    currentObjectUrl = nextUrl;

    previewImage.onload = function () {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      previewImage.onload = null;
      previewImage.onerror = null;
    };
    previewImage.onerror = function () {
      URL.revokeObjectURL(nextUrl);
      currentObjectUrl = previousUrl;
      if (previousUrl) previewImage.src = previousUrl;
      failCapture('Photopea zwróciła PNG, ale nie udało się wyświetlić podglądu.');
    };
    previewImage.src = nextUrl;
    previewImage.alt = 'Podgląd dokumentu ' + request.meta.name;
    previewBox.hidden = false;
    metaLabel.textContent = request.meta.name + ' • ' + request.meta.width + ' × ' + request.meta.height + ' px';
    captureButton.textContent = 'ODŚWIEŻ PODGLĄD';
    setFocusStatus('Podgląd pobrany. Możesz zmienić projekt i odświeżyć go ponownie.', 'ok');
    // The ArrayBuffer is the actual result. A trailing "done" is optional and
    // is consumed during this short grace period so other receivers do not
    // mistake it for the completion of their own operation.
    settleRequest(350);
  }

  function arrayBufferFrom(value) {
    if (value instanceof ArrayBuffer) return value;
    if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return null;
  }

  function busyOutsideFocus() {
    var dot = document.getElementById('dot');
    return gate.owner || dot && dot.classList.contains('busy') ||
      typeof window.vignetteStage !== 'undefined' && window.vignetteStage !== 'idle' ||
      typeof window.watermarkStage !== 'undefined' && window.watermarkStage !== 'idle' ||
      !!window.folderizeBusy;
  }

  function capturePreview() {
    if (currentRequest) return;
    if (busyOutsideFocus()) {
      setFocusStatus('Poczekaj, aż Photopea zakończy obecne działanie lub eksport.', 'error');
      return;
    }

    var id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    currentRequest = {id: id, phase: 'ping', meta: null, buffer: null, error: '', rendered: false,
      timeoutTimer: null, nextStepTimer: null, settleTimer: null};
    gate.owner = 'focus';
    gate.externalBufferSeen = false;
    gate.externalErrorSeen = false;
    lockPanel(true);
    setFocusStatus('Sprawdzam połączenie z Photopea…');
    armTimeout(id, 10000, 'Photopea nie wykonała nawet testu połączenia z pluginem.');

    var token = JSON.stringify(id);
    // Keep this first command deliberately tiny. If it works, metadata and the
    // untagged binary export are requested in two separate operations.
    sendFocusScript(id, 'app.echoToOE("KTX_FOCUS_PING|"+' + token + ');');
  }

  window.addEventListener('message', function (event) {
    var buffer = arrayBufferFrom(event.data);

    if (gate.owner === 'external') {
      if (buffer) gate.externalBufferSeen = true;
      else if (typeof event.data === 'string' && event.data.indexOf('KTX_ASSET_EXPORT_ERR|') === 0) gate.externalErrorSeen = true;
      else if (event.data === 'done' && (gate.externalBufferSeen || gate.externalErrorSeen)) {
        releaseGate('external');
      }
      return;
    }

    // Photopea desktop / PWA builds do not always expose the sender as
    // window.parent. Identity is instead guaranteed by the exclusive binary
    // gate and the unpredictable request token in every textual response.
    if (gate.owner !== 'focus' || !currentRequest) return;

    if (buffer) {
      event.stopImmediatePropagation();
      if (currentRequest.phase !== 'export') return;
      currentRequest.buffer = buffer;
      finishCapture();
      return;
    }

    if (typeof event.data !== 'string') return;
    var pingMessage = 'KTX_FOCUS_PING|' + currentRequest.id;
    var metaPrefix = 'KTX_FOCUS_META|' + currentRequest.id + '|';
    var errorPrefix = 'KTX_FOCUS_ERROR|' + currentRequest.id + '|';

    if (event.data === pingMessage && currentRequest.phase === 'ping') {
      event.stopImmediatePropagation();
      var pingId = currentRequest.id;
      var pingToken = JSON.stringify(pingId);
      currentRequest.phase = 'meta';
      setFocusStatus('Połączenie działa. Odczytuję nazwę i wymiary dokumentu…');
      armTimeout(pingId, 10000, 'Połączenie działa, ale Photopea nie zwróciła danych dokumentu.');
      scheduleFocusScript(pingId,
        'try{var ktxd=app.activeDocument;if(!ktxd)throw new Error("Brak otwartego dokumentu");' +
        'var ktxm={name:String(ktxd.name||"Bez nazwy"),width:String(ktxd.width),height:String(ktxd.height)};' +
        'app.echoToOE("KTX_FOCUS_META|"+' + pingToken + '+"|"+JSON.stringify(ktxm));}' +
        'catch(ktxe){app.echoToOE("KTX_FOCUS_ERROR|"+' + pingToken + '+"|"+(ktxe&&ktxe.message?ktxe.message:String(ktxe)));}');
      return;
    }

    if (event.data.indexOf(metaPrefix) === 0 && currentRequest.phase === 'meta') {
      event.stopImmediatePropagation();
      try {
        currentRequest.meta = JSON.parse(event.data.substring(metaPrefix.length));
        currentRequest.meta.width = Math.round(parseFloat(currentRequest.meta.width)) || '?';
        currentRequest.meta.height = Math.round(parseFloat(currentRequest.meta.height)) || '?';
      } catch (_) {
        failCapture('Nie udało się odczytać nazwy i wymiarów dokumentu.');
        return;
      }
      var exportId = currentRequest.id;
      var exportToken = JSON.stringify(exportId);
      currentRequest.phase = 'export';
      setFocusStatus('Odczytano ' + currentRequest.meta.name + ' • ' + currentRequest.meta.width + ' × ' + currentRequest.meta.height + ' px. Eksportuję PNG…');
      armTimeout(exportId, 60000, 'Połączenie działa i dokument został odczytany, ale Photopea nie zwróciła obrazu PNG.');
      scheduleFocusScript(exportId,
        'try{var ktxd=app.activeDocument;if(!ktxd)throw new Error("Brak otwartego dokumentu");ktxd.saveToOE("png");}' +
        'catch(ktxe){app.echoToOE("KTX_FOCUS_ERROR|"+' + exportToken + '+"|"+(ktxe&&ktxe.message?ktxe.message:String(ktxe)));}');
      return;
    }
    if (event.data.indexOf(errorPrefix) === 0) {
      event.stopImmediatePropagation();
      var detail = event.data.substring(errorPrefix.length) || 'Nie udało się pobrać dokumentu.';
      if (/brak otwartego dokumentu/i.test(detail)) detail = 'Nie masz otwartego dokumentu w Photopea.';
      failCapture(detail);
      return;
    }
    if (event.data === 'done') {
      // Every script may emit its own trailing done. The focus protocol moves
      // between phases only after its tagged messages / ArrayBuffer, never on
      // an ambiguous done shared by every Photopea operation.
      event.stopImmediatePropagation();
    }
  }, true);

  captureButton.addEventListener('click', capturePreview);
  window.addEventListener('beforeunload', function () {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  });
})();
