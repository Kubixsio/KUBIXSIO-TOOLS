function toggleFolderPanel() {
  var controls = document.getElementById('folderControls');
  var button = document.getElementById('folderButton');
  if (!controls) return;
  var open = controls.classList.toggle('open');
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeFolderPanel() {
  var controls = document.getElementById('folderControls');
  var button = document.getElementById('folderButton');
  if (controls) controls.classList.remove('open');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function runFolderizeSeparate() {
  closeFolderPanel();
  window.folderizeBusy = true;
  setStatus('Tworzę osobne foldery...', 'busy');
  postScript('(' + folderizeSeparate.toString() + ')();');
}

function runFolderizeTogether() {
  closeFolderPanel();
  window.folderizeBusy = true;
  setStatus('Tworzę jeden folder...', 'busy');
  postScript('(' + folderizeTogether.toString() + ')();');
}

window.addEventListener('message', function (event) {
  if (event.data === 'done') window.folderizeBusy = false;
});

// This function runs inside Photopea, not in the plugin iframe.
function folderizeSeparate() {
  try {
    var doc = app.activeDocument;
    if (!doc) throw new Error('Otwórz dokument i zaznacz warstwy');
    var selected = [];
    function collect(layers, parent) {
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.selected) selected.push({layer: layer, parent: parent});
        else if (layer.layers) collect(layer.layers, layer);
      }
    }
    collect(doc.layers, doc);
    if (!selected.length) throw new Error('Zaznacz co najmniej jedną warstwę');
    for (var j = 0; j < selected.length; j++) {
      if (selected[j].layer.isBackgroundLayer) throw new Error('Najpierw zamień Background na zwykłą warstwę');
    }
    for (var k = selected.length - 1; k >= 0; k--) {
      var entry = selected[k];
      var folder = entry.parent.layerSets.add();
      folder.name = entry.layer.name;
      folder.move(entry.layer, ElementPlacement.PLACEBEFORE);
      entry.layer.move(folder, ElementPlacement.INSIDE);
    }
    app.echoToOE('KTX_OK|Utworzono ' + selected.length + ' folderów');
  } catch (error) {
    app.echoToOE('KTX_ERR|' + error.toString());
  }
}

// This function intentionally has no mode argument. It can only create one
// shared folder, so the second button cannot fall through to the separate path.
function folderizeTogether() {
  try {
    var doc = app.activeDocument;
    if (!doc) throw new Error('Otwórz dokument i zaznacz warstwy');
    var selected = [];
    function collect(layers, parent) {
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        if (layer.selected) selected.push({layer: layer, parent: parent});
        else if (layer.layers) collect(layer.layers, layer);
      }
    }
    collect(doc.layers, doc);
    if (selected.length < 2) throw new Error('Do jednego folderu zaznacz co najmniej dwie warstwy');
    for (var j = 0; j < selected.length; j++) {
      if (selected[j].layer.isBackgroundLayer) throw new Error('Najpierw zamień Background na zwykłą warstwę');
    }

    // Layers from different existing folders are moved to a new top-level
    // folder. Layers already on one level stay on that level.
    var sameParent = true;
    var sourceParent = selected[0].parent;
    for (var k = 1; k < selected.length; k++) {
      if (selected[k].parent !== sourceParent) { sameParent = false; break; }
    }
    var targetParent = sameParent ? sourceParent : doc;
    var group = targetParent.layerSets.add();
    group.name = 'FOLDER';
    if (sameParent) {
      group.move(selected[0].layer, ElementPlacement.PLACEBEFORE);
    } else {
      group.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
    }

    for (var a = selected.length - 1; a >= 0; a--) {
      selected[a].layer.move(group, ElementPlacement.INSIDE);
    }
    if (group.layers.length !== selected.length) {
      throw new Error('Folder zawiera ' + group.layers.length + ' z ' + selected.length + ' warstw');
    }
    // Remove empty source folders left behind when selected layers came from
    // separate folders. This keeps the layer panel clean after merging.
    if (!sameParent) {
      var emptyParents = [];
      for (var b = 0; b < selected.length; b++) {
        var p = selected[b].parent;
        if (p !== doc && p !== group && p.layers && p.layers.length === 0 && emptyParents.indexOf(p) < 0) emptyParents.push(p);
      }
      for (var c = 0; c < emptyParents.length; c++) {
        try { emptyParents[c].remove(); } catch (ignore) {}
      }
    }
    doc.activeLayer = group;
    app.echoToOE('KTX_OK|Utworzono jeden folder z ' + selected.length + ' warstwami');
  } catch (error) {
    app.echoToOE('KTX_ERR|' + error.toString());
  }
}
