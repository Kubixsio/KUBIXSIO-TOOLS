(function () {
  'use strict';
  // Independent Focus Point database. No ASSETS store or network access.
  var connection = null;
  var opening = null;
  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      var request;
      try { request = window.indexedDB.open('kubixsio-focus-point', 1); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        var db = request.result;
        db.createObjectStore('projects', {keyPath: 'id'});
        db.createObjectStore('analyses', {keyPath: 'id'}).createIndex('projectId', 'projectId', {unique: false});
        db.createObjectStore('images', {keyPath: 'id'});
      };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Zamknij inne otwarte panele Focus Point i spróbuj ponownie.')); };
      request.onsuccess = function () {
        connection = request.result;
        connection.onversionchange = function () { connection.close(); connection = null; opening = null; };
        resolve(connection);
      };
    }).catch(function (error) { opening = null; throw error; });
    return opening;
  }
  function transaction(stores, mode, action) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(stores, mode), value, failure;
        tx.oncomplete = function () { resolve(value); };
        tx.onabort = function () { reject(failure || tx.error || new Error('Przerwano zapis lokalny.')); };
        tx.onerror = function () { failure = tx.error; };
        try { action(tx, function (result) { value = result; }, function (error) { failure = error; tx.abort(); }); }
        catch (error) { failure = error; tx.abort(); }
      });
    });
  }
  function uuid() {
    if (!window.crypto || !crypto.randomUUID) throw new Error('Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów projektów.');
    return crypto.randomUUID();
  }
  function get(store, id) {
    return transaction([store], 'readonly', function (tx, done) {
      tx.objectStore(store).get(id).onsuccess = function (event) { done(event.target.result || null); };
    });
  }
  function listProjects() {
    return transaction(['projects'], 'readonly', function (tx, done) {
      tx.objectStore('projects').getAll().onsuccess = function (event) {
        done(event.target.result.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id); }));
      };
    });
  }
  function createProject(name) {
    name = String(name || '').trim();
    if (!name) return Promise.reject(new Error('Wpisz nazwę nowego projektu.'));
    var project = {id: uuid(), name: name, createdAt: new Date().toISOString()};
    return transaction(['projects'], 'readwrite', function (tx, done) { tx.objectStore('projects').add(project); done(project); });
  }
  function listAnalyses(projectId) {
    return transaction(['analyses'], 'readonly', function (tx, done) {
      tx.objectStore('analyses').index('projectId').getAll(projectId).onsuccess = function (event) {
        done(event.target.result.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id); }));
      };
    });
  }
  function resizeImage(blob, width, height) {
    return new Promise(function (resolve, reject) {
      var image = new Image(), url = URL.createObjectURL(blob);
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Nie udało się przygotować miniaturki historii.')); };
      image.onload = function () {
        try {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        var context = canvas.getContext('2d');
        if (!context) throw new Error('Przeglądarka nie udostępniła obrazu do zapisania.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (smallBlob) {
          if (!smallBlob) { reject(new Error('Nie udało się zapisać miniaturki historii.')); return; }
          smallBlob.arrayBuffer().then(function (bytes) { return crypto.subtle.digest('SHA-256', bytes); }).then(function (hash) {
            resolve({id: Array.from(new Uint8Array(hash)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('') + '-' + width + 'x' + height,
              blob: smallBlob, width: canvas.width, height: canvas.height, originalWidth: width, originalHeight: height,
              mimeType: 'image/png', resolution: 'reduced', analysisScope: 'full-thumbnail'});
          }).catch(reject);
        }, 'image/png');
        } catch (error) { reject(error); }
      };
      image.src = url;
    });
  }
  function saveAnalysis(record, image) {
    var saved = Object.assign({}, record, {schemaVersion: 1, id: uuid(), imageId: image.id});
    return transaction(['projects', 'analyses', 'images'], 'readwrite', function (tx, done, fail) {
      tx.objectStore('projects').get(saved.projectId).onsuccess = function (event) {
        if (!event.target.result) { fail(new Error('Projekt nie istnieje. Wybierz go ponownie.')); return; }
        saved.projectName = event.target.result.name;
        tx.objectStore('images').get(image.id).onsuccess = function (imageEvent) {
          var existing = imageEvent.target.result;
          tx.objectStore('images').put(existing ? Object.assign({}, existing, {references: existing.references + 1}) : Object.assign({}, image, {references: 1}));
          tx.objectStore('analyses').add(saved);
          done(saved);
        };
      };
    });
  }
  function setTaskState(analysisId, projectId, taskId, state) {
    return transaction(['analyses'], 'readwrite', function (tx, done, fail) {
      tx.objectStore('analyses').get(analysisId).onsuccess = function (event) {
        var record = event.target.result;
        if (!record || record.projectId !== projectId || !record.result.suggestions.some(function (task) { return task.id === taskId; }) ||
            ['pending', 'done', 'skipped'].indexOf(state) === -1) { fail(new Error('Zapisane zadanie już nie istnieje.')); return; }
        record.taskStates[taskId] = state;
        tx.objectStore('analyses').put(record);
        done(record);
      };
    });
  }
  function releaseImages(tx, counts) {
    Object.keys(counts).forEach(function (id) {
      tx.objectStore('images').get(id).onsuccess = function (event) {
        var image = event.target.result;
        if (!image) return;
        if (image.references <= counts[id]) tx.objectStore('images').delete(id);
        else tx.objectStore('images').put(Object.assign({}, image, {references: image.references - counts[id]}));
      };
    });
  }
  function deleteAnalysis(id, projectId) {
    return transaction(['analyses', 'images'], 'readwrite', function (tx, done, fail) {
      tx.objectStore('analyses').get(id).onsuccess = function (event) {
        var record = event.target.result;
        if (!record || record.projectId !== projectId) { fail(new Error('Analiza nie istnieje w wybranym projekcie.')); return; }
        tx.objectStore('analyses').delete(id);
        var counts = {}; counts[record.imageId] = 1; releaseImages(tx, counts); done(id);
      };
    });
  }
  function clearProject(projectId) {
    return transaction(['analyses', 'images'], 'readwrite', function (tx, done) {
      tx.objectStore('analyses').index('projectId').getAll(projectId).onsuccess = function (event) {
        var records = event.target.result, counts = {};
        records.forEach(function (record) { tx.objectStore('analyses').delete(record.id); counts[record.imageId] = (counts[record.imageId] || 0) + 1; });
        releaseImages(tx, counts); done(records.length);
      };
    });
  }
  function dataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error); }; reader.readAsDataURL(blob);
    });
  }
  window.ktxFocusHistoryStore = Object.freeze({open: open, createProject: createProject, listProjects: listProjects,
    getProject: function (id) { return get('projects', id); }, listAnalyses: listAnalyses,
    getAnalysis: function (id) { return get('analyses', id); }, getImage: function (id) { return get('images', id); },
    resizeImage: resizeImage, saveAnalysis: saveAnalysis, setTaskState: setTaskState,
    deleteAnalysis: deleteAnalysis, clearProject: clearProject, dataUrl: dataUrl});
}());
