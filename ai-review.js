(function () {
  'use strict';
  var panel = document.getElementById('aiReview'); if (!panel) return;
  var session = window.ktxAiReviewSession, contract = window.ktxAiReviewContract;
  var endpoint = window.ktxAiReviewConfig.endpoint;
  var accessUrl = new URL('/access', endpoint).href;
  var accessKey = '', busy = false, connected = false, previewUrl = '', renderedPreview = '', renderedResult = '';
  var expanded = new Set(), notesTimer;
  var elements = {};
  ['PreviewImage', 'PreviewEmpty', 'Capture', 'PreviewStatus', 'Notes', 'Analyze', 'AnalysisStatus', 'PersistenceStatus',
    'AccessStatus', 'ChangeKey', 'KeyForm', 'KeyInput', 'SaveKey', 'Result', 'Score', 'Summary', 'Strengths', 'StrengthsBlock',
    'Cards', 'ImprovementsTitle', 'NoChanges'].forEach(function (name) { elements[name] = document.getElementById('aiReview' + name); });
  function status(element, message, error) { element.textContent = message; element.classList.toggle('error', !!error); }
  function storageError() { status(elements.PersistenceStatus, 'Nie udało się zapisać sesji. Dane pozostają w tym panelu.', true); }
  function saved(promise) { return promise.catch(function () { storageError(); }); }
  function controls() {
    elements.Capture.disabled = busy; elements.Analyze.disabled = busy;
    elements.Notes.disabled = busy; elements.ChangeKey.disabled = busy; elements.SaveKey.disabled = busy;
    elements.KeyInput.disabled = busy;
    elements.Analyze.textContent = busy ? 'Analizowanie miniaturki...' : session.getState().reviewResult ? 'ANALIZUJ PONOWNIE' : 'ANALIZUJ';
    panel.setAttribute('aria-busy', String(busy));
    elements.Cards.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
  }
  function node(tag, className, content) {
    var element = document.createElement(tag); if (className) element.className = className;
    if (content !== undefined) element.textContent = content; return element;
  }
  function card(item, index) {
    var article = node('article', 'ai-review-card'); article.dataset.status = item.status;
    article.appendChild(node('h4', '', (index + 1) + '. ' + item.title));
    var meta = node('div', 'ai-review-card-meta');
    var priority = node('span', 'ai-review-priority', {high: 'WYSOKI', medium: 'ŚREDNI', low: 'NISKI'}[item.priority]);
    priority.dataset.priority = item.priority; meta.appendChild(priority);
    meta.appendChild(node('span', '', {pending: 'Do zrobienia', done: 'ZROBIONE', discarded: 'PORZUCONE'}[item.status]));
    article.appendChild(meta); article.appendChild(node('p', '', item.reason));
    var actions = node('div', 'ai-review-actions');
    var instruction = node('ol', 'ai-review-instruction'); instruction.id = 'aiReviewInstruction-' + item.id;
    instruction.hidden = !expanded.has(item.id);
    item.instruction.forEach(function (step) { instruction.appendChild(node('li', '', step)); });
    var instructionButton = node('button', '', 'INSTRUKCJA'); instructionButton.type = 'button';
    instructionButton.setAttribute('aria-controls', instruction.id);
    instructionButton.setAttribute('aria-expanded', String(!instruction.hidden));
    instructionButton.addEventListener('click', function () {
      instruction.hidden = !instruction.hidden;
      if (instruction.hidden) expanded.delete(item.id); else expanded.add(item.id);
      instructionButton.setAttribute('aria-expanded', String(!instruction.hidden));
    }); actions.appendChild(instructionButton);
    [['done', 'ZROBIONE'], ['discarded', 'PORZUĆ']].forEach(function (entry) {
      var button = node('button', '', entry[1]); button.type = 'button';
      button.setAttribute('aria-pressed', String(item.status === entry[0]));
      button.addEventListener('click', function () {
        if (!busy) saved(session.setImprovementStatus(item.id, item.status === entry[0] ? 'pending' : entry[0]));
      }); actions.appendChild(button);
    });
    article.appendChild(actions); article.appendChild(instruction); return article;
  }
  function render(state) {
    var previewId = state.meta && state.meta.documentKey + ':' + state.previewRevision;
    if (state.previewPng && previewId !== renderedPreview) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(state.previewPng); elements.PreviewImage.src = previewUrl;
      elements.PreviewImage.alt = 'Aktualna miniaturka: ' + state.meta.name;
      elements.PreviewImage.hidden = false; elements.PreviewEmpty.hidden = true; renderedPreview = previewId;
    }
    if (document.activeElement !== elements.Notes) elements.Notes.value = state.notes;
    elements.Result.hidden = !state.reviewResult;
    var resultId = JSON.stringify([state.reviewResult, state.improvements]);
    if (resultId !== renderedResult) {
      renderedResult = resultId; elements.Cards.replaceChildren(); elements.Strengths.replaceChildren();
      if (state.reviewResult) {
        elements.Score.textContent = 'OCENA: ' + state.reviewResult.score.toFixed(1) + ' / 10';
        elements.Summary.textContent = state.reviewResult.summary;
        state.reviewResult.strengths.forEach(function (strength) { elements.Strengths.appendChild(node('li', '', strength)); });
        elements.StrengthsBlock.hidden = !state.reviewResult.strengths.length;
        elements.ImprovementsTitle.hidden = !state.improvements.length;
        elements.NoChanges.hidden = !!state.improvements.length;
        state.improvements.forEach(function (item, index) { elements.Cards.appendChild(card(item, index)); });
      }
    }
    controls();
  }
  function apiError(code, httpStatus) {
    var messages = {
      UNAUTHORIZED: 'Brak dostępu do Oceny AI. Zmień klucz.',
      RATE_LIMIT: 'Zbyt wiele prób w krótkim czasie. Poczekaj przed kolejną analizą.',
      DAILY_LIMIT: 'Wykorzystano dzienny limit analiz.', MONTHLY_LIMIT: 'Wykorzystano miesięczny limit analiz.',
      PAYLOAD_TOO_LARGE: 'Obrazy przekraczają limit rozmiaru żądania. Zmniejsz wymiary dokumentu.',
      INVALID_REQUEST: 'Serwer odrzucił dane. Odśwież podgląd i spróbuj ponownie.',
      CONFIGURATION_ERROR: 'Dostęp AI wymaga konfiguracji serwera.',
      OPENAI_TIMEOUT: 'Upłynął czas analizy. Próba mogła naliczyć koszt i zużyć limit.',
      OPENAI_REFUSAL: 'AI odmówiło analizy tego obrazu.',
      OPENAI_INCOMPLETE: 'AI nie ukończyło odpowiedzi. Poprzedni wynik pozostaje.',
      OPENAI_INVALID_RESULT: 'AI zwróciło niepoprawną ocenę. Poprzedni wynik pozostaje.',
      OPENAI_RATE_LIMIT: 'Usługa AI ograniczyła liczbę zapytań. Spróbuj później.',
      OPENAI_UNAVAILABLE: 'Usługa AI jest chwilowo niedostępna. Próba mogła zużyć limit.',
      LIMITS_UNAVAILABLE: 'Nie udało się sprawdzić limitów. Analiza nie została wysłana.'
    };
    if (httpStatus === 401 || code === 'UNAUTHORIZED') {
      connected = false; elements.AccessStatus.textContent = 'Brak dostępu do Oceny AI'; elements.KeyForm.hidden = false;
    }
    var error = new Error(messages[code] || (httpStatus === 413 ? messages.PAYLOAD_TOO_LARGE : 'Nie udało się wykonać analizy. Poprzedni wynik pozostaje.'));
    error.code = httpStatus === 401 ? 'UNAUTHORIZED' : code; return error;
  }
  async function readResponse(response) {
    var reader = response.body.getReader(), parts = [], size = 0;
    while (true) {
      var chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error('Odpowiedź serwera jest za duża. Poprzedni wynik pozostaje.'); }
      parts.push(chunk.value);
    }
    var bytes = new Uint8Array(size), offset = 0;
    parts.forEach(function (part) { bytes.set(part, offset); offset += part.length; });
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch (_) { throw new Error('Serwer zwrócił niepoprawną odpowiedź. Poprzedni wynik pozostaje.'); }
  }
  async function request(url, key, body) {
    var controller = new AbortController(), timedOut = false;
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, body ? 90000 : 15000);
    try {
      var response = await fetch(url, {method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: body ? {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'} : {'Authorization': 'Bearer ' + key},
        body: body, signal: controller.signal});
      var data = await readResponse(response);
      if (!response.ok) throw apiError(data.error && data.error.code, response.status);
      return data;
    } catch (error) {
      if (timedOut) throw apiError('OPENAI_TIMEOUT');
      if (error instanceof TypeError) throw new Error('Nie można połączyć się z serwerem. Sprawdź połączenie internetowe. Poprzedni wynik pozostaje.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function imageData(png, meta) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader(); reader.onerror = function () { reject(new Error('Nie udało się przygotować PNG.')); };
      reader.onload = function () { resolve({mimeType: 'image/png', dataUrl: reader.result, width: meta.width, height: meta.height}); };
      reader.readAsDataURL(png);
    });
  }
  async function preparePayload(snapshot, captured, notes) {
    var comparable = snapshot.meta && snapshot.meta.documentKey === captured.meta.documentKey && snapshot.reviewResult && snapshot.reviewedPreviewPng;
    var estimatedBytes = Math.ceil(captured.png.size / 3) * 4 + (comparable ? Math.ceil(snapshot.reviewedPreviewPng.size / 3) * 4 : 0);
    if (estimatedBytes > contract.maxPayloadBytes) throw apiError('PAYLOAD_TOO_LARGE');
    var payload = {schemaVersion: 1, documentKey: captured.meta.documentKey, image: await imageData(captured.png, captured.meta),
      notes: notes, previous: null, discardedImprovements: comparable ? snapshot.discardedImprovements.map(function (item) {
        return {issueKey: item.issueKey, category: item.category, title: item.title};
      }) : []};
    if (comparable) {
      // Dimensions come from the reviewed PNG, which can differ after resizing.
      var bytes = await snapshot.reviewedPreviewPng.slice(0, 24).arrayBuffer(), view = new DataView(bytes);
      var previousMeta = {width: view.getUint32(16), height: view.getUint32(20)};
      payload.previous = {image: await imageData(snapshot.reviewedPreviewPng, previousMeta),
        review: snapshot.reviewResult, improvements: snapshot.improvements.map(function (item) {
          return {id: item.id, issueKey: item.issueKey, status: item.status};
        })};
    }
    var body = JSON.stringify(payload);
    if (new Blob([body]).size > contract.maxPayloadBytes) throw apiError('PAYLOAD_TOO_LARGE');
    return body;
  }
  async function refreshPreview() {
    if (busy) return; busy = true; controls(); clearTimeout(notesTimer);
    status(elements.PreviewStatus, 'Pobieranie podglądu...');
    try {
      if (session.getState().meta) await saved(session.setNotes(elements.Notes.value));
      var captured = await session.capture();
      await saved(session.acceptPreview(captured));
      status(elements.PreviewStatus, captured.meta.name + ' • ' + captured.meta.width + ' × ' + captured.meta.height + ' px');
    } catch (error) { status(elements.PreviewStatus, error.message, true); }
    finally { busy = false; controls(); }
  }
  async function analyze() {
    if (busy) return;
    if (!accessKey) { elements.KeyForm.hidden = false; elements.KeyInput.focus(); status(elements.AnalysisStatus, 'Wpisz klucz w sekcji Dostęp AI.', true); return; }
    busy = true; controls(); clearTimeout(notesTimer);
    status(elements.AnalysisStatus, 'Analizowanie miniaturki...');
    try {
      var notes = elements.Notes.value;
      await saved(session.setNotes(notes));
      var snapshot = session.getState();
      var captured = await session.capture();
      await saved(session.acceptPreview(captured));
      status(elements.PreviewStatus, captured.meta.name + ' • ' + captured.meta.width + ' × ' + captured.meta.height + ' px');
      // A newly selected document starts its own review and notes.
      if (snapshot.meta && snapshot.meta.documentKey !== captured.meta.documentKey) notes = session.getState().notes;
      var body = await preparePayload(snapshot, captured, notes);
      var result = contract.normalizeReview(await request(endpoint, accessKey, body));
      var current = await session.capture({metadataOnly: true});
      if (current.meta.documentKey !== captured.meta.documentKey) throw new Error('Dokument zmienił się podczas analizy. Odśwież podgląd. Poprzedni wynik pozostaje.');
      expanded.clear(); await saved(session.acceptReview(result, captured, notes));
      connected = true; elements.AccessStatus.textContent = 'Połączono'; elements.KeyForm.hidden = true;
      status(elements.AnalysisStatus, 'Analiza zakończona.');
    } catch (error) { status(elements.AnalysisStatus, error.message, true); }
    finally { busy = false; controls(); }
  }
  async function connect(key, save) {
    if (!/^[\x21-\x7e]{32,512}$/.test(key)) throw new Error('Klucz musi mieć 32–512 znaków, bez spacji.');
    var response = await request(accessUrl, key);
    if (response.ok !== true) throw new Error('Nie udało się potwierdzić dostępu AI.');
    if (save) await session.setAccessKey(key);
    accessKey = key; connected = true; elements.AccessStatus.textContent = 'Połączono';
    elements.KeyInput.value = ''; elements.KeyForm.hidden = true;
  }
  elements.Capture.addEventListener('click', refreshPreview);
  elements.Analyze.addEventListener('click', analyze);
  elements.ChangeKey.addEventListener('click', function () { elements.KeyForm.hidden = !elements.KeyForm.hidden; if (!elements.KeyForm.hidden) elements.KeyInput.focus(); });
  elements.KeyForm.addEventListener('submit', async function (event) {
    event.preventDefault(); if (busy) return; busy = true; controls();
    try { await connect(elements.KeyInput.value.trim(), true); status(elements.AnalysisStatus, ''); }
    catch (error) { status(elements.AnalysisStatus, error.message, true); }
    finally { busy = false; controls(); }
  });
  elements.Notes.addEventListener('input', function () {
    clearTimeout(notesTimer); notesTimer = setTimeout(function () { saved(session.setNotes(elements.Notes.value)); }, 250);
  });
  window.addEventListener('pagehide', function () {
    clearTimeout(notesTimer); saved(session.setNotes(elements.Notes.value));
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  });
  session.subscribe(render); render(session.getState());
  (async function () {
    var local = await session.initialize();
    if (!local.ready) storageError();
    else {
      try {
        accessKey = await session.getAccessKey() || '';
        if (accessKey) { elements.KeyForm.hidden = true; elements.AccessStatus.textContent = 'Sprawdzanie dostępu...'; await connect(accessKey, false); }
      } catch (error) { elements.AccessStatus.textContent = error.code === 'UNAUTHORIZED' ? 'Brak dostępu do Oceny AI' : 'Brak połączenia'; status(elements.AnalysisStatus, error.message, true); }
    }
    if (!connected && !accessKey) elements.KeyForm.hidden = false;
    if (window.parent !== window) await refreshPreview();
  })();
})();
