(function () {
  'use strict';
  var ORIGIN = location.origin;
  var CACHE_KEY = 'kubixsio-assets-panel-v1';
  var FAVORITES_KEY = 'kubixsio-assets-favorites-v1';
  var PLACE_KEY = 'kubixsio-assets-place-v1';
  var PATH_KEY = 'kubixsio-assets-folder-path-v1';
  var DIRECTORY_READY_KEY = 'kubixsio-assets-directories-ready-v1';
  var popup = null, channel = '', command = null, importState = null, exportState = null;
  var state = {libraries: [], files: [], lastLibrary: null};
  var favorites = {};
  var expandedLibraryId = null;
  var currentLibraryId = null, catalog = [], catalogFolders = [], folderPath = [], savePath = [], saveReturnId = null;
  var catalogComplete = false, catalogId = null, catalogPath = [], savedPlace = '', catalogProgress = '';
  // Each directory is indexed separately. Opening one folder never scans its siblings
  // or descendants, and completed directories survive panel / Photopea restarts.
  var directories = Object.create(null);
  var directoryLoads = Object.create(null), directoryEpoch = Object.create(null), directoryDeletes = Object.create(null);
  var directoryFinishes = Object.create(null);
  var directoryDatabase = null;
  var savedDirectories = {};
  try { savedDirectories = JSON.parse(localStorage.getItem(DIRECTORY_READY_KEY)) || {}; } catch (_) {}
  function directoryKey(id, path) { return id + ':' + JSON.stringify(Array.isArray(path) ? path : []); }
  function markDirectory(key, exists) {
    if (exists) savedDirectories[key] = true; else delete savedDirectories[key];
    try { localStorage.setItem(DIRECTORY_READY_KEY, JSON.stringify(savedDirectories)); } catch (_) {}
  }
  function indexDatabase() {
    if (directoryDatabase) return directoryDatabase;
    directoryDatabase = new Promise(function (resolve, reject) {
      var request = indexedDB.open('kubixsio-assets-directories-v1', 1);
      request.onupgradeneeded = function () { request.result.createObjectStore('directories', {keyPath:'key'}); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Baza folderów jest zablokowana przez inne okno.')); };
    }).catch(function (e) { directoryDatabase = null; throw e; });
    return directoryDatabase;
  }
  async function indexAction(method, value) {
    var db = await indexDatabase();
    return new Promise(function (resolve, reject) {
      var readonly = method === 'get' || method === 'getAllKeys';
      var tx = db.transaction('directories', readonly ? 'readonly' : 'readwrite');
      var result, store = tx.objectStore('directories');
      var request = value === undefined ? store[method]() : store[method](value);
      request.onsuccess = function () { result = request.result; };
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error || new Error('Nie udało się zapisać folderu.')); };
      tx.onabort = function () { reject(tx.error || new Error('Zapis folderu przerwany.')); };
    });
  }
  function directoryEntry(id, path) {
    var key = directoryKey(id, path);
    return directories[key] || (directories[key] = {key:key, id:id, path:path.slice(), items:[], folders:[], complete:false, progress:''});
  }
  function selectDirectory(id, path) {
    catalogId = id; catalogPath = path.slice();
    var entry = directoryEntry(id, path);
    catalog = entry.items; catalogFolders = entry.folders;
    catalogComplete = entry.complete; catalogProgress = entry.progress;
    return entry;
  }
  function storedDirectory(key) {
    return indexAction('get', key).then(function (record) {
      return record && record.complete === true && record.version === 1 && Array.isArray(record.path) &&
        Array.isArray(record.folders) && Array.isArray(record.items) ? record : null;
    });
  }
  async function persistDirectory(entry) {
    var record = {key:entry.key, id:entry.id, path:entry.path, version:1, complete:true, folders:entry.folders, items:entry.items};
    try { await indexAction('put', record); return true; }
    catch (_) {
      await indexAction('put', Object.assign({}, record, {items:entry.items.map(function (item) { return Object.assign({}, item, {preview:null}); })}));
      return false;
    }
  }
  function renderDirectoryViews(id, path) {
    if (currentLibraryId === id && samePath(folderPath, path)) { selectDirectory(id, path); renderDirectory(); }
    if (!byId('assetsSavePanel').classList.contains('assets-hidden') && byId('assetsSaveLibrary').value === id && samePath(savePath, path)) renderSaveFolders();
  }
  function browseDirectory(id, path) {
    if (popup && !popup.closed && command && command.type === 'browse-path' && command.id === id && samePath(command.path || [], path)) return;
    openHelper({type:'browse-path', id:id, path:path.slice()});
  }
  function requestDirectory(id, path) {
    var key = directoryKey(id, path), entry = directoryEntry(id, path);
    if (entry.complete) { renderDirectoryViews(id, path); return; }
    if (directoryLoads[key]) return;
    // First access is opened directly from the click so the browser cannot block the helper.
    if (!savedDirectories[key]) { browseDirectory(id, path); return; }
    var epoch = directoryEpoch[key] || 0;
    directoryLoads[key] = Promise.resolve(directoryDeletes[key]).then(function () { return storedDirectory(key); }).then(function (saved) {
      if (epoch !== (directoryEpoch[key] || 0)) return;
      if (saved) {
        directories[key] = {key:key, id:id, path:path.slice(), items:saved.items, folders:saved.folders, complete:true, progress:''};
        renderDirectoryViews(id, path);
      } else {
        markDirectory(key, false);
        message('Zapis folderu zniknął. Kliknij go ponownie, aby wczytać tylko ten folder.', true);
      }
    }).catch(function () {
      markDirectory(key, false);
      message('Nie można otworzyć zapisanej listy. Kliknij folder ponownie.', true);
    }).finally(function () { delete directoryLoads[key]; });
  }
  function finishDirectory(data) {
    var path = Array.isArray(data.path) ? data.path : [], key = directoryKey(data.id, path);
    var entry = directories[key], epoch = directoryEpoch[key] || 0;
    if (!entry || !entry.complete) return;
    directoryFinishes[key] = data.scan;
    Promise.resolve(directoryDeletes[key]).then(function () { return persistDirectory(entry); }).then(function (previewsSaved) {
      if (epoch !== (directoryEpoch[key] || 0)) return;
      markDirectory(key, true);
      sendToHelper({type:'directory-saved', id:data.id, path:path, scan:data.scan, ok:true, previewsSaved:previewsSaved});
      if (!previewsSaved) message('Folder zapisany, ale zabrakło miejsca na miniaturki. Zostaną pokazane nazwy plików.', true);
    }).catch(function (e) {
      sendToHelper({type:'directory-saved', id:data.id, path:path, scan:data.scan, ok:false, reason:e.message || String(e)});
      message('Nie udało się trwale zapisać folderu. Sprawdź miejsce w przeglądarce.', true);
    });
  }
  function invalidateDirectory(id, path) {
    var key = directoryKey(id, path);
    directoryEpoch[key] = (directoryEpoch[key] || 0) + 1;
    markDirectory(key, false);
    delete directories[key];
    directoryDeletes[key] = indexAction('delete', key).catch(function () {});
  }
  function clearLibraryDirectories(id) {
    var keys = {};
    Object.keys(directories).forEach(function (key) { if (directories[key].id === id) { keys[key] = true; delete directories[key]; } });
    Object.keys(savedDirectories).forEach(function (key) { if (key.indexOf(id + ':') === 0) { keys[key] = true; markDirectory(key, false); } });
    Object.keys(keys).forEach(function (key) { directoryEpoch[key] = (directoryEpoch[key] || 0) + 1; });
    return indexAction('getAllKeys').then(function (keys) {
      return Promise.all(keys.filter(function (key) { return String(key).indexOf(id + ':') === 0; }).map(function (key) { return indexAction('delete', key); }));
    });
  }

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
    } else if (savedPlace && library(savedPlace) && library(savedPlace).enabled) {
      var lastPath = [];
      try { lastPath = JSON.parse(localStorage.getItem(PATH_KEY)) || []; } catch (_) {}
      openLibrary(savedPlace, Array.isArray(lastPath) ? lastPath : []);
    }
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
      if (saveReturnId && library(saveReturnId) && library(saveReturnId).enabled) openLibrary(saveReturnId, folderPath);
      else showLibraries();
      return;
    }
    if (currentLibraryId && folderPath.length) { folderPath.pop(); openDirectory(folderPath); return; }
    if (currentLibraryId) { choosePlace(''); showLibraries(); return; }
    byId('assetsBrowser').classList.add('assets-hidden');
    byId('assetsHome').classList.remove('assets-hidden');
    byId('assetsEntry').setAttribute('aria-expanded', 'true');
  }
  function openDirectory(path) {
    if (!currentLibraryId) return;
    folderPath = Array.isArray(path) ? path.slice() : [];
    selectDirectory(currentLibraryId, folderPath);
    renderDirectory();
    if (!catalogComplete) requestDirectory(currentLibraryId, folderPath);
  }
  function openLibrary(id, path) {
    var lib = library(id);
    if (!lib || !lib.enabled) { showLibraries(); return; }
    currentLibraryId = id;
    folderPath = Array.isArray(path) ? path.slice() : [];
    choosePlace(id);
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    byId('assetsOverview').classList.add('assets-hidden');
    byId('assetsSavePanel').classList.add('assets-hidden');
    byId('assetsLibraryView').classList.remove('assets-hidden');
    byId('assetsTileGrid').replaceChildren(); byId('assetsFolderList').replaceChildren();
    openDirectory(folderPath);
  }
  function showSaveForm() {
    if (importState || exportState) { message('Poczekaj na zakończenie poprzedniego działania.', true); return; }
    var select = byId('assetsSaveLibrary');
    select.replaceChildren();
    state.libraries.filter(function (lib) { return lib.enabled; }).forEach(function (lib) {
      var option = node('option', '', lib.name); option.value = lib.id; select.appendChild(option);
    });
    if (currentLibraryId && library(currentLibraryId) && library(currentLibraryId).enabled) select.value = currentLibraryId;
    saveReturnId = currentLibraryId;
    savePath = select.value === currentLibraryId ? folderPath.slice() : [];
    byId('assetsHome').classList.add('assets-hidden');
    byId('assetsBrowser').classList.remove('assets-hidden');
    byId('assetsOverview').classList.add('assets-hidden');
    byId('assetsLibraryView').classList.add('assets-hidden');
    byId('assetsSavePanel').classList.remove('assets-hidden');
    if (!select.options.length) message('Dodaj i włącz bibliotekę przed zapisem.', true);
    loadSaveFolders();
    byId('assetsSaveName').focus();
  }
  function samePath(a, b) { return a.length === b.length && a.every(function (part, index) { return part === b[index]; }); }
  function childFolders(path, entry) {
    var folders = entry ? entry.folders : catalogFolders;
    return folders.filter(function (parts) { return parts.length === path.length + 1 && samePath(parts.slice(0,-1), path); })
      .sort(function (a,b) { return a[a.length-1].localeCompare(b[b.length-1], 'pl'); });
  }
  function renderSaveFolders() {
    var root = byId('assetsSaveFolders'); root.replaceChildren();
    var id = byId('assetsSaveLibrary').value, lib = library(id), entry = id ? directoryEntry(id, savePath) : null;
    byId('assetsSaveFolderPath').textContent = 'Zapis do: ' + (lib ? lib.name : '') + (savePath.length ? ' / ' + savePath.join(' / ') : '');
    if (savePath.length) root.appendChild(button('← Folder wyżej', function () {
      savePath.pop(); renderSaveFolders(); requestDirectory(id, savePath);
    }));
    if (!entry || !entry.complete) root.appendChild(node('p', 'assets-muted', entry && entry.progress || 'Wczytuję tylko ten folder…'));
    childFolders(savePath, entry || {folders:[]}).forEach(function (parts) {
      var folder = button('📁 ' + parts[parts.length-1] + ' ›', function () {
        savePath = parts.slice(); renderSaveFolders(); requestDirectory(id, savePath);
      });
      folder.className = 'assets-folder-entry'; root.appendChild(folder);
    });
  }
  function loadSaveFolders() {
    var id = byId('assetsSaveLibrary').value;
    savePath = id === currentLibraryId ? folderPath.slice() : [];
    renderSaveFolders();
    if (id && !directoryEntry(id, savePath).complete) requestDirectory(id, savePath);
  }
  function confirmSave() {
    if (exportState) { message('Trwa już zapis warstwy.', true); return; }
    var id = byId('assetsSaveLibrary').value, name = byId('assetsSaveName').value.trim();
    if (!id || !library(id)) { message('Wybierz bibliotekę.', true); return; }
    if (!name) { message('Podaj nazwę pliku.', true); return; }
    if (!/\.png$/i.test(name)) name += '.png';
    if (!/^[^\\/:*?"<>|\x00-\x1f]+\.png$/i.test(name) || /[. ]\.png$/i.test(name)) { message('Podaj poprawną nazwę pliku PNG.', true); return; }
    if (vignetteStage !== 'idle' || watermarkStage !== 'idle' || window.folderizeBusy || importState) { message('Photopea wykonuje inne działanie.', true); return; }
    if (!directoryEntry(id, savePath).complete) { message('Poczekaj, aż ten folder zostanie wczytany.', true); return; }
    exportState = {id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), libraryId: id, name: name, path: savePath.slice(), stage: 'permission', buffer: null};
    openHelper({type: 'save-layer', id: id, name: name, path: savePath.slice()});
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
  }
  function renderDirectory() {
    if (!currentLibraryId || catalogId !== currentLibraryId || !samePath(catalogPath, folderPath)) return;
    try { localStorage.setItem(PATH_KEY, JSON.stringify(folderPath)); } catch (_) {}
    var lib = library(currentLibraryId), root = byId('assetsFolderList'), tiles = byId('assetsTileGrid');
    root.replaceChildren(); tiles.replaceChildren();
    byId('assetsLibraryTitle').textContent = (lib ? lib.name : '') + (folderPath.length ? ' / ' + folderPath.join(' / ') : '');
    var folders = childFolders(folderPath);
    folders.forEach(function (parts) {
      var entry = button('📁 ' + parts[parts.length-1] + ' ›', function () { openDirectory(parts); });
      entry.className = 'assets-folder-entry'; root.appendChild(entry);
    });
    // When a directory contains both subfolders and files, keep its files reachable
    // through a separate entry while keeping the folder list compact.
    var files = catalog.filter(function (item) { return samePath(item.path.slice(0,-1), folderPath); });
    if (!folders.length) addTiles(files);
    else if (files.length) {
      root.appendChild(button('Obrazy w tym folderze (' + files.length + ') ›', function () {
        root.replaceChildren();
        root.appendChild(button('← Podfoldery', renderDirectory));
        tiles.replaceChildren(); addTiles(files);
      }));
    }
    byId('assetsCatalogState').textContent = catalogComplete ?
      (folders.length ? 'Podfoldery: ' + folders.length : 'Assety: ' + files.length) + (folders.length || files.length ? '' : ' • Brak obsługiwanych plików w tym folderze.') : catalogProgress || 'Wczytuję foldery…';
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
    if (popup && !popup.closed && command && command.type === 'browse-path' && command.id === id) {
      popup.close(); popup = null; command = null; channel = '';
    }
    clearLibraryDirectories(id).catch(function () {
      message('Nie udało się usunąć zapisanego katalogu. Spróbuj ponownie.', true);
    });
    if (catalogId === id) selectDirectory(id, folderPath);
    message('Cache biblioteki wyczyszczony. Foldery będą ponownie wczytywane dopiero po ich otwarciu.');
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
      var head = button('', function () { openLibrary(lib.id); }, !lib.enabled);
      head.className = 'assets-card-head';
      head.appendChild(node('span', 'assets-title', '📁 ' + lib.name));
      var status = !lib.enabled ? 'wyłączony' : lib.status === 'unavailable' ? 'folder niedostępny' : lib.status === 'permission' ? 'wymaga dostępu' : 'gotowy';
      head.appendChild(node('span', 'assets-state' + (lib.status === 'unavailable' && lib.enabled ? ' unavailable' : ''), status));
      var manage = button('⋯', function () {
        expandedLibraryId = expandedLibraryId === lib.id ? null : lib.id;
        render();
        var newManage = byId('assetsLibraryManage-' + lib.id);
        if (newManage && newManage.focus) newManage.focus({preventScroll: true});
      });
      manage.className = 'assets-manage'; manage.id = 'assetsLibraryManage-' + lib.id;
      manage.title = 'Opcje biblioteki'; manage.setAttribute('aria-label', 'Opcje biblioteki ' + lib.name);
      manage.setAttribute('aria-expanded', String(expanded)); manage.setAttribute('aria-controls', 'assetsLibraryActions-' + lib.id);
      var actions = node('div', 'assets-actions' + (expanded ? '' : ' assets-hidden'));
      actions.id = 'assetsLibraryActions-' + lib.id;
      var unavailable = lib.status === 'unavailable';
      var choose = button(unavailable ? 'FOLDER NIEDOSTĘPNY' : 'Wybierz plik', unavailable ? null : function () { openHelper({type: 'pick', id: lib.id}); }, !lib.enabled || unavailable);
      choose.className = 'assets-choose';
      actions.appendChild(choose);
      actions.appendChild(button('Odśwież', function () { refreshLocal(lib.id); }));
      actions.appendChild(button(lib.enabled ? 'Wyłącz' : 'Włącz', function () { openHelper({type: 'toggle', id: lib.id}); }));
      actions.appendChild(button('Usuń z Kubixsio Tools', function () { openHelper({type: 'remove', id: lib.id}); }));
      actions.appendChild(node('p', 'assets-muted assets-location-note', '„Wybierz plik” otwiera systemowe okno jako alternatywny sposób wstawienia.'));
      var top = node('div', 'assets-card-top'); top.appendChild(head); top.appendChild(manage);
      card.appendChild(top);card.appendChild(actions);root.appendChild(card);
    });
    var files = state.files.filter(function (f) { return library(f.libraryId); });
    section('assetsFavorites', 'ULUBIONE', files.filter(function (f) {return f.favorite;}), false);
    section('assetsRecent', 'OSTATNIO UŻYWANE', files.filter(function (f) { return f.lastUsed; }).sort(function (a,b) {return b.lastUsed-a.lastUsed;}).slice(0,5), false);
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
      var w = Number(source.width), h = Number(source.height);
      if (!(w > 0 && h > 0)) throw new Error('Nie udało się odczytać wymiarów dokumentu.');
      temporary = app.documents.add(w, h, 72, 'KUBIXSIO ASSET', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
      var starter = temporary.activeLayer;
      // Register the temporary document immediately, so every failure path can close it.
      window.ktxAssetsExport = {id:id, source:source, temporary:temporary};
      selected.duplicate(temporary, ElementPlacement.PLACEATBEGINNING);
      app.activeDocument = temporary;
      // Remove only the exact empty layer created with the temporary document.
      if (starter && temporary.layers.length > 1) try { starter.remove(); } catch (_) {}
      try { temporary.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (_) {}
      temporary.saveToOE('png');
    } catch (e) {
      window.ktxAssetsExport = null;
      if (temporary) try { temporary.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {}
      if (source) try { app.activeDocument = source; } catch (_) {}
      app.echoToOE('KTX_ASSET_EXPORT_ERR|' + id + '|' + e.toString());
    }
  }
  function closePreparedLayer(id) {
    try {
      var job = window.ktxAssetsExport;
      if (job && job.id === id) {
        window.ktxAssetsExport = null;
        try { job.temporary.close(SaveOptions.DONOTSAVECHANGES); }
        finally { app.activeDocument = job.source; }
      }
      app.echoToOE('KTX_ASSET_CLOSED|' + id);
    } catch (e) { app.echoToOE('KTX_ASSET_EXPORT_ERR|' + id + '|' + e.toString()); }
  }
  function startExport(data) {
    if (!exportState || exportState.stage !== 'permission' || exportState.libraryId !== data.id || exportState.name !== data.name || !samePath(exportState.path, data.path || [])) return;
    exportState.stage = 'saving'; exportState.done = false; exportState.buffer = null;
    setStatus('ASSETS: eksportuję zaznaczoną warstwę…', 'busy');
    postScript('(' + exportSelectedLayer.toString() + ')(' + JSON.stringify(exportState.id) + ');');
  }
  function finishExport() {
    if (!exportState || exportState.stage !== 'saving' || !exportState.buffer || !exportState.done) return;
    exportState.stage = 'cleaning';
    if (exportState.timer) clearTimeout(exportState.timer);
    exportState.timer = null; exportState.ack = false; exportState.cleanupDone = false;
    postScript('(' + closePreparedLayer.toString() + ')(' + JSON.stringify(exportState.id) + ');');
  }
  function finishCleanup() {
    if (!exportState || exportState.stage !== 'cleaning' || !exportState.ack || !exportState.cleanupDone || !exportState.buffer) return;
    if (exportState.timer) clearTimeout(exportState.timer);
    exportState.stage = 'writing';
    var out = exportState.buffer;
    exportState.buffer = null;
    sendToHelper({type:'write-buffer', buffer:out}, [out]);
  }
  function failExport(reason) {
    if (!exportState) return;
    var failed = exportState;
    if (failed.timer) clearTimeout(failed.timer);
    exportState = null;
    if (failed.stage === 'saving' || failed.stage === 'cleaning')
      postScript('(' + closePreparedLayer.toString() + ')(' + JSON.stringify(failed.id) + ');');
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
        Object.keys(directories).forEach(function (key) { if (!library(directories[key].id)) delete directories[key]; });
        restoreFavorites(previous);
        saveState();
        render();
        if (currentLibraryId && !library(currentLibraryId)) { choosePlace(''); showLibraries(); }
        if (command && command.type === 'sync') message('Biblioteki wczytane.');
      }
      if (data.event === 'directory-start' && Array.isArray(data.path)) {
        var startKey = directoryKey(data.id, data.path);
        directories[startKey] = {key:startKey, id:data.id, path:data.path.slice(), items:[], folders:[], complete:false, progress:'Wczytuję tylko ten folder…'};
        renderDirectoryViews(data.id, data.path);
      }
      if (data.event === 'directory-progress' && Array.isArray(data.path)) {
        var progressEntry = directoryEntry(data.id, data.path);
        progressEntry.progress = 'Miniaturki: ' + data.done + '/' + data.total + ' (' + data.percent + '%)';
        renderDirectoryViews(data.id, data.path);
      }
      if (data.event === 'directory-complete' && Array.isArray(data.path)) {
        var completedKey = directoryKey(data.id, data.path), completed = directoryEntry(data.id, data.path);
        completed.folders = Array.isArray(data.folders) ? data.folders : [];
        completed.items = Array.isArray(data.items) ? data.items : [];
        completed.complete = true; completed.progress = '';
        directories[completedKey] = completed;
        renderDirectoryViews(data.id, data.path);
        finishDirectory(data);
      }
      if (data.event === 'directory-save-retry' && Array.isArray(data.path)) {
        var retryKey = directoryKey(data.id, data.path);
        if (directories[retryKey] && directoryFinishes[retryKey] === data.scan) finishDirectory(data);
      }
      if (data.event === 'directory-error' && Array.isArray(data.path)) {
        var errorKey = directoryKey(data.id, data.path);
        delete directories[errorKey]; markDirectory(errorKey, false);
        if (data.id === currentLibraryId && samePath(data.path, folderPath)) byId('assetsCatalogState').textContent = data.reason;
        if (!byId('assetsSavePanel').classList.contains('assets-hidden') && byId('assetsSaveLibrary').value === data.id && samePath(data.path, savePath))
          byId('assetsSaveFolders').replaceChildren(node('p','assets-muted',data.reason));
      }
      if (data.event === 'write-ready') startExport(data);
      if (data.event === 'write-complete' && exportState && data.id === exportState.libraryId && data.name === exportState.name && samePath(data.path || [], exportState.path)) {
        var savedName = exportState.name, savedPath = exportState.path.slice();
        exportState = null;
        invalidateDirectory(data.id, savedPath);
        currentLibraryId = data.id; folderPath = savedPath; choosePlace(data.id);
        byId('assetsSavePanel').classList.add('assets-hidden'); byId('assetsLibraryView').classList.remove('assets-hidden');
        selectDirectory(data.id, savedPath); renderDirectory();
        message('Zapisano ' + savedName + ' do ASSETS.');
        setStatus('ASSETS: zapisano ' + savedName, '');
      }
      if (data.event === 'asset') beginImport(data);
      if (data.event === 'error') { if (exportState) failExport(data.reason || 'Nie udało się zapisać warstwy.'); else message(data.reason, true); }
      return;
    }
    if (exportState && event.source === window.parent) {
      if (event.data instanceof ArrayBuffer && exportState.stage === 'saving') {
        exportState.buffer = event.data; finishExport(); return;
      }
      if (typeof event.data === 'string') {
        var err = 'KTX_ASSET_EXPORT_ERR|' + exportState.id + '|';
        if (event.data.indexOf(err) === 0) { failExport(event.data.substring(err.length)); return; }
        if (event.data === 'KTX_ASSET_CLOSED|' + exportState.id && exportState.stage === 'cleaning') {
          exportState.ack = true; finishCleanup(); return;
        }
        if (event.data === 'done' && exportState.stage === 'saving') {
          exportState.done = true;
          finishExport();
          if (exportState && exportState.stage === 'saving' && !exportState.timer) exportState.timer = setTimeout(function () {
            if (exportState && exportState.stage === 'saving') failExport('Photopea nie zwróciła PNG zaznaczonej warstwy.');
          }, 20000);
          return;
        }
        if (event.data === 'done' && exportState.stage === 'cleaning') {
          exportState.cleanupDone = true;
          finishCleanup();
          if (exportState && exportState.stage === 'cleaning' && !exportState.timer) exportState.timer = setTimeout(function () {
            if (exportState && exportState.stage === 'cleaning') failExport('Nie udało się zamknąć tymczasowego projektu po eksporcie.');
          }, 10000);
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
  byId('assetsSaveLibrary').addEventListener('change', loadSaveFolders);
  byId('assetsQuickToggle').addEventListener('click', function () {
    var lists = byId('assetsQuickLists'), open = lists.classList.contains('assets-hidden');
    lists.classList.toggle('assets-hidden', !open);
    byId('assetsQuickToggle').setAttribute('aria-expanded', String(open));
  });
  byId('assetsBack').addEventListener('click', goBack);
  byId('assetsPreviewClose').addEventListener('click', closePreview);
  byId('assetsPreview').addEventListener('click', function (event) { if (event.target === event.currentTarget) closePreview(); });
  byId('assetsInfoClose').addEventListener('click', function () { byId('assetsInfo').classList.add('assets-hidden'); });
  byId('assetsInfo').addEventListener('click', function (event) { if (event.target === event.currentTarget) event.currentTarget.classList.add('assets-hidden'); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closePreview(); byId('assetsInfo').classList.add('assets-hidden'); } });
  render();
})();
