(function () {
  'use strict';
  const button = document.getElementById('grayscaleCheckOpen');
  if (!button) return;
  const modal = document.getElementById('grayscaleModal'), image = document.getElementById('grayscaleImage');
  const stage = document.getElementById('grayscaleStage'), status = document.getElementById('grayscaleStatus');
  const original = document.getElementById('grayscaleOriginal'), gray = document.getElementById('grayscaleGray');
  let busy = false, url = '', dimensions = null;
  function render() {
    if (!dimensions || !modal.open) return;
    const fit = Math.min(Math.max(1,stage.clientWidth - 24) / dimensions.width,
      Math.max(1,stage.clientHeight - 24) / dimensions.height);
    image.style.width = dimensions.width * fit + 'px'; image.style.height = dimensions.height * fit + 'px';
  }
  function choose(grayscale) {
    image.classList.toggle('grayscale-active',grayscale);
    original.setAttribute('aria-pressed',String(!grayscale)); gray.setAttribute('aria-pressed',String(grayscale));
  }
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
      choose(true); modal.showModal(); render(); status.textContent = '';
    } catch (error) {
      release(); status.textContent = error.message || 'Nie udało się pobrać podglądu.';
    } finally {
      busy = false; button.disabled = false; button.removeAttribute('aria-busy');
    }
  }
  button.addEventListener('click',open);
  original.addEventListener('click',()=>choose(false)); gray.addEventListener('click',()=>choose(true));
  document.getElementById('grayscaleClose').addEventListener('click',()=>modal.close());
  modal.addEventListener('close',()=>{if (!modal.open) {release(); button.focus();}});
  new ResizeObserver(render).observe(stage);
})();
