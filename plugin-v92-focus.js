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
    if (currentRequest.timer) clearTimeout(currentRequest.timer);
    currentRequest = null;
    lockPanel(false);
    releaseGate('focus');
  }

  function failCapture(reason) {
    clearRequest();
    setFocusStatus(reason || 'Nie udało się pobrać podglądu.', 'error');
  }

  function finishCapture() {
    if (!currentRequest || !currentRequest.done) return;
    if (currentRequest.error) {
      failCapture(currentRequest.error);
      return;
    }
    if (!currentRequest.meta || !currentRequest.buffer) return;

    var request = currentRequest;
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
    clearRequest();
    setFocusStatus('Podgląd pobrany. Możesz zmienić projekt i odświeżyć go ponownie.', 'ok');
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
    currentRequest = {id: id, meta: null, buffer: null, error: '', done: false, timer: null};
    gate.owner = 'focus';
    gate.externalBufferSeen = false;
    gate.externalErrorSeen = false;
    lockPanel(true);
    setFocusStatus('Pobieram aktualny obraz dokumentu…');

    currentRequest.timer = setTimeout(function () {
      if (currentRequest && currentRequest.id === id) failCapture('Photopea nie zwróciła podglądu w wymaganym czasie.');
    }, 20000);

    var token = JSON.stringify(id);
    var script = '(function(){try{var d=app.activeDocument;if(!d)throw new Error("Brak otwartego dokumentu");' +
      'function px(v){try{return Math.round(v.as("px"))}catch(e){}try{return Math.round(v.value)}catch(e2){}return Math.round(Number(v))}' +
      'var m={name:String(d.name||"Bez nazwy"),width:px(d.width),height:px(d.height)};' +
      'app.echoToOE("KTX_FOCUS_META|"+' + token + '+"|"+JSON.stringify(m));d.saveToOE("png")}' +
      'catch(e){app.echoToOE("KTX_FOCUS_ERROR|"+' + token + '+"|"+(e&&e.message?e.message:e.toString()))}})();';

    // Bypass the wrapper only for the request which currently owns the gate.
    originalPostScript(script);
  }

  window.addEventListener('message', function (event) {
    var buffer = arrayBufferFrom(event.data);

    if (gate.owner === 'external') {
      if (event.source === window.parent && buffer) gate.externalBufferSeen = true;
      else if (event.source === window.parent && typeof event.data === 'string' && event.data.indexOf('KTX_ASSET_EXPORT_ERR|') === 0) gate.externalErrorSeen = true;
      else if (event.source === window.parent && event.data === 'done' && (gate.externalBufferSeen || gate.externalErrorSeen)) {
        releaseGate('external');
      }
      return;
    }

    if (gate.owner !== 'focus' || !currentRequest || event.source !== window.parent) return;

    if (buffer) {
      event.stopImmediatePropagation();
      currentRequest.buffer = buffer;
      finishCapture();
      return;
    }

    if (typeof event.data !== 'string') return;
    var metaPrefix = 'KTX_FOCUS_META|' + currentRequest.id + '|';
    var errorPrefix = 'KTX_FOCUS_ERROR|' + currentRequest.id + '|';

    if (event.data.indexOf(metaPrefix) === 0) {
      event.stopImmediatePropagation();
      try {
        currentRequest.meta = JSON.parse(event.data.substring(metaPrefix.length));
      } catch (_) {
        currentRequest.error = 'Nie udało się odczytać nazwy i wymiarów dokumentu.';
      }
      finishCapture();
      return;
    }
    if (event.data.indexOf(errorPrefix) === 0) {
      event.stopImmediatePropagation();
      currentRequest.error = event.data.substring(errorPrefix.length) || 'Nie udało się pobrać dokumentu.';
      finishCapture();
      return;
    }
    if (event.data === 'done' && (currentRequest.meta || currentRequest.error || currentRequest.buffer)) {
      event.stopImmediatePropagation();
      currentRequest.done = true;
      if (!currentRequest.error && (!currentRequest.meta || !currentRequest.buffer)) {
        // Some browsers can deliver the transferred buffer directly after done.
        var waitingId = currentRequest.id;
        setTimeout(function () {
          if (currentRequest && currentRequest.id === waitingId && currentRequest.done && (!currentRequest.meta || !currentRequest.buffer)) {
            failCapture('Photopea zakończyła operację, ale nie zwróciła kompletnego podglądu.');
          }
        }, 750);
      }
      finishCapture();
    }
  }, true);

  captureButton.addEventListener('click', capturePreview);
  window.addEventListener('beforeunload', function () {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  });
})();
