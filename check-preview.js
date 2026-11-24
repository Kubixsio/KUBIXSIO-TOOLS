(function () {
  'use strict';
  const button = document.getElementById('thumbnailPreviewOpen');
  if (!button) return;
  const modal = document.getElementById('checkPreviewModal'), image = document.getElementById('checkPreviewImage');
  const stage = document.getElementById('checkPreviewStage'), status = document.getElementById('checkPreviewStatus');
  const left = document.getElementById('checkPreviewLeft'), right = document.getElementById('checkPreviewRight');
  const label = document.getElementById('checkPreviewSize');
  const levels = [{name:'DUŻY',scale:1},{name:'ŚREDNI',scale:0.62},{name:'MAŁY',scale:0.36},{name:'BARDZO MAŁY',scale:0.18}];
  let busy = false, index = 0, url = '', dimensions = null;
  function render() {
    label.textContent = levels[index].name;
    left.disabled = index === 0; right.disabled = index === levels.length - 1;
    if (!dimensions || !modal.open) return;
    const width = Math.max(1,stage.clientWidth - 24), height = Math.max(1,stage.clientHeight - 24);
    const fit = Math.min(width / dimensions.width, height / dimensions.height) * levels[index].scale;
    image.style.width = dimensions.width * fit + 'px'; image.style.height = dimensions.height * fit + 'px';
  }
  function step(delta) { index = Math.max(0, Math.min(levels.length - 1,index + delta)); render(); }
  function release() {
    image.removeAttribute('src'); dimensions = null;
    if (url) URL.revokeObjectURL(url);
    url = '';
  }
  async function open() {
    if (busy || modal.open) return;
    busy = true; button.disabled = true; button.setAttribute('aria-busy','true');
    status.textContent = 'Pobieranie podglądu…';
    try {
      const snapshot = await window.ktxDocumentSnapshot.capture();
      url = URL.createObjectURL(snapshot.png); image.src = url;
      await image.decode();
      dimensions = {width:image.naturalWidth,height:image.naturalHeight};
      if (!dimensions.width || !dimensions.height) throw new Error('Nie udało się odczytać podglądu.');
      index = 0; modal.showModal();
      // The first frame appears at its target size; only subsequent size switches animate.
      image.classList.add('check-preview-initial'); render();
      void image.offsetWidth; image.classList.remove('check-preview-initial');
      status.textContent = '';
    } catch (error) {
      release(); status.textContent = error.message || 'Nie udało się pobrać podglądu.';
    } finally {
      busy = false; button.disabled = false; button.removeAttribute('aria-busy');
    }
  }
  button.addEventListener('click',open);
  left.addEventListener('click',()=>step(-1)); right.addEventListener('click',()=>step(1));
  document.getElementById('checkPreviewClose').addEventListener('click',()=>modal.close());
  modal.addEventListener('close',()=>{if (!modal.open) {release(); button.focus();}});
  modal.addEventListener('keydown',event=>{
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  // Observe layout only; never reads or exports the Photopea document.
  new ResizeObserver(render).observe(stage);
})();
