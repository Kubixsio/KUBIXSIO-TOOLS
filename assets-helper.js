(function () {
  'use strict';
  var channel = new URL(location.href).searchParams.get('channel');
  var title = document.getElementById('helperTitle');
  var content = document.getElementById('helperContent');
  var status = document.getElementById('helperStatus');
  var db, pending = null, busy = false;

  function label(text, error) { status.textContent = text || ''; status.className = 'assets-message' + (error ? ' error' : ''); }
  function node(tag, text, className) { var el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
  function button(text, action) { var el = node('button', text); el.type = 'button'; el.addEventListener('click', action); return el; }
  function screen(heading) { title.textContent = heading; content.replaceChildren(); label(''); }
  function send(event, extra, transfer) {
    if (!window.opener) { label('Połączenie z panelem Photopea zostało zamknięte. Otwórz to okno z ASSETS.', true); return; }
    window.opener.postMessage(Object.assign({type: 'KT_ASSETS', channel: channel, event: event}, extra || {}), location.origin, transfer || []);
  }
  function idb(mode, store, method, value) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(store, mode), request = transaction.objectStore(store)[method](value);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  function all(store) { return idb('readonly', store, 'getAll'); }
  function get(store, id) { return idb('readonly', store, 'get', id); }
  function put(store, value) { return idb('readwrite', store, 'put', value); }
  function remove(store, id) { return idb('readwrite', store, 'delete', id); }
  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('kubixsio-assets-v1', 2);
      request.onupgradeneeded = function () {
        var database = request.result;
        var hasStore = function (name) { return database.objectStoreNames && database.objectStoreNames.contains && database.objectStoreNames.contains(name); };
        if (!hasStore('libraries')) database.createObjectStore('libraries', {keyPath: 'id'});
        if (!hasStore('files')) database.createObjectStore('files', {keyPath: 'id'});
        if (!hasStore('settings')) database.createObjectStore('settings', {keyPath: 'key'});
        if (!hasStore('cache')) database.createObjectStore('cache', {keyPath: 'id'});
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  async function available(lib) {
    if (!lib.enabled) return 'disabled';
    if (!lib.handle) return 'unavailable';
    try {
      if ((await lib.handle.queryPermission({mode: 'read'})) !== 'granted') return 'permission';
      var iterator = lib.handle.values();
      await iterator.next();
      return 'ready';
    } catch (_) { return 'unavailable'; }
  }
  async function snapshot() {
    var libs = await all('libraries'), files = await all('files'), place = await get('settings', 'lastLibrary');
    var publicLibs = await Promise.all(libs.map(async function (lib) {
      return {id: lib.id, name: lib.name, enabled: lib.enabled, status: await available(lib)};
    }));
    return {libraries: publicLibs, files: files.map(function (f) {
      return {id: f.id, libraryId: f.libraryId, name: f.name, favorite: !!f.favorite, count: f.count || 0, lastUsed: f.lastUsed || 0};
    }), lastLibrary: place ? place.value : null};
  }
  async function sync() { send('snapshot', {snapshot: await snapshot()}); }
  function error(e) {
    if (e && e.name === 'AbortError') { label('Anulowano wybór.'); return; }
    label(e && e.message ? e.message : String(e), true);
    send('error', {reason: status.textContent});
  }
  async function permission(lib) {
    var state = await lib.handle.queryPermission({mode: 'read'});
    if (state === 'granted') return true;
    state = await lib.handle.requestPermission({mode: 'read'});
    if (state !== 'granted') throw new Error('Brak zgody na dostęp do folderu. Biblioteka pozostaje zapisana.');
    return true;
  }
  async function chosenLibrary(id) {
    var lib = await get('libraries', id);
    if (!lib) throw new Error('Biblioteka nie jest już dostępna w Kubixsio Tools.');
    if (!lib.enabled) throw new Error('Biblioteka jest wyłączona. Włącz ją przed użyciem.');
    return lib;
  }
  function libraryCard(lib, text) {
    content.appendChild(node('div', lib.name, 'assets-title'));
    if (text) content.appendChild(node('p', text, 'assets-muted'));
  }
  function add() {
    screen('DODAJ FOLDER');
    content.appendChild(node('p', 'Wybierz folder na dysku lub pendrivie. Dostęp jest tylko do odczytu.', 'assets-muted'));
    content.appendChild(button('Wybierz folder', async function () {
      if (!window.showDirectoryPicker) { error(new Error('Ta przeglądarka nie obsługuje trwałego dostępu do folderów. Użyj Edge lub Chrome na komputerze.')); return; }
      try {
        var handle = await window.showDirectoryPicker({mode: 'read'});
        screen('NAZWIJ BIBLIOTEKĘ');
        var input = document.createElement('input');
        input.className = 'assets-input'; input.value = handle.name; input.maxLength = 60;
        input.setAttribute('aria-label', 'Nazwa biblioteki');
        content.appendChild(input);
        content.appendChild(button('Zapisz bibliotekę', async function () {
          var name = input.value.trim();
          if (!name) { label('Podaj nazwę biblioteki.', true); return; }
          try {
            await put('libraries', {id: crypto.randomUUID(), name: name, enabled: true, handle: handle});
            await sync();
            screen('FOLDER DODANY');
            content.appendChild(node('p', 'Biblioteka „' + name + '” została zapisana. Możesz zamknąć to okno.', 'assets-muted'));
          } catch (e) { error(e); }
        }));
        input.focus();input.select();
      } catch (e) { error(e); }
    }));
  }
  async function deliver(lib, handle, path, silent) {
    if (busy) return;
    busy = true;
    try {
      var file = await handle.getFile();
      if (!/\.(png|jpe?g|webp|gif|bmp|tiff?|svg|psd|psb|avif|heic|heif|pdf|ai|eps|tga|dds)$/i.test(file.name))
        throw new Error('Ten typ pliku nie jest obsługiwany jako obraz w tej wersji ASSETS.');
      var buffer = await file.arrayBuffer();
      if (!window.opener) throw new Error('Okno Photopea zostało zamknięte.');
      pending = {id: lib.id + ':' + JSON.stringify(path), libraryId: lib.id, name: file.name, path: path};
      // Keep a private browser cache of delivered files. This lets favorite
      // assets be reused when their USB library is temporarily unavailable.
      try { await put('cache', {id: pending.id, name: file.name, buffer: buffer}); } catch (_) {}
      label('Przekazuję asset do Photopea…');
      send('asset', {name: file.name, buffer: buffer}, [buffer]);
      return null;
    } catch (e) { busy = false; if (!silent) error(e); return e; }
  }
  async function deliverCached(item, cached) {
    if (busy) return;
    busy = true;
    try {
      if (!cached || !(cached.buffer instanceof ArrayBuffer)) throw new Error('Brak lokalnej kopii tego ulubionego assetu.');
      if (!window.opener) throw new Error('Okno Photopea zostało zamknięte.');
      pending = {id: item.id, libraryId: item.libraryId, name: item.name, path: item.path};
      label('Wstawiam lokalną kopię ulubionego assetu…');
      var buffer = cached.buffer;
      send('asset', {name: item.name, buffer: buffer}, [buffer]);
    } catch (e) { busy = false; error(e); }
  }
  async function pick(id) {
    try {
      var lib = await chosenLibrary(id);
      await put('settings', {key: 'lastLibrary', value: id});
      var state = await available(lib);
      await sync();
      if (state !== 'ready') {
        screen('FOLDER NIEDOSTĘPNY');
        libraryCard(lib, state === 'permission' ? 'Przeglądarka wymaga ponownego dostępu do tej biblioteki.' : 'Folder jest niedostępny. Podłącz pendrive lub dysk i użyj „Odśwież”.');
        content.appendChild(button('FOLDER NIEDOSTĘPNY', null, true));
        return;
      }
      screen('WYBIERZ ASSET');
      libraryCard(lib, 'Systemowe okno wyboru otworzy się w tym folderze. Możesz wejść też do jego podfolderów.');
      content.appendChild(button('Wybierz plik', async function () {
        try {
          await permission(lib);
          var files = await window.showOpenFilePicker({startIn: lib.handle, id: 'kubixsio-assets'});
          if (!files.length) return;
          var path = await lib.handle.resolve(files[0]);
          if (!path || !path.length) throw new Error('Wybierz plik z biblioteki „' + lib.name + '”, a nie z innego folderu.');
          await deliver(lib, files[0], path);
        } catch (e) { error(e); }
      }));
    } catch (e) { error(e); }
  }
  async function fileFromPath(lib, path) {
    var directory = lib.handle;
    for (var i = 0; i < path.length - 1; i++) directory = await directory.getDirectoryHandle(path[i]);
    return directory.getFileHandle(path[path.length - 1]);
  }
  async function use(id) {
    try {
      var item = await get('files', id);
      if (!item) throw new Error('Nie znaleziono zapisanej pozycji.');
      var lib = await chosenLibrary(item.libraryId);
      var cached = null;
      try { cached = await get('cache', item.id); } catch (_) {}
      screen('WSTAWIAM ASSET');
      libraryCard(lib, item.name);
      // A message from the opener does not give this window user activation.
      // If Edge revokes access after a restart, the permission button is unavoidable.
      var permissionState = 'unavailable';
      try { permissionState = lib.handle && await lib.handle.queryPermission({mode: 'read'}); } catch (_) {}
      if (permissionState !== 'granted') {
        if (item.favorite && cached) { await deliverCached(item, cached); return; }
        label(item.favorite ? 'Brak lokalnej kopii. Podłącz pendrive i użyj tego assetu raz, aby zapisać go offline.' : 'Przeglądarka wymaga ponownego dostępu do folderu.');
        content.appendChild(button('Przywróć dostęp i wstaw', async function () {
          try { await permission(lib); await deliver(lib, await fileFromPath(lib, item.path), item.path); }
          catch (e) { error(e); }
        }));
        return;
      }
      var sourceHandle;
      try { sourceHandle = await fileFromPath(lib, item.path); }
      catch (e) {
        if (item.favorite && cached) { await deliverCached(item, cached); return; }
        throw e;
      }
      var result = await deliver(lib, sourceHandle, item.path, true);
      if (result && item.favorite && cached) { await deliverCached(item, cached); return; }
      if (result) {
        if (item.favorite) label('Brak lokalnej kopii. Podłącz pendrive i użyj tego assetu raz, aby zapisać go offline.', true);
        else error(result);
      }
    } catch (e) { error(e); }
  }
  async function refresh(id) {
    try {
      var lib = await get('libraries', id);
      if (!lib) throw new Error('Nie znaleziono biblioteki.');
      screen('ODŚWIEŻ FOLDER');
      libraryCard(lib, 'Nowe pliki będą widoczne w systemowym oknie wyboru. Sprawdzam dostępność folderu.');
      var state = await available(lib);
      if (state === 'permission') {
        content.appendChild(button('Przywróć dostęp', async function () {
          try { await permission(lib); await refresh(id); } catch (e) { error(e); }
        }));
      } else if (state === 'unavailable') {
        label('Folder niedostępny. Podłącz dysk lub pendrive i spróbuj ponownie.', true);
        content.appendChild(button('Spróbuj ponownie', function () { refresh(id); }));
        content.appendChild(button('Wskaż ten folder ponownie', async function () {
          try {
            var handle = await window.showDirectoryPicker({mode: 'read'});
            lib.handle = handle;
            await put('libraries', lib);
            await refresh(id);
          } catch (e) { error(e); }
        }));
      } else label(state === 'disabled' ? 'Folder jest wyłączony.' : 'Folder jest dostępny.');
      await sync();
    } catch (e) { error(e); }
  }
  async function toggle(id) {
    try {
      var lib = await get('libraries', id);
      if (!lib) throw new Error('Nie znaleziono biblioteki.');
      lib.enabled = !lib.enabled;
      await put('libraries', lib);
      await sync();
      screen('BIBLIOTEKA ' + (lib.enabled ? 'WŁĄCZONA' : 'WYŁĄCZONA'));
      libraryCard(lib, 'Folder i pliki na dysku pozostały bez zmian.');
    } catch (e) { error(e); }
  }
  async function discard(id) {
    try {
      var lib = await get('libraries', id);
      if (!lib) throw new Error('Nie znaleziono biblioteki.');
      screen('USUŃ Z KUBIXSIO TOOLS');
      libraryCard(lib, 'Ta operacja usuwa bibliotekę z listy pluginu. Nie usuwa folderu ani żadnego pliku z komputera.');
      content.appendChild(button('Usuń tylko z listy', async function () {
        try {
          var items = await all('files');
          await remove('libraries', id);
          await Promise.all(items.filter(function (f) { return f.libraryId === id; }).map(function (f) { return remove('files', f.id); }));
          var last = await get('settings', 'lastLibrary');
          if (last && last.value === id) await remove('settings', 'lastLibrary');
          await sync();
          screen('USUNIĘTO Z LISTY');
          content.appendChild(node('p', 'Pliki na dysku nie zostały usunięte.', 'assets-muted'));
        } catch (e) { error(e); }
      }));
    } catch (e) { error(e); }
  }
  async function setFavorites(values) {
    try {
      for (var id of Object.keys(values || {})) {
        var item = await get('files', id);
        if (item) {
          item.favorite = !!values[id];
          await put('files', item);
          if (!item.favorite) { try { await remove('cache', id); } catch (_) {} }
        }
      }
      await sync();
    } catch (e) { error(e); }
  }
  async function imported(command) {
    if (!pending) return;
    busy = false;
    if (!command.ok) { pending = null; label(command.reason || 'Nie udało się wstawić assetu.', true); return; }
    try {
      var item = await get('files', pending.id) || Object.assign({count: 0, lastUsed: 0, favorite: false}, pending);
      item.name = pending.name;
      item.path = pending.path;
      item.count++;
      item.lastUsed = Date.now();
      await put('files', item);
      await put('settings', {key: 'lastLibrary', value: pending.libraryId});
      pending = null;
      await sync();
      label('Asset dodany do Photopea w oryginalnym rozmiarze.');
      setTimeout(function () { window.close(); }, 800);
    } catch (e) { error(e); }
  }
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || event.source !== window.opener || !event.data || event.data.type !== 'KT_ASSETS' || event.data.channel !== channel || !event.data.command) return;
    var command = event.data.command;
    if (command.type === 'import-result') { imported(command); return; }
    if (command.favorites) { setFavorites(command.favorites).then(function () { dispatch(command); }); return; }
    dispatch(command);
  });
  function dispatch(command) {
    if (command.type === 'add') add();
    else if (command.type === 'pick') pick(command.id);
    else if (command.type === 'use') use(command.id);
    else if (command.type === 'refresh') refresh(command.id);
    else if (command.type === 'toggle') toggle(command.id);
    else if (command.type === 'remove') discard(command.id);
    else if (command.type === 'sync') window.close();
  }
  if (!window.opener || !channel) { screen('OTWÓRZ Z PHOTOPEA'); label('Otwórz ASSETS w panelu Kubixsio Tools, a potem kliknij Dodaj folder lub Szukaj zasobów.', true); return; }
  openDatabase().then(async function (database) {
    db = database;
    await sync();
    send('ready');
  }).catch(function (e) { screen('BRAK DOSTĘPU DO BIBLIOTEK'); error(e); });
})();
