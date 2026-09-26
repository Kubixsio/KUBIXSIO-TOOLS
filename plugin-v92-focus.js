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

  // Stage 2: object locations and relative priorities for the complete image.
  // One active document and one completed analysis remain only in memory.
  var stage = document.getElementById('focusStage');
  var overlay = document.getElementById('focusOverlay');
  var editor = document.getElementById('focusEditor');
  var addButton = document.getElementById('focusAdd');
  var pointList = document.getElementById('focusList');
  var emptyList = document.getElementById('focusEmpty');
  var notesInput = document.getElementById('focusNotes');
  var editorStatus = document.getElementById('focusEditorStatus');
  var analysisSettings = document.getElementById('focusAnalysisSettings');
  var analysisModes = analysisSettings.querySelectorAll('input[name="focusAnalysisMode"]');
  var analyzeButton = document.getElementById('focusAnalyze');
  var tokenInput = document.getElementById('focusApiToken');
  var clearTokenButton = document.getElementById('focusClearToken');
  var noChangesButton = document.getElementById('focusDemoNoChanges');
  var analysisStatus = document.getElementById('focusAnalysisStatus');
  var resultsPanel = document.getElementById('focusResults');
  var resultsTitle = document.getElementById('focusResultsTitle');
  var resultSource = document.getElementById('focusResultSource');
  var resultSummary = document.getElementById('focusResultSummary');
  var resultProgress = document.getElementById('focusResultProgress');
  var resultTasks = document.getElementById('focusResultTasks');
  var currentAnalysis = null;
  var analysisSource = '';
  var reviewStates = Object.create(null);
  var reanalyzeButton = document.getElementById('focusReanalyze');
  var lastAnalysisInput = null, lastAnalyzedAt = '';
  var analysisBusy = false, pendingReanalysis = null, previewRevision = 0;
  var testApiToken = '', activeAnalysisRequest = null;
  var ANALYZE_URL = 'https://kubixsio-focus-point.polizaless1.workers.dev/analyze';
  var MAX_ANALYSIS_BYTES = 16 * 1024 * 1024;
  var ANALYSIS_TIMEOUT_MS = 45000;
  var session = null;
  var capturedMeta = null;
  var capturedBlob = null;
  var selectedId = null;
  var drawing = false;
  var gesture = null;
  var handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  var EPSILON = 0.000001;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function findPoint(id) {
    return session && session.points.find(function (point) { return point.id === id; });
  }
  function sortedPoints() {
    return session.points.slice().sort(function (a, b) { return b.weight - a.weight || a.id - b.id; });
  }
  function copyRect(rect) { return {x: rect.x, y: rect.y, width: rect.width, height: rect.height}; }
  function updateEditorControls() {
    editor.disabled = !!currentRequest || !session || analysisBusy;
    overlay.classList.toggle('focus-locked', !!currentRequest || !session || analysisBusy);
    addButton.textContent = drawing ? 'ANULUJ ZAZNACZANIE' : 'DODAJ FOCUS POINT';
    addButton.setAttribute('aria-pressed', String(drawing));
    overlay.classList.toggle('focus-drawing', drawing);
    updateAnalysisControls();
  }
  function positionBox(box, rect) {
    box.style.left = rect.x * 100 + '%';
    box.style.top = rect.y * 100 + '%';
    box.style.width = rect.width * 100 + '%';
    box.style.height = rect.height * 100 + '%';
    box.classList.toggle('focus-label-inside', rect.y < 0.08);
  }
  function renderBoxes() {
    overlay.replaceChildren();
    if (!session) return;
    session.points.forEach(function (point) {
      var box = document.createElement('div');
      box.className = 'focus-rectangle' + (point.id === selectedId ? ' selected' : '');
      box.dataset.focusId = point.id;
      box.setAttribute('aria-label', 'Focus Point ' + point.id + ': ' + point.name);
      positionBox(box, point.rect);
      var label = document.createElement('span');
      label.className = 'focus-rectangle-label';
      label.textContent = '#' + point.id;
      label.title = point.name + ' — waga ' + point.weight;
      box.appendChild(label);
      if (point.id === selectedId) handles.forEach(function (direction) {
        var handle = document.createElement('span');
        handle.className = 'focus-handle focus-handle-' + direction;
        handle.dataset.focusHandle = direction;
        box.appendChild(handle);
      });
      overlay.appendChild(box);
    });
  }
  function selectPoint(id) {
    selectedId = id;
    renderBoxes();
    pointList.querySelectorAll('[data-focus-row]').forEach(function (row) {
      var selected = Number(row.dataset.focusRow) === selectedId;
      row.classList.toggle('selected', selected);
      row.querySelector('.focus-select').setAttribute('aria-pressed', String(selected));
    });
  }
  function renderList() {
    pointList.replaceChildren();
    emptyList.hidden = !!(session && session.points.length);
    if (!session) return;
    sortedPoints().forEach(function (point) {
      var row = document.createElement('li');
      row.className = 'focus-point-row' + (point.id === selectedId ? ' selected' : '');
      row.dataset.focusRow = point.id;
      var select = document.createElement('button');
      select.type = 'button';
      select.className = 'focus-select';
      select.textContent = '#' + point.id + ' · ' + point.name + ' — waga ' + point.weight;
      select.setAttribute('aria-pressed', String(point.id === selectedId));
      select.addEventListener('click', function () { selectPoint(point.id); });
      row.appendChild(select);
      var fields = document.createElement('div');
      fields.className = 'focus-point-fields';
      var nameLabel = document.createElement('label');
      nameLabel.textContent = 'Nazwa';
      var name = document.createElement('input');
      name.type = 'text';
      name.value = point.name;
      name.setAttribute('aria-label', 'Nazwa Focus Point ' + point.id);
      name.addEventListener('focus', function () { selectPoint(point.id); });
      name.addEventListener('input', function () {
        point.name = name.value.trim() || 'Focus Point ' + point.id;
        select.textContent = '#' + point.id + ' · ' + point.name + ' — waga ' + point.weight;
        renderBoxes();
      });
      name.addEventListener('blur', function () { name.value = point.name; });
      nameLabel.appendChild(name);
      fields.appendChild(nameLabel);
      var weightLabel = document.createElement('label');
      weightLabel.textContent = 'Waga';
      var weight = document.createElement('input');
      weight.type = 'number';
      weight.step = 'any';
      weight.value = point.weight;
      weight.setAttribute('aria-label', 'Waga Focus Point ' + point.id);
      weight.addEventListener('focus', function () { selectPoint(point.id); });
      weight.addEventListener('input', function () {
        var value = weight.valueAsNumber;
        var valid = Number.isFinite(value) && value > 0;
        weight.setCustomValidity(valid ? '' : 'Waga musi być dodatnią liczbą.');
        weight.setAttribute('aria-invalid', String(!valid));
        editorStatus.textContent = valid ? '' : 'Waga musi być większa od 0. Poprzednia poprawna waga pozostaje zapisana.';
        if (valid) {
          point.weight = value;
          select.textContent = '#' + point.id + ' · ' + point.name + ' — waga ' + point.weight;
          renderBoxes();
        }
      });
      function commitWeight() {
        var value = weight.valueAsNumber;
        if (!Number.isFinite(value) || value <= 0) {
          weight.value = point.weight;
          weight.setCustomValidity('');
          weight.setAttribute('aria-invalid', 'false');
          return;
        }
        point.weight = value;
        editorStatus.textContent = '';
        select.textContent = '#' + point.id + ' · ' + point.name + ' — waga ' + point.weight;
        // Move existing rows, retaining input focus and stable IDs.
        sortedPoints().forEach(function (entry) {
          var element = pointList.querySelector('[data-focus-row="' + entry.id + '"]');
          if (element) pointList.appendChild(element);
        });
        renderBoxes();
      }
      weight.addEventListener('change', commitWeight);
      weight.addEventListener('blur', commitWeight);
      weightLabel.appendChild(weight);
      fields.appendChild(weightLabel);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'focus-delete';
      remove.textContent = 'Usuń';
      remove.setAttribute('aria-label', 'Usuń Focus Point ' + point.id);
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        session.points = session.points.filter(function (entry) { return entry.id !== point.id; });
        if (selectedId === point.id) selectedId = null;
        renderList();
        renderBoxes();
      });
      fields.appendChild(remove);
      row.appendChild(fields);
      row.addEventListener('click', function () { selectPoint(point.id); });
      pointList.appendChild(row);
    });
  }
  function cancelGesture() {
    if (gesture && gesture.point) gesture.point.rect = copyRect(gesture.original);
    gesture = null;
    drawing = false;
    renderBoxes();
    updateEditorControls();
  }
  function commitPreview(meta, blob) {
    cancelGesture();
    var sameDocument = !!(session && session.identityVerified && meta.documentKey && capturedMeta.documentKey === meta.documentKey);
    var key = meta.documentKey || 'unverified-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random());
    if (!sameDocument) {
      session = {points: [], nextId: 1, notes: '', analysisMode: 'processing', identityVerified: !!meta.documentKey};
      resetAnalysis();
    }
    previewRevision++;
    capturedMeta = {documentKey: key, name: meta.name, width: meta.width, height: meta.height};
    capturedBlob = blob;
    selectedId = null;
    stage.style.maxWidth = (420 * previewImage.naturalWidth / previewImage.naturalHeight) + 'px';
    notesInput.value = session.notes;
    analysisModes.forEach(function (input) { input.checked = input.value === session.analysisMode; });
    if (sameDocument && currentAnalysis) analysisStatus.textContent = 'Podgląd odświeżony. Zachowano poprzedni wynik, obraz i stany zaleceń. Kliknij ANALIZUJ PONOWNIE po zakończeniu poprawek.';
    if (pendingReanalysis) {
      pendingReanalysis.ready = sameDocument && pendingReanalysis.documentKey === key;
      if (!pendingReanalysis.ready) { pendingReanalysis = null; analysisStatus.textContent = 'Dokument zmienił się. Wyczyszczono poprzednią analizę i oznaczenia; pobrano nowy podgląd.'; }
    }
    editor.hidden = false; renderList(); renderBoxes(); updateEditorControls();
    editorStatus.textContent = meta.documentKey ? '' : 'Nie rozpoznano dokumentu. Rozpoczęto nowy zestaw oznaczeń; porównanie z poprzednim obrazem jest niedostępne.';
  }
  function relativePosition(event) {
    var bounds = overlay.getBoundingClientRect();
    return {x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)};
  }
  addButton.addEventListener('click', function () {
    if (!session || currentRequest) return;
    if (drawing) cancelGesture();
    else {
      drawing = true;
      editorStatus.textContent = 'Przeciągnij na podglądzie, aby oznaczyć obiekt. Escape anuluje.';
      updateEditorControls();
    }
  });
  overlay.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 || currentRequest || !session || gesture) return;
    var start = relativePosition(event);
    var targetBox = event.target.closest('[data-focus-id]');
    if (drawing) {
      var draft = document.createElement('div');
      draft.className = 'focus-rectangle focus-draft';
      overlay.appendChild(draft);
      gesture = {type: 'draw', start: start, draft: draft};
    } else if (targetBox) {
      var id = Number(targetBox.dataset.focusId);
      var handle = event.target.dataset.focusHandle || '';
      selectPoint(id);
      var point = findPoint(id);
      gesture = {type: handle ? 'resize' : 'move', start: start, point: point,
        original: copyRect(point.rect), handle: handle};
    } else {
      selectPoint(null);
      return;
    }
    gesture.pointerId = event.pointerId;
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  overlay.addEventListener('pointermove', function (event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    var position = relativePosition(event);
    var start = gesture.start;
    if (gesture.type === 'draw') {
      gesture.rect = {x: Math.min(start.x, position.x), y: Math.min(start.y, position.y),
        width: Math.abs(start.x - position.x), height: Math.abs(start.y - position.y)};
      positionBox(gesture.draft, gesture.rect);
    } else {
      var rect = gesture.original;
      var dx = position.x - start.x;
      var dy = position.y - start.y;
      if (gesture.type === 'move') {
        gesture.point.rect = {x: clamp(rect.x + dx, 0, 1 - rect.width),
          y: clamp(rect.y + dy, 0, 1 - rect.height), width: rect.width, height: rect.height};
      } else {
        var left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
        if (gesture.handle.indexOf('w') !== -1) left = clamp(left + dx, 0, right - EPSILON);
        if (gesture.handle.indexOf('e') !== -1) right = clamp(right + dx, left + EPSILON, 1);
        if (gesture.handle.indexOf('n') !== -1) top = clamp(top + dy, 0, bottom - EPSILON);
        if (gesture.handle.indexOf('s') !== -1) bottom = clamp(bottom + dy, top + EPSILON, 1);
        gesture.point.rect = {x: left, y: top, width: right - left, height: bottom - top};
      }
      positionBox(overlay.querySelector('[data-focus-id="' + gesture.point.id + '"]'), gesture.point.rect);
    }
    event.preventDefault();
  });
  overlay.addEventListener('pointerup', function (event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.type === 'draw') {
      var rect = gesture.rect;
      var bounds = overlay.getBoundingClientRect();
      if (rect && rect.width * bounds.width >= 4 && rect.height * bounds.height >= 4) {
        var id = session.nextId++;
        session.points.push({id: id, name: 'Focus Point ' + id, weight: 1, rect: rect});
        selectedId = id;
        drawing = false;
        editorStatus.textContent = '';
        renderList();
      } else editorStatus.textContent = 'Zaznaczenie jest zbyt małe. Przeciągnij prostokąt wokół obiektu.';
    }
    gesture = null;
    overlay.releasePointerCapture(event.pointerId);
    renderBoxes();
    updateEditorControls();
  });
  overlay.addEventListener('pointercancel', cancelGesture);
  overlay.addEventListener('lostpointercapture', function () { if (gesture) cancelGesture(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && (drawing || gesture)) {
      cancelGesture();
      editorStatus.textContent = 'Zaznaczanie anulowane.';
    }
  });
  notesInput.addEventListener('input', function () { if (session) session.notes = notesInput.value; });

  function copyJson(value) { return JSON.parse(JSON.stringify(value)); }
  function modeName(mode) { return mode === 'processing' ? 'Tylko obróbka' : 'Obróbka i kompozycja'; }
  function updateTaskCard(card, state) {
    card.classList.toggle('focus-task-done', state === 'done');
    card.classList.toggle('focus-task-skipped', state === 'skipped');
    card.querySelector('.focus-task-state').textContent = state === 'done' ? 'Wykonane' : state === 'skipped' ? 'Pominięte' : 'Do wykonania';
    card.querySelector('[data-review-action="done"]').setAttribute('aria-pressed', String(state === 'done'));
    card.querySelector('[data-review-action="skipped"]').setAttribute('aria-pressed', String(state === 'skipped'));
  }
  function getCurrentAnalysisInput() {
    if (!session || !capturedBlob || currentRequest) return null;
    return {schemaVersion: 2, image: capturedBlob,
      document: Object.assign({}, capturedMeta, {width: previewImage.naturalWidth, height: previewImage.naturalHeight,
        identityVerified: session.identityVerified, previewRevision: previewRevision}),
      coordinateSystem: 'normalized-0-1', analysisMode: session.analysisMode,
      focusMeaning: 'object-location-in-full-composition', weightMeaning: 'relative-importance',
      focusPoints: sortedPoints().map(function (point) { return {id: point.id, name: point.name, weight: point.weight, rect: copyRect(point.rect)}; }), notes: session.notes};
  }
  function imageData(blob, width, height) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve({mimeType: 'image/png', dataUrl: reader.result, width: width, height: height,
        resolution: 'original', analysisScope: 'full-thumbnail'}); };
      reader.onerror = function () { reject(reader.error || new Error('Nie udało się przygotować obrazu.')); };
      reader.readAsDataURL(blob);
    });
  }
  async function prepareAnalysisRequest() {
    var input = getCurrentAnalysisInput();
    if (!input) throw new Error('Najpierw pobierz gotowy podgląd.');
    // Snapshot references and task states before asynchronous image conversion.
    var previous = lastAnalysisInput, result = currentAnalysis && copyJson(currentAnalysis);
    var states = Object.assign({}, reviewStates), source = analysisSource, analyzedAt = lastAnalyzedAt;
    var canCompare = !!(previous && result && input.document.identityVerified && previous.document.identityVerified &&
      previous.document.documentKey === input.document.documentKey);
    var request = {schemaVersion: 2, document: input.document, analysisScope: 'full-thumbnail',
      coordinateSystem: input.coordinateSystem, focusMeaning: input.focusMeaning, weightMeaning: input.weightMeaning,
      image: await imageData(input.image, input.document.width, input.document.height),
      focusPoints: input.focusPoints, analysisMode: input.analysisMode, notes: input.notes,
      comparisonAvailable: canCompare, previousAnalysis: null};
    if (canCompare) request.previousAnalysis = {documentKey: previous.document.documentKey, analyzedAt: analyzedAt, source: source,
      image: await imageData(previous.image, previous.document.width, previous.document.height),
      focusPoints: copyJson(previous.focusPoints), analysisMode: previous.analysisMode, notes: previous.notes,
      result: result, taskStates: states};
    if (!capturedMeta || capturedMeta.documentKey !== input.document.documentKey || previewRevision !== input.document.previewRevision || currentRequest)
      throw new Error('Podgląd zmienił się podczas przygotowania danych. Spróbuj ponownie.');
    return request;
  }
  function clearDocumentState() {
    cancelServerAnalysis();
    previewRevision++;
    session = null; capturedMeta = null; capturedBlob = null; selectedId = null;
    notesInput.value = ''; editor.hidden = true; previewBox.hidden = true; metaLabel.textContent = '';
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = ''; previewImage.removeAttribute('src');
    resetAnalysis(); renderList(); renderBoxes(); updateEditorControls();
  }
  function setAnalysisStatus(message, isError) {
    analysisStatus.textContent = message;
    analysisStatus.classList.toggle('error', !!isError);
  }
  function apiError(message) {
    var error = new Error(message); error.focusApiMessage = message; return error;
  }
  function hasTestToken() {
    if (testApiToken && /^[\x21-\x7e]{1,512}$/.test(testApiToken)) return true;
    if (testApiToken) {
      setAnalysisStatus('Nieprawidłowy format tokenu. Wpisz token ASCII bez spacji, taki sam jak sekret TEST_API_TOKEN Workera.', true);
      tokenInput.focus();
      return false;
    }
    setAnalysisStatus('Wpisz testowy token przed połączeniem z serwerem. Nie zapisujemy go na dysku.', true);
    tokenInput.focus();
    return false;
  }
  function cancelServerAnalysis() {
    if (!activeAnalysisRequest) return;
    activeAnalysisRequest.cancelled = true;
    activeAnalysisRequest.controller.abort();
  }
  function startServerAnalysis(noChanges, requirePrevious) {
    if (!session || currentRequest || analysisBusy || pendingReanalysis) return;
    if (requirePrevious && (!session.identityVerified || !currentAnalysis || !lastAnalysisInput)) return;
    if (!hasTestToken()) return;
    // Recognized documents use the existing capture path before every POST.
    // An unverified preview can be tested, but cannot carry a previous image.
    if (!session.identityVerified) { runServerAnalysis(noChanges, false); return; }
    pendingReanalysis = {documentKey: capturedMeta.documentKey, ready: false,
      noChanges: !!noChanges, requirePrevious: !!requirePrevious};
    setAnalysisStatus('Pobieram aktualny cały obraz przed połączeniem z serwerem testowym…');
    capturePreview();
    if (!currentRequest) { pendingReanalysis = null; setAnalysisStatus('Nie rozpoczęto analizy. Poczekaj na zakończenie bieżącego działania w Photopea.', true); }
    updateAnalysisControls();
  }
  function startReanalysis() { startServerAnalysis(false, true); }
  function finishReanalysis() {
    var pending = pendingReanalysis; pendingReanalysis = null;
    if (!pending || !pending.ready || !capturedMeta || pending.documentKey !== capturedMeta.documentKey) return;
    runServerAnalysis(pending.noChanges, pending.requirePrevious);
  }
  function httpError(response, data) {
    var code = data && data.error && data.error.code;
    if (response.status === 401) return apiError('Nieprawidłowy token testowy. Sprawdź go lub wpisz ponownie. Poprzednie porady pozostają.');
    if (response.status === 403) return apiError('Serwer odrzucił dostęp. Sprawdź ALLOWED_ORIGINS: ' + window.location.origin + '.');
    if (response.status === 413) return apiError('Żądanie przekracza limit 16 MiB, łącznie z aktualnym i poprzednim obrazem base64. Nic nie zastąpiono.');
    if (response.status === 400 || response.status === 415 || response.status === 422) return apiError('Serwer odrzucił niepoprawne dane analizy. Odśwież podgląd i sprawdź dodatnie wagi oraz oznaczenia. Poprzednie porady pozostają.');
    if (response.status === 503 && code === 'AUTH_NOT_CONFIGURED') return apiError('Worker nie ma poprawnie skonfigurowanego sekretu TEST_API_TOKEN. Sprawdź jego ustawienia w Cloudflare.');
    if (response.status === 503 && code === 'CORS_NOT_CONFIGURED') return apiError('Worker ma niepoprawne ustawienie ALLOWED_ORIGINS. Wymagany origin: ' + window.location.origin + '.');
    if (response.status >= 500) return apiError('Serwer testowy jest chwilowo niedostępny. Spróbuj ponownie. Poprzednie porady pozostają.');
    return apiError('Serwer odrzucił żądanie (HTTP ' + response.status + '). Poprzednie porady pozostają.');
  }
  async function runServerAnalysis(noChanges, requirePrevious) {
    if (!session || currentRequest || analysisBusy || !hasTestToken()) return;
    analysisBusy = true;
    cancelGesture();
    var job = {controller: new AbortController(), cancelled: false, timedOut: false};
    activeAnalysisRequest = job;
    var timer = null, bearer = testApiToken;
    try {
      setAnalysisStatus('Przygotowuję cały obraz i dane Focus Point…');
      var previous = lastAnalysisInput;
      var canCompare = !!(previous && currentAnalysis && session.identityVerified && previous.document.identityVerified &&
        previous.document.documentKey === capturedMeta.documentKey);
      var encodedImageBytes = Math.ceil(capturedBlob.size / 3) * 4 +
        (canCompare ? Math.ceil(previous.image.size / 3) * 4 : 0);
      if (encodedImageBytes > MAX_ANALYSIS_BYTES) throw httpError({status: 413});
      var request = await prepareAnalysisRequest();
      if (job.cancelled) return;
      if (requirePrevious && (!request.comparisonAvailable || !request.previousAnalysis)) throw apiError('Brak poprzedniego obrazu właściwego dokumentu. Nie wysłano ponownej analizy.');
      var body = JSON.stringify(request);
      if (new Blob([body]).size > MAX_ANALYSIS_BYTES) throw httpError({status: 413});
      timer = setTimeout(function () { job.timedOut = true; job.controller.abort(); }, ANALYSIS_TIMEOUT_MS);
      setAnalysisStatus('Wysyłam dane do Workera i czekam na demonstracyjne porady…');
      var response;
      try {
        response = await fetch(ANALYZE_URL + (noChanges ? '?example=no_changes' : ''), {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + bearer},
          body: body, signal: job.controller.signal
        });
      } catch (_) {
        if (job.cancelled) return;
        if (job.timedOut) throw apiError('Serwer nie odpowiedział w ciągu 45 sekund. Spróbuj ponownie. Poprzednie porady pozostają.');
        throw apiError('Nie udało się połączyć z serwerem. Sprawdź internet i dostępność Workera. Możliwa jest również blokada CORS — ALLOWED_ORIGINS musi zawierać ' + window.location.origin + '. Poprzednie porady pozostają.');
      }
      var result;
      try { result = await response.json(); }
      catch (_) {
        if (!response.ok) throw httpError(response);
        throw apiError(job.timedOut ? 'Upłynął czas odbierania odpowiedzi serwera. Poprzednie porady pozostają.' : 'Serwer zwrócił niepoprawny JSON. Poprzednie porady pozostają.');
      }
      if (job.cancelled) return;
      if (!response.ok) throw httpError(response, result);
      if (!session || !capturedMeta || currentRequest || request.document.documentKey !== capturedMeta.documentKey ||
          request.document.previewRevision !== previewRevision || request.analysisMode !== session.analysisMode) {
        throw apiError('Podgląd lub dokument zmienił się podczas połączenia. Odrzucono nieaktualny wynik.');
      }
      // Validate everything before the one current result is replaced.
      try {
        var normalized = normalizeAnalysisResult(result, request.analysisMode);
        normalized.suggestions.forEach(function (task) {
          if (task.focusPointIds.some(function (id) { return !findPoint(id); })) throw new Error('Unknown point');
        });
      } catch (_) { throw apiError('Odpowiedź serwera nie pasuje do formatu poradnika lub bieżących Focus Pointów. Poprzednie porady pozostają.'); }
      showAnalysisResult(normalized, request.document.documentKey, 'demo');
      setAnalysisStatus('Odebrano dane demonstracyjne z Workera. To test połączenia, nie analiza AI; obrazy nie zostały ocenione ani porównane.');
    } catch (error) {
      if (!job.cancelled) setAnalysisStatus(error.focusApiMessage || 'Nie udało się przygotować danych analizy. Spróbuj ponownie. Poprzednie porady pozostają.', true);
    } finally {
      bearer = '';
      if (timer) clearTimeout(timer);
      if (activeAnalysisRequest === job) activeAnalysisRequest = null;
      analysisBusy = false;
      updateEditorControls();
    }
  }
  function updateAnalysisControls() {
    analysisSettings.hidden = !session;
    analysisSettings.disabled = !!currentRequest || !session || analysisBusy;
    analysisSettings.setAttribute('aria-busy', String(!!currentRequest || analysisBusy || !!pendingReanalysis));
    resultsPanel.hidden = !session;
    analyzeButton.disabled = noChangesButton.disabled = !!currentRequest || !session || analysisBusy || !!pendingReanalysis;
    clearTokenButton.disabled = !!currentRequest || analysisBusy || !testApiToken;
    reanalyzeButton.disabled = !!currentRequest || !session || analysisBusy || !!pendingReanalysis || !currentAnalysis ||
      !lastAnalysisInput || !session.identityVerified;
    captureButton.disabled = !!currentRequest || analysisBusy;
    resultTasks.querySelectorAll('button').forEach(function (button) { button.disabled = !!currentRequest || analysisBusy; });
  }

  function normalizeAnalysisResult(result, expectedMode) {
    function text(value, field) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Brak poprawnego pola: ' + field);
      return value.trim();
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        result.schemaVersion !== 1 || result.analysisScope !== 'full-thumbnail') {
      throw new Error('Niepoprawny format wyniku analizy całej miniaturki.');
    }
    if (result.mode !== expectedMode || ['processing', 'processing_and_composition'].indexOf(result.mode) === -1) {
      throw new Error('Wynik nie odpowiada wybranemu zakresowi analizy.');
    }
    if (['suggestions', 'no_changes'].indexOf(result.status) === -1 || !Array.isArray(result.suggestions) ||
        (result.status === 'no_changes' && result.suggestions.length !== 0) ||
        (result.status === 'suggestions' && result.suggestions.length === 0)) {
      throw new Error('Niepoprawny status lub lista porad.');
    }
    var seen = Object.create(null);
    var normalized = {schemaVersion: 1, analysisScope: 'full-thumbnail', mode: result.mode,
      status: result.status, summary: text(result.summary, 'summary'), suggestions: []};
    normalized.suggestions = result.suggestions.map(function (task) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('Niepoprawne zadanie.');
      var id = text(task.id, 'id');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || seen[id]) throw new Error('Identyfikatory zadań muszą być unikalne.');
      seen[id] = true;
      if (['processing', 'composition'].indexOf(task.category) === -1 ||
          (result.mode === 'processing' && task.category === 'composition')) {
        throw new Error('Porada wykracza poza wybrany zakres analizy.');
      }
      if (!Array.isArray(task.instructions) || !task.instructions.length) throw new Error('Zadanie nie zawiera instrukcji.');
      var pointIds = task.focusPointIds === undefined ? [] : task.focusPointIds;
      if (!Array.isArray(pointIds) || pointIds.some(function (id, index) {
        return !Number.isInteger(id) || id <= 0 || pointIds.indexOf(id) !== index;
      })) throw new Error('Niepoprawne numery Focus Pointów.');
      return {id: id, category: task.category, title: text(task.title, 'title'),
        problem: text(task.problem, 'problem'), reason: text(task.reason, 'reason'),
        instructions: task.instructions.map(function (step) { return text(step, 'instructions'); }),
        expectedEffect: text(task.expectedEffect, 'expectedEffect'), focusPointIds: pointIds.slice()};
    });
    return normalized;
  }
  function updateResultProgress() {
    if (!currentAnalysis || currentAnalysis.status !== 'suggestions') return;
    var done = 0, skipped = 0;
    currentAnalysis.suggestions.forEach(function (task) {
      if (reviewStates[task.id] === 'done') done++;
      if (reviewStates[task.id] === 'skipped') skipped++;
    });
    resultProgress.textContent = 'Do wykonania: ' + (currentAnalysis.suggestions.length - done - skipped) +
      ' · Wykonane: ' + done + ' · Pominięte: ' + skipped;
  }
  function setTaskState(taskId, state) {
    if (currentRequest || analysisBusy || !currentAnalysis) return;
    var card = resultTasks.querySelector('[data-analysis-task="' + taskId + '"]');
    if (!card) return;
    reviewStates[taskId] = reviewStates[taskId] === state ? 'pending' : state;
    updateTaskCard(card, reviewStates[taskId]); updateResultProgress();
  }
  function buildTaskCard(task, states, onChange) {
      var card = document.createElement('article');
      card.className = 'focus-task';
      card.dataset.analysisTask = task.id;
      var title = document.createElement('h4');
      title.textContent = task.title;
      card.appendChild(title);
      var state = document.createElement('span');
      state.className = 'focus-task-state';
      state.textContent = 'Do wykonania';
      card.appendChild(state);
      var description = document.createElement('dl');
      [['Problem', task.problem], ['Dlaczego warto poprawić', task.reason], ['Oczekiwany efekt', task.expectedEffect]].forEach(function (entry) {
        var term = document.createElement('dt'), detail = document.createElement('dd');
        term.textContent = entry[0];
        detail.textContent = entry[1];
        description.appendChild(term);
        description.appendChild(detail);
      });
      card.appendChild(description);
      var instructions = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = 'Instrukcja w Photopea';
      instructions.appendChild(summary);
      var steps = document.createElement('ol');
      task.instructions.forEach(function (step) {
        var item = document.createElement('li');
        item.textContent = step;
        steps.appendChild(item);
      });
      instructions.appendChild(steps);
      card.appendChild(instructions);
      var actions = document.createElement('div');
      actions.className = 'focus-task-actions';
      [['done', 'Wykonane', 'Oznacz jako wykonane: '], ['skipped', 'Pomiń', 'Pomiń: ']].forEach(function (entry) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry[1];
        button.dataset.reviewAction = entry[0];
        button.setAttribute('aria-label', entry[2] + task.title);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', function () { onChange(task.id, entry[0]); });
        actions.appendChild(button);
      });
      card.appendChild(actions);
      updateTaskCard(card, states[task.id] || 'pending');
      return card;
  }
  function renderAnalysisResult() {
    resultTasks.replaceChildren();
    resultsTitle.textContent = currentAnalysis && currentAnalysis.status === 'no_changes' ? 'Brak koniecznych poprawek' : 'WYNIK ANALIZY';
    resultSource.hidden = !currentAnalysis;
    resultSource.textContent = (analysisSource === 'demo' ? 'DANE DEMONSTRACYJNE Z WORKERA — test połączenia, bez analizy AI i porównywania obrazów.' : 'Wynik dostarczony do panelu.') +
      (currentAnalysis ? ' Zakres tego wyniku: ' + modeName(currentAnalysis.mode) + '.' : '');
    resultSummary.textContent = currentAnalysis ? currentAnalysis.summary : 'Tu pojawią się demonstracyjne porady pobrane z serwera po kliknięciu ANALIZUJ.';
    resultProgress.hidden = !currentAnalysis || currentAnalysis.status !== 'suggestions';
    if (!currentAnalysis || currentAnalysis.status === 'no_changes') return;
    currentAnalysis.suggestions.forEach(function (task) { resultTasks.appendChild(buildTaskCard(task, reviewStates, setTaskState)); });
    updateResultProgress();
    updateAnalysisControls();
  }
  function resetAnalysis(message) {
    currentAnalysis = null;
    lastAnalysisInput = null; lastAnalyzedAt = '';
    analysisSource = '';
    reviewStates = Object.create(null);
    setAnalysisStatus(message || '');
    renderAnalysisResult();
  }
  function showAnalysisResult(result, documentKey, source) {
    if (!session || !capturedMeta || currentRequest) throw new Error('Najpierw pobierz gotowy podgląd.');
    if (documentKey !== capturedMeta.documentKey) throw new Error('Wynik dotyczy innego dokumentu.');
    var normalized = normalizeAnalysisResult(result, session.analysisMode);
    normalized.suggestions.forEach(function (task) {
      if (task.focusPointIds.some(function (id) { return !findPoint(id); })) throw new Error('Wynik wskazuje nieistniejący Focus Point.');
    });
    lastAnalysisInput = getCurrentAnalysisInput(); lastAnalyzedAt = new Date().toISOString();
    currentAnalysis = normalized;
    analysisSource = source || 'provided';
    reviewStates = Object.create(null);
    normalized.suggestions.forEach(function (task) { reviewStates[task.id] = 'pending'; });
    setAnalysisStatus(session.identityVerified ? '' : 'Brak bezpiecznej tożsamości dokumentu — bez porównania z poprzednim obrazem.');
    renderAnalysisResult();
    updateAnalysisControls();
  }
  analysisModes.forEach(function (input) {
    input.addEventListener('change', function () {
      if (!input.checked || !session || currentRequest) return;
      session.analysisMode = input.value;
      setAnalysisStatus(currentAnalysis ? 'Zakres zmieniony. Poprzedni wynik i stany pozostają; ponowna analiza użyje nowego zakresu.' : 'Zakres zmieniony. Kliknij ANALIZUJ dla wybranego trybu.');
    });
  });
  analyzeButton.addEventListener('click', function () {
    startServerAnalysis(false, false);
  });
  noChangesButton.addEventListener('click', function () {
    startServerAnalysis(true, false);
  });

  tokenInput.value = '';
  tokenInput.addEventListener('input', function () {
    testApiToken = tokenInput.value.trim();
    updateAnalysisControls();
  });
  clearTokenButton.addEventListener('click', function () {
    testApiToken = ''; tokenInput.value = '';
    setAnalysisStatus('Token wyczyszczony. Punkty i bieżący wynik pozostają.');
    updateAnalysisControls();
  });
  window.addEventListener('pagehide', function () {
    testApiToken = ''; tokenInput.value = '';
    cancelServerAnalysis(); updateAnalysisControls();
  });
  // Transport sends the complete PNG and object priorities to a mock Worker.
  // No real AI, cropping, layer binding or automatic pixel processing.
  reanalyzeButton.addEventListener('click', startReanalysis);
  window.ktxFocusPoint = Object.freeze({getAnalysisInput: getCurrentAnalysisInput,
    prepareAnalysisRequest: prepareAnalysisRequest,
    showAnalysisResult: function (result, documentKey, revision) {
      if (analysisBusy || pendingReanalysis) throw new Error('Poczekaj na zakończenie ponownej analizy.');
      if (revision !== undefined && revision !== previewRevision) throw new Error('Wynik dotyczy nieaktualnego podglądu.');
      showAnalysisResult(result, documentKey, 'provided');
    }, getAnalysisResult: function () { return currentAnalysis ? copyJson(currentAnalysis) : null; },
    getTaskStates: function () { return Object.assign({}, reviewStates); }
  });
  updateEditorControls();


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
    updateEditorControls();
    if (pendingReanalysis) finishReanalysis();
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
    if (/Dokument zmienił|Brak otwartego dokumentu|Nie masz otwartego dokumentu/i.test(reason || '')) clearDocumentState();
    if (pendingReanalysis) { pendingReanalysis = null; analysisStatus.textContent = 'Ponowna analiza nie została wykonana: ' + reason; }
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
      commitPreview(request.meta, blob);
      previewImage.alt = 'Podgląd dokumentu ' + request.meta.name;
      previewBox.hidden = false;
      metaLabel.textContent = request.meta.name + ' • ' + request.meta.width + ' × ' + request.meta.height + ' px';
      captureButton.textContent = 'ODŚWIEŻ PODGLĄD';
      setFocusStatus('Podgląd pobrany. Oznacz obiekty i ustaw ich względną ważność.', 'ok');
      // Retain the existing grace period for Photopea's trailing done.
      settleRequest(350);
    };
    previewImage.onerror = function () {
      previewImage.onload = null;
      previewImage.onerror = null;
      URL.revokeObjectURL(nextUrl);
      currentObjectUrl = previousUrl;
      if (previousUrl) previewImage.src = previousUrl;
      failCapture('Photopea zwróciła PNG, ale nie udało się wyświetlić podglądu.');
    };
    previewImage.src = nextUrl;
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
    if (currentRequest || analysisBusy) return;
    if (busyOutsideFocus()) {
      setFocusStatus('Poczekaj, aż Photopea zakończy obecne działanie lub eksport.', 'error');
      return;
    }

    cancelGesture();
    var id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    currentRequest = {id: id, phase: 'ping', meta: null, buffer: null, error: '', rendered: false,
      timeoutTimer: null, nextStepTimer: null, settleTimer: null};
    gate.owner = 'focus';
    gate.externalBufferSeen = false;
    gate.externalErrorSeen = false;
    lockPanel(true);
    updateEditorControls();
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
        'var ktxm={name:String(ktxd.name||"Bez nazwy"),width:String(ktxd.width),height:String(ktxd.height),documentSource:String(ktxd.source||""),documentKey:null};' +
        'var ktxunique=0;for(var ktxi=0;ktxi<app.documents.length;ktxi++){if(String(app.documents[ktxi].source||"")===ktxm.documentSource)ktxunique++;}' +
        'if(/^local,[0-9]+,/.test(ktxm.documentSource)&&ktxunique===1)ktxm.documentKey=ktxm.documentSource;' +
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
      if (capturedMeta && (!currentRequest.meta.documentKey || currentRequest.meta.documentKey !== capturedMeta.documentKey)) clearDocumentState();
      var exportId = currentRequest.id;
      var exportToken = JSON.stringify(exportId);
      currentRequest.phase = 'export';
      setFocusStatus('Odczytano ' + currentRequest.meta.name + ' • ' + currentRequest.meta.width + ' × ' + currentRequest.meta.height + ' px. Eksportuję PNG…');
      armTimeout(exportId, 60000, 'Połączenie działa i dokument został odczytany, ale Photopea nie zwróciła obrazu PNG.');
      scheduleFocusScript(exportId,
        'try{var ktxd=app.activeDocument;if(!ktxd)throw new Error("Brak otwartego dokumentu");if(String(ktxd.source||"")!==' + JSON.stringify(currentRequest.meta.documentSource) + ')throw new Error("Dokument zmienił się podczas pobierania. Odśwież podgląd ponownie.");ktxd.saveToOE("png");}' +
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
