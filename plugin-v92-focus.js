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
    if (currentRequest.settleTimer) clearTimeout(currentRequest.settleTimer);
    if (currentRequest.incompleteTimer) clearTimeout(currentRequest.incompleteTimer);
    currentRequest = null;
    lockPanel(false);
    releaseGate('focus');
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
    settleRequest(currentRequest && currentRequest.done ? 0 : 350);
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
    // The ArrayBuffer is the actual result. Some Photopea/plugin contexts do
    // not forward the trailing "done", so it must not be required for success.
    // Keep the binary gate briefly to consume done when it is delivered.
    settleRequest(request.done ? 0 : 350);
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
    currentRequest = {id: id, meta: null, buffer: null, error: '', done: false, rendered: false,
      timeoutTimer: null, settleTimer: null, incompleteTimer: null};
    gate.owner = 'focus';
    gate.externalBufferSeen = false;
    gate.externalErrorSeen = false;
    lockPanel(true);
    setFocusStatus('Pobieram aktualny obraz dokumentu…');

    currentRequest.timeoutTimer = setTimeout(function () {
      if (!currentRequest || currentRequest.id !== id) return;
      var reason = currentRequest.meta && !currentRequest.buffer ? 'Odczytano dokument, ale Photopea nie zwróciła obrazu PNG.' :
        currentRequest.buffer && !currentRequest.meta ? 'Photopea zwróciła obraz, ale nie zwróciła nazwy i wymiarów dokumentu.' :
        'Photopea nie odpowiedziała na polecenie pobrania podglądu.';
      failCapture(reason);
    }, 60000);

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
      currentRequest.buffer = buffer;
      if (!currentRequest.meta) setFocusStatus('Odebrano obraz PNG. Czekam na nazwę i wymiary dokumentu…');
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
        if (!currentRequest.buffer) setFocusStatus('Odczytano ' + currentRequest.meta.name + ' • ' + currentRequest.meta.width + ' × ' + currentRequest.meta.height + ' px. Czekam na obraz PNG…');
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
      if (currentRequest.error || currentRequest.meta && currentRequest.buffer) {
        finishCapture();
        settleRequest(0);
      } else if (!currentRequest.incompleteTimer) {
        // A transferred buffer can be dispatched directly after done.
        var waitingId = currentRequest.id;
        currentRequest.incompleteTimer = setTimeout(function () {
          if (currentRequest && currentRequest.id === waitingId && currentRequest.done && (!currentRequest.meta || !currentRequest.buffer)) {
            failCapture('Photopea zakończyła operację, ale nie zwróciła kompletnego podglądu.');
          }
        }, 1500);
      }
    }
  }, true);

  captureButton.addEventListener('click', capturePreview);
  window.addEventListener('beforeunload', function () {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  });
})();
