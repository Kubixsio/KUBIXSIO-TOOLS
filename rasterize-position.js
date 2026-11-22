(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ktxRasterizePosition = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const origin = 'https://www.photopea.com', prefix = 'KTX_RASTERIZE_POSITION|';

  // Runs in Photopea, where this small registry survives destruction of the plugin iframe.
  // Local sources contain Photopea's instance ID. URL sources have no guaranteed instance ID.
  function documentState(markSource) {
    function key(source) {
      var match = /^local,(\d+),/.exec(source);
      return match ? 'local:' + match[1] : null;
    }
    // Photopea may copy object-valued window properties. Store one primitive string explicitly.
    var stored = window.ktxRasterizePositionV1;
    var used = stored ? JSON.parse(stored) : [], live = [], sources = [];
    function count(id) {
      var total = 0;
      for (var k = 0; k < live.length; k++) if (live[k] === id) total++;
      return total;
    }
    for (var i = 0; i < app.documents.length; i++) {
      var source = String(app.documents[i].source || ''), id = key(source);
      sources.push(source);
      if (id) live.push(id);
    }
    for (var old = used.length - 1; old >= 0; old--) if (count(used[old]) !== 1) used.splice(old, 1);
    var marked = markSource ? key(markSource) : null;
    if (marked && count(marked) === 1 && used.indexOf(marked) === -1) used.push(marked);
    window.ktxRasterizePositionV1 = JSON.stringify(used);
    if (!app.documents.length) return {key:null, source:null, used:false};
    var active = String(app.activeDocument.source || ''), activeKey = key(active), matches = 0;
    for (var j = 0; j < sources.length; j++) if (sources[j] === active) matches++;
    if (matches !== 1 || activeKey && count(activeKey) !== 1) return {key:null, source:null, used:false};
    return {key:activeKey, source:active || null, used:!!(activeKey && used.indexOf(activeKey) !== -1)};
  }
  function buildScript(marker, markSource = null) {
    return '(function(){' + documentState.toString() + ';try{app.echoToOE(' + JSON.stringify(marker) +
      '+JSON.stringify(documentState(' + JSON.stringify(markSource) + ')));}catch(e){app.echoToOE(' +
      JSON.stringify(marker) + '+JSON.stringify({error:"DOCUMENT_IDENTITY_UNAVAILABLE"}));}})();';
  }

  function observe(listener) {
    let pending = null, next = null, stopped = false;
    function available() {
      return window.parent !== window && !window.ktxSaveToOEGate?.owner &&
        !document.getElementById('dot')?.classList.contains('busy') &&
        !(typeof watermarkStage !== 'undefined' && watermarkStage !== 'idle') &&
        !(typeof vignetteStage !== 'undefined' && vignetteStage !== 'idle') && !window.folderizeBusy;
    }
    function read(markSource = null) {
      if (stopped || !available()) return Promise.resolve(null);
      if (pending) return pending.then(() => markSource ? read(markSource) : null);
      const marker = prefix + window.crypto.randomUUID() + '|';
      pending = new Promise(resolve => {
        let reply = null;
        function finish() {
          window.clearTimeout(timeout);
          window.removeEventListener('message', receive);
          resolve(reply);
        }
        function receive(event) {
          if (event.source !== window.parent || event.origin !== origin) return;
          if (typeof event.data === 'string' && event.data.startsWith(marker)) {
            try { reply = JSON.parse(event.data.slice(marker.length)); } catch (_) { reply = null; }
          } else if (event.data === 'done' && reply) finish();
        }
        const timeout = window.setTimeout(finish, 3000);
        window.addEventListener('message', receive);
        try { window.parent.postMessage(buildScript(marker, markSource), origin); } catch (_) { finish(); }
      }).then(state => {
        pending = null;
        if (!stopped && state && !state.error) listener(state);
        return state;
      });
      return pending;
    }
    async function refresh() {
      await read();
      if (!stopped) next = window.setTimeout(refresh, 1000);
    }
    function stop() { stopped = true; window.clearTimeout(next); }
    window.addEventListener('pagehide', stop, {once:true});
    refresh();
    return {mark: source => read(source)};
  }
  return Object.freeze({buildScript, observe});
});
