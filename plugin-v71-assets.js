(function () {
  'use strict';
  var ORIGIN = location.origin;
  var CACHE_KEY = 'kubixsio-assets-panel-v1';
  var FAVORITES_KEY = 'kubixsio-assets-favorites-v1';
  var PLACE_KEY = 'kubixsio-assets-place-v1';
  var popup = null, channel = '', command = null, importState = null, exportState = null;
  var state = {libraries: [], files: [], lastLibrary: null};
  var favorites = {};
  var expandedLibraryId = null;
  var currentLibraryId = null, catalog = [], catalogComplete = false, savedPlace = '';

  try {
    var saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (saved && Array.isArray(saved.libraries) && Array.isArray(saved.files)) state = saved;
  } catch (_) {}
  try { favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY)) || {}; } catch (_) {}
  try { var placeValue = localStorage.getItem(PLACE_KEY); savedPlace = placeValue === null ? state.lastLibrary || '' : placeValue || ''; } catch (_) {}

  function restoreFavorites(previous) {
    if (previous) previous.filter(function (file) { return file.favorite && library(file.libraryId) && !state.files.some(function (f) { return f.id === file.id; }); }).forEach(function (file) { state.files.push(file); });
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
    if ((importState || exportState && action.type !== 'save-layer') && action.type !== 'sync') { message('Poczekaj na zakończenie działania Photopea.', true); return; }
    channel = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    command = Object.assign({}, action, {favorites: Object.keys(favorites).length ? favorites : null,
      favoriteEntries: state.files.filter(function (f) { return f.favorite && f.path; }).map(function (f) { return {id:f.id, libraryId:f.libraryId, name:f.name, path:f.path}; })});
    var url = new URL('assets-helper.html', location.href);
    url.searchParams.set('channel', channel);
    popup = window.open(url.href, 'kubixsioAssetsHelper', 'width=580,height=700,resizable=yes,scrollbars=yes');
    if (!popup) { exportState = null; message('Przeglądarka zablokowała okno bibliotek. Zezwól na wyskakujące okna dla Photopea.', true); return; }
    popup.focus();
    message(action.type === 'sync' ? 'Wczytuję biblioteki…' : action.type === 'use' ? 'Wstawiam asset…' : 'Otwórz pomocnicze okno Kubixsio Tools.');
  }
  function sendToHelper(data, transfer) {
    if (popup && !popup.closed) popup.postMessage({type: 'KT_ASSETS', channel: channel, command: data}, ORIGIN, transfer || []);
  }
  function choosePlace(id) {
    savedPlace = id || '';
    try { localStorage.setItem(PLACE_KEY, savedPlace); } catch (_) {}
  }
  function showAssets() {
    var open = byId('assetsHome').classList.contains('assets-hidden') && byId('assetsBrowser').classList.contains('assets-hidden');
    if (!open) {
      byId('assetsHome').classList.add('assets-hidden');
      byId('assetsBrowser').classList.add('assets-hidden');
    } else if (savedPlace && library(savedPlace) && library(savedPlace).enabled) openLibrary(savedPlace);
    else byId('assetsHome').classList.remove('assets-hidden');
    byId('assetsEntry').setAttribute('aria-expanded', String(open));
  }
  function showLibraries() {
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    byId('assetsOverview').classList.remove('assets-hidden');
    byId('assetsLibraryView').classList.add('assets-hidden');
    byId('assetsSavePanel').classList.add('assets-hidden');
    currentLibraryId = null;
    expandedLibraryId = null;
    render();
    if (!state.libraries.length) openHelper({type: 'sync'});
  }
  function goBack() {
    if (!byId('assetsSavePanel').classList.contains('assets-hidden')) {
      if (savedPlace && library(savedPlace) && library(savedPlace).enabled) openLibrary(savedPlace);
      else showLibraries();
      return;
    }
    if (currentLibraryId) { choosePlace(''); showLibraries(); return; }
    byId('assetsBrowser').classList.add('assets-hidden');
    byId('assetsHome').classList.remove('assets-hidden');
    byId('assetsEntry').setAttribute('aria-expanded', 'true');
  }
  function openLibrary(id) {
    var lib = library(id);
    if (!lib || !lib.enabled) { showLibraries(); return; }
    currentLibraryId = id;
    choosePlace(id);
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    byId('assetsOverview').classList.add('assets-hidden');
    byId('assetsSavePanel').classList.add('assets-hidden');
    byId('assetsLibraryView').classList.remove('assets-hidden');
    byId('assetsLibraryTitle').textContent = lib.name;
    catalog = []; catalogComplete = false;
    byId('assetsTileGrid').replaceChildren();
    byId('assetsCatalogState').textContent = lib.status === 'unavailable' ? 'Sprawdzam dostępność folderu…' : 'Wczytuję pliki z folderu…';
    openHelper({type: 'browse', id: id});
  }
  function showSaveForm() {
    if (importState || exportState) { message('Poczekaj na zakończenie poprzedniego działania.', true); return; }
    var select = byId('assetsSaveLibrary');
    select.replaceChildren();
    state.libraries.filter(function (lib) { return lib.enabled; }).forEach(function (lib) {
      var option = node('option', '', lib.name); option.value = lib.id; select.appendChild(option);
    });
    if (currentLibraryId && library(currentLibraryId) && library(currentLibraryId).enabled) select.value = currentLibraryId;
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    byId('assetsOverview').classList.add('assets-hidden');
    byId('assetsLibraryView').classList.add('assets-hidden');
    byId('assetsSavePanel').classList.remove('assets-hidden');
    if (!select.options.length) message('Dodaj i włącz bibliotekę przed zapisem.', true);
    byId('assetsSaveName').focus();
  }
  function confirmSave() {
    if (exportState) { message('Trwa już zapis warstwy.', true); return; }
    var id = byId('assetsSaveLibrary').value, name = byId('assetsSaveName').value.trim();
    if (!id || !library(id)) { message('Wybierz bibliotekę.', true); return; }
    if (!name) { message('Podaj nazwę pliku.', true); return; }
    if (!/\.png$/i.test(name)) name += '.png';
    if (!/^[^\\/:*?"<>|\x00-\x1f]+\.png$/i.test(name) || /[. ]\.png$/i.test(name)) { message('Podaj poprawną nazwę pliku PNG.', true); return; }
    if (vignetteStage !== 'idle' || watermarkStage !== 'idle' || window.folderizeBusy || importState) { message('Photopea wykonuje inne działanie.', true); return; }
    exportState = {id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), libraryId: id, name: name, stage: 'permission', buffer: null};
    openHelper({type: 'save-layer', id: id, name: name});
    message('Sprawdzam dostęp do zapisu w bibliotece…');
  }
  function showPreview(item) {
    if (!item.preview) { message('Podgląd tego formatu nie jest dostępny w przeglądarce.', true); return; }
    byId('assetsPreviewImage').src = item.preview;
    byId('assetsPreviewImage').alt = item.name;
    byId('assetsPreviewName').textContent = item.name;
    byId('assetsPreview').classList.remove('assets-hidden');
  }
  function closePreview() { byId('assetsPreview').classList.add('assets-hidden'); byId('assetsPreviewImage').removeAttribute('src'); }
  function showInfo(item) {
    var root = byId('assetsInfoText'); root.replaceChildren();
    var lib = library(item.libraryId);
    [['Nazwa pliku', item.name], ['Format', item.format], ['Rozdzielczość', item.width && item.height ? item.width + ' × ' + item.height + ' px' : 'Niedostępna dla tego formatu'], ['Rozmiar pliku', item.size < 1048576 ? (item.size / 1024).toFixed(1) + ' KB' : (item.size / 1048576).toFixed(2) + ' MB'], ['Biblioteka / folder', (lib ? lib.name : '') + (item.path.length > 1 ? ' / ' + item.path.slice(0,-1).join(' / ') : '')]].forEach(function (row) {
      root.appendChild(node('div', '', row[0] + ': ' + row[1]));
    });
    byId('assetsInfo').classList.remove('assets-hidden');
  }
  function addTiles(items) {
    var root = byId('assetsTileGrid');
    items.forEach(function (item) {
      catalog.push(item);
      var tile = node('div', 'assets-tile');
      var open = button('', function () { openHelper({type: 'use-path', id: item.libraryId, path: item.path}); });
      open.className = 'assets-tile-open'; open.title = 'Wstaw asset • PPM: podgląd';
      open.addEventListener('contextmenu', function (event) { event.preventDefault(); showPreview(item); });
      var imageWrap = node('span', 'assets-tile-image');
      if (item.preview) { var image = document.createElement('img'); image.src = item.preview; image.alt = ''; imageWrap.appendChild(image); }
      else imageWrap.appendChild(node('span', 'assets-tile-placeholder', item.format));
      open.appendChild(imageWrap); open.appendChild(node('span', 'assets-tile-name', item.name));
      var tools = node('div', 'assets-tile-tools');
      var info = button('ⓘ', function () { showInfo(item); }); info.className = 'assets-tile-info'; info.title = 'Informacje o assecie';
      var old = state.files.find(function (file) { return file.id === item.id; });
      var star = button(old && old.favorite ? '★' : '☆', function () {
        var tracked = state.files.find(function (file) { return file.id === item.id; });
        if (!tracked) { tracked = {id: item.id, name: item.name, libraryId: item.libraryId, path: item.path, count: 0, lastUsed: 0, favorite: false}; state.files.push(tracked); }
        toggleFavorite(tracked); star.textContent = tracked.favorite ? '★' : '☆';
      }); star.className = 'assets-tile-fav'; star.title = 'Ulubione';
      tools.appendChild(info); tools.appendChild(star);
      tile.appendChild(open); tile.appendChild(tools); root.appendChild(tile);
    });
    byId('assetsCatalogState').textContent = 'Assety: ' + catalog.length + (catalogComplete ? '' : ' • wczytywanie…');
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
    message('Otwórz bibliotekę, aby ponownie sprawdzić dostępność i zmiany w plikach.');
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
      var browse = button('Otwórz bibliotekę', function () { openLibrary(lib.id); }, !lib.enabled);
      browse.className = 'assets-choose';
      actions.appendChild(browse);
      var choose = button(unavailable ? 'FOLDER NIEDOSTĘPNY' : 'Wybierz plik', unavailable ? null : function () { openHelper({type: 'pick', id: lib.id}); }, !lib.enabled || unavailable);
      choose.className = 'assets-choose';
      actions.appendChild(choose);
      actions.appendChild(button('Odśwież', function () { refreshLocal(lib.id); }));
      actions.appendChild(button(lib.enabled ? 'Wyłącz' : 'Włącz', function () { openHelper({type: 'toggle', id: lib.id}); }));
      actions.appendChild(button('Usuń z Kubixsio Tools', function () { openHelper({type: 'remove', id: lib.id}); }));
      actions.appendChild(node('p', 'assets-muted assets-location-note', '„Wybierz plik” otwiera systemowe okno jako alternatywny sposób wstawienia.'));
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
  function exportSelectedLayer(id) {
    var source = null, temporary = null;
    try {
      source = app.activeDocument;
      if (!source) throw new Error('Otwórz dokument i zaznacz warstwę.');
      var selected = source.activeLayer;
      if (!selected) throw new Error('Zaznacz warstwę do zapisania.');
      if (!selected.visible) throw new Error('Zaznaczona warstwa jest ukryta.');
      if (selected.isBackgroundLayer) throw new Error('Zamień Background na zwykłą warstwę przed zapisaniem do ASSETS.');
      var w = Number(source.width), h = Number(source.height);
      if (!(w > 0 && h > 0)) throw new Error('Nie udało się odczytać wymiarów dokumentu.');
      temporary = app.documents.add(w, h, 72, 'KUBIXSIO ASSET', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
      selected.duplicate(temporary, ElementPlacement.PLACEATBEGINNING);
      app.activeDocument = temporary;
      // The new document has only the chosen layer on a transparent canvas.
      // Trimming removes transparent margins when Photopea supports it.
      try { temporary.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (_) {}
      temporary.saveToOE('png');
      app.echoToOE('KTX_ASSET_EXPORT_OK|' + id);
    } catch (e) { app.echoToOE('KTX_ASSET_EXPORT_ERR|' + id + '|' + e.toString()); }
    finally {
      if (temporary) try { temporary.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {}
      if (source) try { app.activeDocument = source; } catch (_) {}
    }
  }
  function startExport(data) {
    if (!exportState || exportState.stage !== 'permission' || exportState.libraryId !== data.id || exportState.name !== data.name) return;
    exportState.stage = 'exporting';
    setStatus('ASSETS: eksportuję zaznaczoną warstwę…', 'busy');
    postScript('(' + exportSelectedLayer.toString() + ')(' + JSON.stringify(exportState.id) + ');');
  }
  function failExport(reason) {
    if (!exportState) return;
    exportState = null;
    setStatus('ASSETS: ' + reason, 'err');
    message(reason, true);
    sendToHelper({type:'write-cancel', reason:reason});
  }
  window.addEventListener('message', function (event) {
    if (event.origin === ORIGIN && popup && event.source === popup && event.data && event.data.type === 'KT_ASSETS' && event.data.channel === channel) {
      var data = event.data;
      if (data.event === 'ready') sendToHelper(command);
      if (data.event === 'snapshot' && data.snapshot) {
        var previous = state.files;
        state = data.snapshot;
        restoreFavorites(previous);
        saveState();
        render();
        if (currentLibraryId && !library(currentLibraryId)) { choosePlace(''); showLibraries(); }
        if (command && command.type === 'sync') message('Biblioteki wczytane.');
      }
      if (data.event === 'catalog-start' && data.id === currentLibraryId) {
        catalog = []; catalogComplete = false;
        byId('assetsTileGrid').replaceChildren();
        byId('assetsCatalogState').textContent = 'Wczytuję assety…';
      }
      if (data.event === 'catalog-items' && data.id === currentLibraryId && Array.isArray(data.items)) addTiles(data.items);
      if (data.event === 'catalog-complete' && data.id === currentLibraryId) {
        catalogComplete = true;
        byId('assetsCatalogState').textContent = catalog.length ? 'Assety: ' + catalog.length : 'Ten folder nie zawiera obsługiwanych assetów.';
      }
      if (data.event === 'catalog-error' && data.id === currentLibraryId) byId('assetsCatalogState').textContent = data.reason;
      if (data.event === 'write-ready') startExport(data);
      if (data.event === 'write-complete' && exportState && data.id === exportState.libraryId && data.name === exportState.name) {
        var savedName = exportState.name;
        exportState = null;
        currentLibraryId = data.id; choosePlace(data.id);
        byId('assetsSavePanel').classList.add('assets-hidden');
        byId('assetsLibraryView').classList.remove('assets-hidden');
        byId('assetsLibraryTitle').textContent = library(data.id) ? library(data.id).name : '';
        message('Zapisano ' + savedName + ' do ASSETS.');
        setStatus('ASSETS: zapisano ' + savedName, '');
      }
      if (data.event === 'asset') beginImport(data);
      if (data.event === 'error') { if (exportState) failExport(data.reason || 'Nie udało się zapisać warstwy.'); else message(data.reason, true); }
      return;
    }
    if (exportState && event.source === window.parent) {
      if (event.data instanceof ArrayBuffer && exportState.stage === 'exporting') { exportState.buffer = event.data; return; }
      if (typeof event.data === 'string') {
        var ok = 'KTX_ASSET_EXPORT_OK|' + exportState.id;
        var err = 'KTX_ASSET_EXPORT_ERR|' + exportState.id + '|';
        if (event.data === ok) { exportState.ack = true; return; }
        if (event.data.indexOf(err) === 0) { failExport(event.data.substring(err.length)); return; }
        if (event.data === 'done' && exportState.stage === 'exporting') {
          if (!exportState.ack || !exportState.buffer) { failExport('Nie udało się otrzymać PNG zaznaczonej warstwy.'); return; }
          exportState.stage = 'writing';
          var out = exportState.buffer;
          exportState.buffer = null;
          sendToHelper({type:'write-buffer', buffer:out}, [out]);
          return;
        }
      }
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
  byId('assetsSave').addEventListener('click', showSaveForm);
  byId('assetsSaveHere').addEventListener('click', showSaveForm);
  byId('assetsSaveConfirm').addEventListener('click', confirmSave);
  byId('assetsBack').addEventListener('click', goBack);
  byId('assetsPreviewClose').addEventListener('click', closePreview);
  byId('assetsPreview').addEventListener('click', function (event) { if (event.target === event.currentTarget) closePreview(); });
  byId('assetsInfoClose').addEventListener('click', function () { byId('assetsInfo').classList.add('assets-hidden'); });
  byId('assetsInfo').addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.classList.add('assets-hidden'); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closePreview(); byId('assetsInfo').classList.add('assets-hidden'); } });
  render();
})();
