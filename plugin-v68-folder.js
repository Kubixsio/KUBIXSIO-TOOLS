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
  setStatus('Folderuję warstwy...', 'busy');
  postScript('(' + folderizeSelectedLayers.toString() + ')(' + JSON.stringify(mode) + ');');
}

// This function runs inside Photopea, not in the plugin iframe.
function folderizeSelectedLayers(mode) {
  try {
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
      var parent = selected[0].parent;
      for (var k = 1; k < selected.length; k++) {
        if (selected[k].parent !== parent) {
          throw new Error('Do jednego folderu wybierz warstwy z tego samego poziomu');
        }
      }
      var group = parent.layerSets.add();
      group.name = 'FOLDER';
      group.move(selected[0].layer, ElementPlacement.PLACEBEFORE);
      // Moving a layer INSIDE inserts it at the top of the group.
      for (var a = selected.length - 1; a >= 0; a--) {
        selected[a].layer.move(group, ElementPlacement.INSIDE);
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
