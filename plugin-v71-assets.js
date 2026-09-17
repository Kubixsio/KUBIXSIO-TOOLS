(function () {
  'use strict';
  var ORIGIN = location.origin;
  var CACHE_KEY = 'kubixsio-assets-panel-v1';
  var FAVORITES_KEY = 'kubixsio-assets-favorites-v1';
  var popup = null, channel = '', command = null, importState = null;
  var state = {libraries: [], files: [], lastLibrary: null};
  var favorites = {};
  var expandedLibraryId = null;

  try {
    var saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (saved && Array.isArray(saved.libraries) && Array.isArray(saved.files)) state = saved;
  } catch (_) {}
  try { favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY)) || {}; } catch (_) {}

  function restoreFavorites() {
    state.files.forEach(function (file) {
      if (Object.prototype.hasOwnProperty.call(favorites, file.id)) file.favorite = favorites[file.id];
    });
  }
  restoreFavorites();
  function saveState() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); } catch (_) {} }
  function byId(id) { return document.getElementById(id); }
  function message(text, error) {
    var el = byId('assetsMessage');
    el.textContent = text || '';
    el.className = 'assets-message' + (error ? ' error' : '');
  }
  function node(tag, className, label) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (label != null) el.textContent = label;
    return el;
  }
  function button(label, onClick, disabled, title) {
    var el = node('button', '', label);
    el.type = 'button';
    el.disabled = !!disabled;
    if (title) el.title = title;
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }
  function library(id) { return state.libraries.find(function (item) { return item.id === id; }); }
  function openHelper(action) {
    if (popup && !popup.closed && importState) { message('Poczekaj na zakończenie wstawiania assetu.', true); return; }
    channel = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    command = Object.assign({}, action, {favorites: Object.keys(favorites).length ? favorites : null});
    var url = new URL('assets-helper.html', location.href);
    url.searchParams.set('channel', channel);
    popup = window.open(url.href, 'kubixsioAssetsHelper', 'width=580,height=700,resizable=yes,scrollbars=yes');
    if (!popup) { message('Przeglądarka zablokowała okno bibliotek. Zezwól na wyskakujące okna dla Photopea.', true); return; }
    popup.focus();
    message(action.type === 'sync' ? 'Wczytuję biblioteki…' : action.type === 'use' ? 'Wstawiam asset…' : 'Otwórz pomocnicze okno Kubixsio Tools.');
  }
  function sendToHelper(data) {
    if (popup && !popup.closed) popup.postMessage({type: 'KT_ASSETS', channel: channel, command: data}, ORIGIN);
  }
  function showAssets() {
    byId('assetsHome').classList.toggle('assets-hidden');
    byId('assetsEntry').setAttribute('aria-expanded', byId('assetsHome').classList.contains('assets-hidden') ? 'false' : 'true');
  }
  function showLibraries() {
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    expandedLibraryId = null;
    render();
    if (!state.libraries.length) openHelper({type: 'sync'});
  }
  function goBack() {
    byId('assetsBrowser').classList.add('assets-hidden');
    byId('assetsHome').classList.remove('assets-hidden');
    byId('assetsEntry').setAttribute('aria-expanded', 'true');
  }
  function toggleFavorite(file) {
    file.favorite = !file.favorite;
    favorites[file.id] = file.favorite;
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch (_) {}
    saveState();
    render();
    message(file.favorite ? 'Dodano do ulubionych.' : 'Usunięto z ulubionych.');
  }
  function refreshLocal(id) {
    var lib = library(id);
    if (!lib) { message('Nie znaleziono biblioteki do odświeżenia.', true); return; }
    // Directory handles live in the helper window, so this action only resets
    // the cached label and never opens that window.  The picker performs the
    // real handle check before showing files (and reports an unavailable drive).
    lib.status = 'ready';
    saveState();
    render();
    message('Folder odświeżony. Nowe pliki będą dostępne przez „Wybierz plik”.');
  }
  function section(listRoot, heading, files, suffix) {
    var root = byId(listRoot);
    root.replaceChildren();
    if (!files.length) return;
    root.appendChild(node('p', 'assets-subtitle', heading));
    files.forEach(function (file) {
      var lib = library(file.libraryId), row = node('div', 'assets-row');
      var name = file.name + (lib ? ' · ' + lib.name : '');
      var use = button(name + (suffix ? ' · ' + file.count : ''), function () { openHelper({type: 'use', id: file.id}); }, !lib || !lib.enabled);
      use.className = 'assets-file';
      var star = button(file.favorite ? '★' : '☆', function () { toggleFavorite(file); }, !lib);
      star.className = 'assets-star';
      star.setAttribute('aria-label', file.favorite ? 'Usuń z ulubionych: ' + file.name : 'Dodaj do ulubionych: ' + file.name);
      row.appendChild(use); row.appendChild(star); root.appendChild(row);
    });
  }
  function render() {
    var root = byId('assetsLibraryList');
    root.replaceChildren();
    if (expandedLibraryId && !library(expandedLibraryId)) expandedLibraryId = null;
    if (!state.libraries.length) root.appendChild(node('p', 'assets-muted', 'Nie masz jeszcze dodanych folderów. Użyj „Dodaj folder”.'));
    state.libraries.forEach(function (lib) {
      var card = node('div', 'assets-card' + (!lib.enabled ? ' disabled' : ''));
      var expanded = expandedLibraryId === lib.id;
      var head = button('', function () {
        expandedLibraryId = expandedLibraryId === lib.id ? null : lib.id;
        render();
        var newHead = byId('assetsLibraryHeader-' + lib.id);
        if (newHead && newHead.focus) newHead.focus({preventScroll: true});
      });
      head.className = 'assets-card-head';
      head.id = 'assetsLibraryHeader-' + lib.id;
      head.setAttribute('aria-expanded', String(expanded));
      head.setAttribute('aria-controls', 'assetsLibraryActions-' + lib.id);
      head.appendChild(node('span', 'assets-title', lib.name));
      var status = !lib.enabled ? 'wyłączony' : lib.status === 'unavailable' ? 'folder niedostępny' : lib.status === 'permission' ? 'wymaga dostępu' : 'gotowy';
      head.appendChild(node('span', 'assets-state' + (lib.status === 'unavailable' && lib.enabled ? ' unavailable' : ''), status));
      var chevron = node('span', 'assets-chevron', expanded ? '⌃' : '⌄');
      chevron.setAttribute('aria-hidden', 'true');
      head.appendChild(chevron);
      var actions = node('div', 'assets-actions' + (expanded ? '' : ' assets-hidden'));
      actions.id = 'assetsLibraryActions-' + lib.id;
      var unavailable = lib.status === 'unavailable';
      var choose = button(unavailable ? 'FOLDER NIEDOSTĘPNY' : 'Wybierz plik', unavailable ? null : function () { openHelper({type: 'pick', id: lib.id}); }, !lib.enabled || unavailable);
      choose.className = 'assets-choose';
      actions.appendChild(choose);
      actions.appendChild(button('Odśwież', function () { refreshLocal(lib.id); }));
      actions.appendChild(button(lib.enabled ? 'Wyłącz' : 'Włącz', function () { openHelper({type: 'toggle', id: lib.id}); }));
      actions.appendChild(button('Usuń z Kubixsio Tools', function () { openHelper({type: 'remove', id: lib.id}); }));
      actions.appendChild(node('p', 'assets-muted assets-location-note', 'Folder otworzysz w systemowym oknie przez „Wybierz plik”.'));
      card.appendChild(head);card.appendChild(actions);root.appendChild(card);
    });
    var files = state.files.filter(function (f) { return library(f.libraryId); });
    section('assetsRecent', 'OSTATNIO UŻYWANE', files.filter(function (f) { return f.lastUsed; }).sort(function (a,b) {return b.lastUsed-a.lastUsed;}).slice(0,5), false);
    section('assetsFavorites', 'ULUBIONE', files.filter(function (f) {return f.favorite;}), false);
    section('assetsFrequent', 'NAJCZĘŚCIEJ UŻYWANE', files.filter(function (f) {return f.count > 0 && !f.favorite;}).sort(function (a,b) {return b.count-a.count;}).slice(0,3), true);
  }
  function fail(reason) { importState = null; setStatus('ASSETS: ' + reason, 'err'); message(reason, true); sendToHelper({type: 'import-result', ok: false, reason: reason}); }
  function beginImport(payload) {
    if (importState) { message('Trwa już wstawianie assetu.', true); return; }
    if (vignetteStage !== 'idle' || watermarkStage !== 'idle' || window.folderizeBusy) {
      message('Poczekaj, aż obecne działanie Photopea się zakończy.', true);
      sendToHelper({type: 'import-result', ok: false, reason: 'Photopea wykonuje inne działanie.'});
      return;
    }
    if (!(payload.buffer instanceof ArrayBuffer) || !payload.name) { message('Niepoprawny plik.', true); return; }
    var openAsDocument = /\.(psd|psb)$/i.test(payload.name);
    importState = {id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name: payload.name, buffer: payload.buffer, ready: false, done: false, openAsDocument: openAsDocument, stage: openAsDocument ? 'openingDocument' : 'capturing'};
    if (openAsDocument) {
      setStatus('ASSETS: otwieram PSD jako nowy projekt…', 'busy');
      sendBuffer();
      return;
    }
    setStatus('ASSETS: sprawdzam otwarty projekt…', 'busy');
    var id = JSON.stringify(importState.id);
    postScript('try{var d=app.activeDocument;if(!d)throw new Error("Otwórz projekt przed wstawieniem assetu");window.ktxAssetsTarget={doc:d,count:app.documents.length};app.echoToOE("KTX_ASSET_TARGET|"+' + id + ')}catch(e){app.echoToOE("KTX_ASSET_ERR|"+' + id + '+"|"+e.toString())}');
  }
  function sendBuffer() {
    if (importState && importState.openAsDocument && importState.stage === 'openingDocument') {
      var documentBuffer = importState.buffer;
      importState.buffer = null;
      window.parent.postMessage(documentBuffer, '*', [documentBuffer]);
      return;
    }
    if (!importState || !importState.ready || !importState.done || importState.stage !== 'capturing') return;
    importState.stage = 'opening';
    setStatus('ASSETS: otwieram oryginał…', 'busy');
    var buffer = importState.buffer;
    importState.buffer = null;
    window.parent.postMessage(buffer, '*', [buffer]);
  }
  function finishImport() {
    if (!importState || importState.stage !== 'opening') return;
    importState.stage = 'finishing';
    var id = JSON.stringify(importState.id), name = JSON.stringify(importState.name);
    setStatus('ASSETS: dodaję warstwę 1:1…', 'busy');
    postScript('try{var s=window.ktxAssetsTarget;if(!s||!s.doc)throw new Error("Zgubiono dokument docelowy");if(app.documents.length!==s.count+1)throw new Error("Zmieniono liczbę otwartych dokumentów");var target=s.doc,found=false;for(var i=0;i<app.documents.length;i++)if(app.documents[i]===target)found=true;if(!found)throw new Error("Dokument docelowy został zamknięty");var source=app.activeDocument;if(source===target)throw new Error("Nie znaleziono pliku źródłowego");var w=Number(source.width),h=Number(source.height);source.selection.selectAll();source.selection.copy(true);app.activeDocument=target;var layer=target.paste();layer.name=' + name + ';source.close(SaveOptions.DONOTSAVECHANGES);app.activeDocument=target;window.ktxAssetsTarget=null;app.echoToOE("KTX_ASSET_OK|"+' + id + '+"|"+w+"x"+h)}catch(e){window.ktxAssetsTarget=null;app.echoToOE("KTX_ASSET_ERR|"+' + id + '+"|"+e.toString())}');
  }
  window.addEventListener('message', function (event) {
    if (event.origin === ORIGIN && popup && event.source === popup && event.data && event.data.type === 'KT_ASSETS' && event.data.channel === channel) {
      var data = event.data;
      if (data.event === 'ready') sendToHelper(command);
      if (data.event === 'snapshot' && data.snapshot) {
        state = data.snapshot;
        restoreFavorites();
        saveState();
        render();
        if (command && command.type === 'sync') message('Biblioteki wczytane.');
      }
      if (data.event === 'asset') beginImport(data);
      if (data.event === 'error') message(data.reason, true);
      return;
    }
    if (!importState || event.source !== window.parent || typeof event.data !== 'string') return;
    if (event.data === 'done') {
      if (importState.stage === 'capturing') { importState.done = true; sendBuffer(); }
      else if (importState.stage === 'opening') finishImport();
      else if (importState.stage === 'openingDocument') {
        var opened = importState;
        importState = null;
        setStatus('Otwarto ' + opened.name + ' jako nowy projekt.', '');
        sendToHelper({type: 'import-result', ok: true});
      }
      else if (importState.stage === 'complete') {
        var success = importState;
        importState = null;
        setStatus('Dodano ' + success.name + ' (' + success.dims + ', 1:1)', '');
        sendToHelper({type: 'import-result', ok: true});
      } else if (importState.stage === 'error') fail(importState.reason);
      return;
    }
    var value = event.data, prefix = '|' + importState.id;
    if (value === 'KTX_ASSET_TARGET' + prefix && importState.stage === 'capturing') { importState.ready = true; sendBuffer(); }
    else if (value.indexOf('KTX_ASSET_OK' + prefix + '|') === 0 && importState.stage === 'finishing') {
      importState.dims = value.substring(('KTX_ASSET_OK' + prefix + '|').length);
      importState.stage = 'complete';
    } else if (value.indexOf('KTX_ASSET_ERR' + prefix + '|') === 0) {
      importState.reason = value.substring(('KTX_ASSET_ERR' + prefix + '|').length);
      importState.stage = 'error';
    }
  });
  byId('assetsEntry').addEventListener('click', showAssets);
  byId('assetsAdd').addEventListener('click', function () {openHelper({type: 'add'});});
  byId('assetsSearch').addEventListener('click', showLibraries);
  byId('assetsBack').addEventListener('click', goBack);
  render();
})();
