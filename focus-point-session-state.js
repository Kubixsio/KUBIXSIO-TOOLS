/* STAGING Focus Point only. The browser-tab session marker is not an auth token.
 * Full PNG blobs live in a separate IndexedDB, never in sessionStorage.
 */
(function () {
  'use strict';
  var DB_NAME = 'ktx-focus-point-temporary-v1';
  var STORE = 'snapshots';
  var SESSION_KEY = 'ktx-focus-point-photopea-session-v1';
  var initialization = null;
  var database = null;
  var sessionId = '';
  var writes = Promise.resolve();

  function transaction(operation) {
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = database.transaction(STORE, 'readwrite');
        operation(tx.objectStore(STORE), resolve, reject);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Local state transaction failed')); };
      } catch (error) { reject(error); }
    });
  }
  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request;
      try { request = window.indexedDB.open(DB_NAME, 1); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'sessionId'});
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = request.onblocked = function () { reject(request.error || new Error('Local state database unavailable')); };
    });
  }
  function initialize() {
    if (initialization) return initialization;
    initialization = (async function () {
      try {
        var storage = window.sessionStorage;
        sessionId = storage.getItem(SESSION_KEY) || '';
        if (sessionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) sessionId = '';
        var fresh = !sessionId;
        if (fresh) {
          if (!window.crypto || typeof window.crypto.randomUUID !== 'function') throw new Error('Secure random unavailable');
          sessionId = window.crypto.randomUUID();
          storage.setItem(SESSION_KEY, sessionId);
        }
        database = await openDatabase();
        if (fresh) await transaction(function (store) { store.clear(); });
        return {ready: true, fresh: fresh};
      } catch (_) { return {ready: false, fresh: false}; }
    })();
    return initialization;
  }
  function enqueue(operation) {
    var next = writes.then(async function () {
      var status = await initialize();
      if (!status.ready) throw new Error('Local state unavailable');
      return operation();
    });
    writes = next.catch(function () {});
    return next;
  }
  function save(documentKey, snapshot) {
    if (typeof documentKey !== 'string' || !documentKey || !snapshot || typeof snapshot !== 'object')
      return Promise.reject(new Error('Invalid local state'));
    return enqueue(function () {
      return transaction(function (store) { store.put({sessionId: sessionId, documentKey: documentKey, snapshot: snapshot}); });
    });
  }
  function load() {
    return writes.then(async function () {
      var status = await initialize();
      if (!status.ready) return null;
      return new Promise(function (resolve, reject) {
        var tx, request;
        try {
          tx = database.transaction(STORE, 'readonly');
          request = tx.objectStore(STORE).get(sessionId);
          request.onsuccess = function () {
            var record = request.result;
            resolve(record && record.sessionId === sessionId ? record : null);
          };
          request.onerror = function () { reject(request.error || new Error('Local state read failed')); };
          tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Local state read failed')); };
        } catch (error) { reject(error); }
      });
    });
  }
  function clear() {
    return enqueue(function () {
      return transaction(function (store) { store.delete(sessionId); });
    });
  }
  window.ktxFocusSessionState = Object.freeze({initialize: initialize, save: save, load: load, clear: clear});
})();
