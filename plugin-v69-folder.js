function toggleFolderPanel() {
  var controls = document.getElementById('folderControls');
  var button = document.getElementById('folderButton');
  if (!controls) return;
  var open = controls.classList.toggle('open');
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function runFolderize(mode) {
  if (mode !== 'separate' && mode !== 'together') return;
  var controls = document.getElementById('folderControls');
  var button = document.getElementById('folderButton');
  if (controls) controls.classList.remove('open');
  if (button) button.setAttribute('aria-expanded', 'false');
  window.folderizeBusy = true;
  setStatus(mode === 'together' ? 'Tworzę jeden folder...' : 'Tworzę osobne foldery...', 'busy');
  postScript('(' + folderizeSelectedLayers.toString() + ')(' + JSON.stringify(mode) + ');');
}

// Photopea also sends "done" after echoToOE. Keep the useful result on screen.
window.addEventListener('message', function (event) {
  if (event.data === 'done') window.folderizeBusy = false;
});

// This function runs inside Photopea, not in the plugin iframe.
function folderizeSelectedLayers(mode) {
  try {
    if (mode !== 'separate' && mode !== 'together') {
      throw new Error('Nieznana opcja FOLDERUJ');
    }
    var doc = app.activeDocument;
    if (!doc) throw new Error('Otwórz dokument i zaznacz warstwy');

    var selected = [];
    function collect(layers, parent) {
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.selected) {
          // A selected group already contains its children; do not move them twice.
          selected.push({layer: layer, parent: parent});
        } else if (layer.layers) {
          collect(layer.layers, layer);
        }
      }
    }
    collect(doc.layers, doc);
    if (!selected.length) throw new Error('Zaznacz co najmniej jedną warstwę');

    for (var j = 0; j < selected.length; j++) {
      if (selected[j].layer.isBackgroundLayer) {
        throw new Error('Najpierw zamień Background na zwykłą warstwę');
      }
    }

    if (mode === 'together') {
      if (selected.length < 2) {
        throw new Error('Do jednego folderu zaznacz co najmniej dwie warstwy');
      }
      var parent = selected[0].parent;
      for (var k = 1; k < selected.length; k++) {
        if (selected[k].parent !== parent) {
          throw new Error('Zaznaczone warstwy są w różnych folderach; zaznacz foldery albo warstwy na tym samym poziomie');
        }
      }
      var group = parent.layerSets.add();
      group.name = 'FOLDER';
      group.move(selected[0].layer, ElementPlacement.PLACEBEFORE);
      // Isolate each layer before moving it. Photopea otherwise can act on
      // the whole multi-selection when a layer is moved by a script.
      for (var a = selected.length - 1; a >= 0; a--) {
        doc.activeLayer = selected[a].layer;
        selected[a].layer.move(group, ElementPlacement.INSIDE);
      }
      if (group.layers.length !== selected.length) {
        throw new Error('Folder zawiera ' + group.layers.length + ' z ' + selected.length + ' zaznaczonych warstw');
      }
      for (var q = 0; q < selected.length; q++) {
        var expectedId = null;
        try { expectedId = selected[q].layer.id; } catch (ignore) {}
        if (expectedId == null) continue;
        var found = false;
        for (var t = 0; t < group.layers.length; t++) {
          try { if (group.layers[t].id === expectedId) found = true; } catch (ignore) {}
        }
        if (!found) throw new Error('Nie udało się umieścić wszystkich warstw w jednym folderze');
      }
      doc.activeLayer = group;
      app.echoToOE('KTX_OK|Utworzono folder z ' + selected.length + ' warstwami');
    } else {
      for (var b = selected.length - 1; b >= 0; b--) {
        var entry = selected[b];
        var folder = entry.parent.layerSets.add();
        folder.name = entry.layer.name;
        folder.move(entry.layer, ElementPlacement.PLACEBEFORE);
        entry.layer.move(folder, ElementPlacement.INSIDE);
      }
      app.echoToOE('KTX_OK|Utworzono ' + selected.length + ' folderów');
    }
  } catch (error) {
    app.echoToOE('KTX_ERR|' + error.toString());
  }
}
