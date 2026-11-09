(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ktxLayerCleaner = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const origin = 'https://www.photopea.com', prefix = 'KTX_CLEANER|';
  const limits = Object.freeze({layers: 3000, depth: 64, psdBytes: 128 * 1024 * 1024});

  // Self-contained: this exact function executes in Photopea, not in the iframe.
  function operate(mode, payload, caps) {
    function read(object, key) {
      var result;
      try { if (object != null) result = object[key]; } catch (_) {}
      return result;
    }
    function number(value) {
      var result = null;
      try {
        if (value && typeof value === 'object') value = value.as('px');
        if (typeof value === 'number') result = +value;
      } catch (_) {}
      return typeof result === 'number' && isFinite(result) ? result : null;
    }
    if (!app.documents.length) return {error: 'NO_DOCUMENT'};
    var doc = app.activeDocument, source = String(doc.source || ''), matches = 0;
    for (var i = 0; i < app.documents.length; i++) if (String(app.documents[i].source) === source) matches++;
    if (!source || matches !== 1) return {error: 'AMBIGUOUS_DOCUMENT'};
    var rows = [], refs = [], ids = [], invalid = false;
    function visit(layers, parent, depth) {
      if (!layers || typeof layers.length !== 'number' || depth > caps.depth) { invalid = true; return; }
      for (var i = 0; i < layers.length; i++) {
        if (rows.length >= caps.layers) { invalid = true; return; }
        var layer = layers[i], children = read(layer, 'layers'), typename = read(layer, 'typename');
        if (typename !== 'ArtLayer' && typename !== 'LayerSet') { invalid = true; return; }
        var group = typename === 'LayerSet' || children != null;
        var id = number(read(layer, 'id'));
        if (id === null || id < 0 || Math.floor(id) !== id || ids.indexOf(id) !== -1) { invalid = true; return; }
        ids.push(id);
        var bounds = read(layer, 'bounds'), box = null;
        if (bounds && bounds.length === 4) box = [number(bounds[0]), number(bounds[1]), number(bounds[2]), number(bounds[3])];
        var kind = read(layer, 'kind'), pixel = !group && kind === LayerKind.NORMAL;
        rows.push({id: id, parent: parent, name: String(layer.name), group: group,
          kind: String(kind), pixel: pixel, visible: read(layer, 'visible'), opacity: number(read(layer, 'opacity')),
          bounds: box, locked: read(layer, 'allLocked') === true, background: read(layer, 'isBackgroundLayer') === true});
        refs.push(layer);
        if (group) visit(children, id, depth + 1);
      }
    }
    visit(doc.layers, null, 0);
    if (invalid) return {error: 'UNSAFE_TREE'};
    var history = read(doc, 'historyStates'), activeHistory = read(doc, 'activeHistoryState');
    var historyName = read(activeHistory, 'name');
    var meta = {source: source, name: String(doc.name), width: number(doc.width), height: number(doc.height),
      historyLength: history ? number(history.length) : null,
      historyName: typeof historyName === 'string' ? historyName : null, layers: rows};
    if (mode === 'scan') return {meta: meta};
    if (mode !== 'delete' || !payload || JSON.stringify(meta) !== JSON.stringify(payload.meta)) return {error: 'DOCUMENT_CHANGED'};
    var selected = payload.ids, candidates = payload.candidates, selectedRefs = [], seen = [];
    if (!selected || !selected.length || !candidates) return {error: 'INVALID_SELECTION'};
    // Validate the ENTIRE batch before removing the first layer. Never fall back to names.
    for (var j = 0; j < selected.length; j++) {
      var id = selected[j], index = ids.indexOf(id), match = null;
      for (var k = 0; k < candidates.length; k++) if (candidates[k].id === id) match = candidates[k];
      if (seen.indexOf(id) !== -1 || index === -1 || !match || rows[index].group) return {error: 'INVALID_SELECTION'};
      var row = rows[index], valid = row.visible === false || row.opacity === 0;
      if (match.reasons.indexOf('empty') !== -1 && row.pixel && row.bounds &&
          row.bounds[0] === row.bounds[2] && row.bounds[1] === row.bounds[3]) valid = true;
      if (!valid) return {error: 'DOCUMENT_CHANGED'};
      if (row.locked || row.background) return {error: 'LOCKED_LAYER'};
      seen.push(id); selectedRefs.push(refs[index]);
    }
    var deleted = [], error = null;
    try {
      for (var n = 0; n < selectedRefs.length; n++) { selectedRefs[n].remove(); deleted.push(selected[n]); }
    } catch (e) { error = String(e); }
    var remaining = [], groups = [];
    function verify(layers) {
      for (var i = 0; i < layers.length; i++) {
        remaining.push(Number(layers[i].id));
        if (layers[i].typename === 'LayerSet') { groups.push(Number(layers[i].id)); verify(layers[i].layers); }
      }
    }
    verify(doc.layers);
    for (var n = 0; n < selected.length; n++) if (remaining.indexOf(selected[n]) !== -1) error = error || 'Warstwa pozostała w dokumencie';
    for (var n = 0; n < rows.length; n++) {
      if (seen.indexOf(rows[n].id) === -1 && remaining.indexOf(rows[n].id) === -1) error = error || 'Zmieniono niezaznaczoną warstwę';
      if (rows[n].group && groups.indexOf(rows[n].id) === -1) error = error || 'Nie udało się potwierdzić grup';
    }
    return {error: error ? 'DELETE_FAILED' : null, detail: error, deleted: deleted, remaining: remaining};
  }

  function potentialEmpty(row) {
    return row.pixel === true && !row.group && !row.background && Array.isArray(row.bounds) &&
      row.bounds.length === 4 && row.bounds.every(Number.isFinite) &&
      row.bounds[0] === row.bounds[2] && row.bounds[1] === row.bounds[3];
  }

  // Read layer records only, without decoding any pixel images. PSD specification:
  // https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
  // Unknown tags, PSB/unsupported data, masks or effects can NEVER prove emptiness.
  function emptyPixelIds(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    let pos = 0, end = bytes.length;
    function take(n) { if (!Number.isSafeInteger(n) || n < 0 || pos + n > end) throw new Error('INVALID_PSD'); const start = pos; pos += n; return start; }
    const u8 = () => view.getUint8(take(1)), u16 = () => view.getUint16(take(2)), u32 = () => view.getUint32(take(4));
    const i16 = () => view.getInt16(take(2)), i32 = () => view.getInt32(take(4));
    const text = n => String.fromCharCode(...bytes.subarray(take(n), pos));
    // Photopea writes base (comp 0) layer settings even for a brand-new empty layer.
    // Accept precisely that neutral state, never arbitrary shmd / layer-comp data.
    function neutralMetadata(at, length, id, visible, opacity) {
      const savedPos = pos, savedEnd = end;
      pos = at; end = at + length;
      const key = () => text(u32() || 4);
      function descriptor(depth) {
        if (depth > 8) throw new Error('INVALID_DESCRIPTOR');
        const nameLength = u32();
        if (nameLength > 1 || nameLength === 1 && u16() !== 0 || key() !== 'null') throw new Error('NON_NEUTRAL_DESCRIPTOR');
        const count = u32(), out = Object.create(null);
        if (count > 16) throw new Error('INVALID_DESCRIPTOR');
        for (let i = 0; i < count; i++) {
          const name = key();
          if (Object.hasOwn(out, name)) throw new Error('INVALID_DESCRIPTOR');
          out[name] = value(text(4), depth + 1);
        }
        return out;
      }
      function value(type, depth) {
        if (type === 'long') return i32();
        if (type === 'bool') return u8() === 1;
        if (type === 'enum') return {type: key(), value: key()};
        if (type === 'UntF') { const unit = text(4), value = view.getFloat64(take(8)); return {unit, value}; }
        if (type === 'Objc') return descriptor(depth);
        if (type === 'VlLs') {
          const count = u32(); if (count > 8 || depth > 8) throw new Error('INVALID_DESCRIPTOR');
          return Array.from({length: count}, () => value(text(4), depth + 1));
        }
        throw new Error('UNSUPPORTED_DESCRIPTOR');
      }
      function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
        return value;
      }
      let safe = false;
      try {
        if (u32() === 1 && text(4) === '8BIM' && text(4) === 'cmls' && u32() === 0) {
          const dataLength = u32(), dataEnd = pos + dataLength;
          if (dataEnd <= end && u32() === 16) {
            const parsed = descriptor(0);
            const actualOpacity = parsed.layerSettings?.[0]?.blendOptions?.Opct?.value;
            const settings = {LyrI: id, layerSettings: [{compList: [0], enab: visible,
              Ofst: {Hrzn: 0, Vrtc: 0}, FXRefPoint: {Hrzn: 0, Vrtc: 0},
              blendOptions: {'Md  ': {type: 'BlnM', value: 'Nrml'},
                Opct: {unit: '#Prc', value: actualOpacity}, fillOpacity: {unit: '#Prc', value: 100}}}]};
            safe = Number.isFinite(actualOpacity) && Math.abs(actualOpacity - opacity / 255 * 100) <= 100 / 255 &&
              JSON.stringify(canonical(parsed)) === JSON.stringify(canonical(settings)) && dataEnd - pos <= 3 && dataEnd >= pos;
            while (pos < end) if (u8() !== 0) safe = false;
          }
        }
      } catch (_) { safe = false; }
      pos = savedPos; end = savedEnd;
      return safe;
    }
    if (bytes.length > limits.psdBytes || text(4) !== '8BPS' || u16() !== 1) throw new Error('UNSUPPORTED_PSD');
    take(6); const channels = u16(), height = u32(), width = u32(), depth = u16(), color = u16();
    if (channels < 1 || channels > 56 || !height || !width || depth !== 8 || ![1, 3].includes(color)) throw new Error('UNSUPPORTED_PSD');
    take(u32()); take(u32());
    const sectionLength = u32(), sectionEnd = pos + sectionLength;
    if (sectionEnd > end || sectionLength < 4) throw new Error('INVALID_PSD');
    const infoLength = u32(), infoEnd = pos + infoLength;
    if (infoEnd > sectionEnd || infoLength < 2) throw new Error('INVALID_PSD');
    end = infoEnd;
    const count = Math.abs(i16()), records = [], usedIds = new Set();
    if (count > limits.layers * 2) throw new Error('TOO_MANY_LAYERS');
    for (let i = 0; i < count; i++) {
      const top = i32(), left = i32(), bottom = i32(), right = i32(), countChannels = u16(), data = [];
      if (countChannels > 56) throw new Error('INVALID_PSD');
      for (let c = 0; c < countChannels; c++) data.push({id: i16(), length: u32()});
      if (text(4) !== '8BIM') throw new Error('INVALID_PSD');
      text(4); const opacity = u8(), clipping = u8(), flags = u8(); u8();
      const extraLength = u32(), extraEnd = pos + extraLength, outerEnd = end;
      if (extraEnd > end) throw new Error('INVALID_PSD');
      end = extraEnd;
      const maskLength = u32(); take(maskLength);
      const rangesLength = u32(); const rangesAt = take(rangesLength);
      // Only absent or the neutral default blending ranges are safe.
      let rangesSafe = rangesLength % 8 === 0;
      for (let r = 0; r < rangesLength; r++) if (bytes[rangesAt + r] !== [0, 0, 255, 255][r % 4]) rangesSafe = false;
      const nameLength = u8(); take(nameLength); take((4 - (nameLength + 1) % 4) % 4);
      let id = null, metadata = null, safe = maskLength === 0 && rangesSafe && clipping === 0 && (flags & ~2) === 0;
      while (pos < extraEnd) {
        if (text(4) !== '8BIM') throw new Error('INVALID_PSD');
        const tag = text(4), length = u32(), at = take(length); take(length % 2);
        if (tag === 'lyid' && length === 4 && id === null) id = view.getUint32(at);
        else if (tag === 'luni') { if (length < 4 || 4 + view.getUint32(at) * 2 > length) safe = false; }
        else if (tag === 'lsct' && length === 4 && view.getUint32(at) === 0) { /* ordinary layer */ }
        else if ((tag === 'lclr' && length === 8 || tag === 'fxrp' && length === 16) &&
            bytes.subarray(at, at + length).every(n => n === 0)) { /* default label/reference point */ }
        else if (tag === 'shmd' && metadata === null) metadata = {at, length};
        else safe = false;
      }
      if (metadata && !neutralMetadata(metadata.at, metadata.length, id, (flags & 2) === 0, opacity)) safe = false;
      end = outerEnd;
      if (id !== null) { if (usedIds.has(id)) throw new Error('DUPLICATE_PSD_ID'); usedIds.add(id); }
      records.push({id, data, clipping, safe: safe && id !== null && top === bottom && left === right && data.length > 0 &&
        data.every(c => c.id >= -1 && c.id <= 2 && c.length === 2)});
    }
    // Removing an empty clipping base could reveal the pixels clipped to it.
    // PSD records are stored bottom-to-top; preserve the base of every clipping run.
    for (let i = 1; i < records.length; i++) if (records[i].clipping !== 0) {
      for (let j = i - 1; j >= 0; j--) {
        records[j].safe = false;
        if (records[j].clipping === 0) break;
      }
    }
    const result = new Set();
    for (const record of records) {
      let safe = record.safe;
      for (const channel of record.data) {
        const at = take(channel.length);
        if (channel.length !== 2 || view.getUint16(at) > 1) safe = false;
      }
      if (safe) result.add(record.id);
    }
    return result;
  }

  function candidates(meta, emptyIds = new Set()) {
    return meta.layers.filter(row => !row.group).flatMap(row => {
      const reasons = [];
      if (row.visible === false) reasons.push('hidden');
      if (potentialEmpty(row) && emptyIds.has(row.id)) reasons.push('empty');
      if (row.opacity === 0) reasons.push('zero');
      return reasons.length ? [{id: row.id, name: row.name, parent: row.parent, reasons}] : [];
    });
  }

  function buildScript(id, mode, payload) {
    const marker = JSON.stringify(prefix + id + '|');
    return '(function(){' + operate.toString() + ';try{var result=operate(' + JSON.stringify(mode) + ',' +
      JSON.stringify(payload ?? null) + ',' + JSON.stringify(limits) + ');' +
      (mode === 'scan' ? 'if(result.meta){result.exporting=false;for(var i=0;i<result.meta.layers.length;i++){' +
        'var l=result.meta.layers[i];if(l.pixel&&!l.group&&!l.background&&l.bounds&&l.bounds[0]===l.bounds[2]&&l.bounds[1]===l.bounds[3])result.exporting=true;}}' : '') +
      'app.echoToOE(' + marker + '+JSON.stringify(result));' +
      (mode === 'scan' ? 'if(result.exporting)app.activeDocument.saveToOE("psd");' : '') +
      '}catch(e){app.echoToOE(' + marker + '+JSON.stringify({error:"PHOTOPEA_ERROR",detail:String(e)}));}})();';
  }

  const messages = {
    NO_DOCUMENT: 'Brak otwartego dokumentu w Photopea.',
    AMBIGUOUS_DOCUMENT: 'Nie można jednoznacznie rozpoznać dokumentu. Otwórz go tylko raz.',
    UNSAFE_TREE: 'Nie można bezpiecznie odczytać wszystkich warstw. Niczego nie usunięto.',
    DOCUMENT_CHANGED: 'Dokument zmienił się od skanowania. Uruchom Layer Cleaner ponownie.',
    INVALID_SELECTION: 'Nieprawidłowe zaznaczenie warstw. Wykonaj ponowny skan.',
    LOCKED_LAYER: 'Zaznaczono zablokowaną warstwę lub Background. Odznacz ją albo odblokuj i wykonaj ponowny skan.',
    DELETE_FAILED: 'Photopea nie potwierdziła całego usuwania. Sprawdź warstwy i Historię przed ponownym skanem.',
    BUSY: 'Poczekaj, aż Photopea zakończy bieżącą operację.',
    NOT_EMBEDDED: 'Otwórz plugin jako panel w Photopea.',
    TIMEOUT: 'Brak potwierdzenia Photopea. Sprawdź dokument. Poczekaj na zakończenie operacji lub odśwież panel przed następnym działaniem.',
    PHOTOPEA_ERROR: 'Photopea zgłosiła błąd operacji.'
  };
  function fail(code, detail) { return Object.assign(new Error(messages[code] || messages.PHOTOPEA_ERROR), {code, detail}); }
  let pending = false;
  async function request(mode, payload) {
    const host = window.parent;
    if (host === window) throw fail('NOT_EMBEDDED');
    const gate = window.ktxSaveToOEGate;
    if (pending || gate?.owner || document.getElementById('dot')?.classList.contains('busy') ||
        typeof watermarkStage !== 'undefined' && watermarkStage !== 'idle' ||
        typeof vignetteStage !== 'undefined' && vignetteStage !== 'idle' || window.folderizeBusy) throw fail('BUSY');
    pending = true;
    if (gate) gate.owner = 'layer-cleaner';
    const buttons = Array.from(document.querySelectorAll('button')).map(button => ({button, disabled: button.disabled}));
    buttons.forEach(({button}) => { button.disabled = true; });
    const marker = prefix + window.crypto.randomUUID() + '|';
    const id = marker.slice(prefix.length, -1);
    return new Promise((resolve, reject) => {
      let reply, buffer, finished = false, draining = false;
      function cleanup() {
        window.clearTimeout(timer); window.removeEventListener('message', receive); pending = false;
        buttons.forEach(({button, disabled}) => { button.disabled = disabled; });
        if (gate?.owner === 'layer-cleaner') {
          gate.owner = null;
          // Resume exports queued by the existing shared export gate, without changing AI/ASSETS.
          const queue = gate.queue.splice(0);
          queue.forEach(script => window.postScript(script));
        }
      }
      function finish(error, waitForNativeDone = false) {
        if (finished) return; finished = true;
        draining = waitForNativeDone;
        if (!draining) cleanup();
        if (error) reject(error); else resolve({reply, buffer});
      }
      function receive(event) {
        if (event.source !== host || event.origin !== origin) return;
        if (draining) {
          // A late PSD must not be mistaken for a subsequent AI/ASSETS export.
          if (event.data === 'done') { draining = false; cleanup(); }
          return;
        }
        if (typeof event.data === 'string' && event.data.startsWith(marker)) {
          try {
            if (event.data.length > 4 * 1024 * 1024) throw fail('UNSAFE_TREE');
            reply = JSON.parse(event.data.slice(marker.length));
            if (reply.error) { finish(fail(reply.error, reply.detail)); return; }
          } catch (error) { finish(error); }
        } else if (reply?.exporting && event.data instanceof ArrayBuffer) {
          if (event.data.byteLength <= limits.psdBytes) buffer = event.data;
          else reply.warning = 'Pominięto ocenę pustki: PSD przekracza 128 MiB.';
        } else if (event.data === 'done' && reply) {
          if (reply.exporting && !buffer && !reply.warning) { finish(fail('PHOTOPEA_ERROR', 'Brak PSD')); return; }
          finish();
        }
      }
      const timer = window.setTimeout(() => finish(fail('TIMEOUT'), true), 30000);
      window.addEventListener('message', receive);
      try { host.postMessage(buildScript(id, mode, payload), origin); } catch (error) { finish(fail('PHOTOPEA_ERROR', String(error))); }
    });
  }
  async function scan() {
    const {reply, buffer} = await request('scan');
    let emptyIds = new Set(), warning = reply.warning || '';
    if (buffer) {
      try { emptyIds = emptyPixelIds(buffer); }
      catch (_) { warning = 'Nie potwierdzono pustki niektórych warstw. Zachowano je bez zmian.'; }
    }
    return {meta: reply.meta, candidates: candidates(reply.meta, emptyIds), warning};
  }
  async function remove(snapshot, ids) {
    if (!snapshot || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some(id => !snapshot.candidates.some(row => row.id === id))) throw fail('INVALID_SELECTION');
    const fresh = await scan();
    if (JSON.stringify(snapshot.meta) !== JSON.stringify(fresh.meta) || ids.some(id => {
      const before = snapshot.candidates.find(row => row.id === id), after = fresh.candidates.find(row => row.id === id);
      return !after || JSON.stringify(before.reasons) !== JSON.stringify(after.reasons);
    })) throw fail('DOCUMENT_CHANGED');
    const {reply} = await request('delete', {meta: fresh.meta, candidates: fresh.candidates, ids});
    return reply;
  }
  return Object.freeze({limits, buildScript, emptyPixelIds, potentialEmpty, candidates, scan, remove});
});
