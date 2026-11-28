(function () {
  'use strict';
  const button = document.getElementById('contrastCheckOpen');
  if (!button) return;
  const modal = document.getElementById('contrastModal'), image = document.getElementById('contrastImage');
  const stage = document.getElementById('contrastStage'), status = document.getElementById('contrastStatus');
  const original = document.getElementById('contrastOriginal'), diagnostic = document.getElementById('contrastEnabled');
  const left = document.getElementById('contrastLeft'), right = document.getElementById('contrastRight');
  const label = document.getElementById('contrastLevel');
  // Relative to the short side, so document resolution does not change the check.
  const levels = [{name:'LEKKI',bands:12,amount:0.0015},{name:'ŚREDNI',bands:6,amount:0.006},{name:'MOCNY',bands:4,amount:0.014}];
  let busy = false, urls = [], decoded = [], dimensions = null, index = 0, enabled = true;
  async function prepare(source) {
    // Clamp all eight border regions before smoothing. Padding is discarded, never source pixels.
    // Bounded preview rasters keep large PSDs inexpensive and all three states ready to display.
    const scale = 1280 / Math.max(source.naturalWidth,source.naturalHeight);
    const w = Math.max(1,Math.round(source.naturalWidth * scale)), h = Math.max(1,Math.round(source.naturalHeight * scale));
    const pad = Math.ceil(Math.min(w,h) * levels[2].amount * 3) + 2;
    const canvas = (width,height) => Object.assign(document.createElement('canvas'),{width,height});
    const base = canvas(w,h), baseContext = base.getContext('2d'); baseContext.drawImage(source,0,0,w,h);
    const luminance = baseContext.getImageData(0,0,w,h);
    for (let i=0;i<luminance.data.length;i+=4) {
      const value = Math.round(0.2126*luminance.data[i] + 0.7152*luminance.data[i+1] + 0.0722*luminance.data[i+2]);
      luminance.data[i] = luminance.data[i+1] = luminance.data[i+2] = value;
    }
    baseContext.putImageData(luminance,0,0);
    const padded = canvas(w + 2 * pad,h + 2 * pad), p = padded.getContext('2d');
    p.drawImage(base,pad,pad);
    p.drawImage(base,0,0,1,h,0,pad,pad,h); p.drawImage(base,w-1,0,1,h,pad+w,pad,pad,h);
    p.drawImage(base,0,0,w,1,pad,0,w,pad); p.drawImage(base,0,h-1,w,1,pad,pad+h,w,pad);
    for (const x of [0,1]) for (const y of [0,1]) p.drawImage(base,x*(w-1),y*(h-1),1,1,x*(pad+w),y*(pad+h),pad,pad);
    const work = canvas(padded.width,padded.height), context = work.getContext('2d'), output = canvas(w,h);
    for (const level of levels) {
      context.clearRect(0,0,work.width,work.height); context.filter = 'blur(' + Math.min(w,h) * level.amount + 'px)';
      context.drawImage(padded,0,0);
      const target = output.getContext('2d'); target.clearRect(0,0,w,h); target.drawImage(work,pad,pad,w,h,0,0,w,h);
      // Fixed luminance zones, not contrast enhancement, histogram stretching or thresholding.
      const tones = target.getImageData(0,0,w,h), steps = level.bands - 1;
      for (let i=0;i<tones.data.length;i+=4) {
        const value = Math.round(Math.round(tones.data[i] * steps / 255) * 255 / steps);
        tones.data[i] = tones.data[i+1] = tones.data[i+2] = value;
      }
      target.putImageData(tones,0,0);
      const blob = await new Promise(resolve=>output.toBlob(resolve,'image/png'));
      if (!blob) throw new Error('Nie udało się przygotować stref jasności.');
      const url = URL.createObjectURL(blob); urls.push(url);
      const ready = new Image(); decoded.push(ready); ready.src = url; await ready.decode();
    }
  }
  function render() {
    label.textContent = levels[index].name;
    left.disabled = index === 0; right.disabled = index === levels.length - 1;
    original.setAttribute('aria-pressed',String(!enabled)); diagnostic.setAttribute('aria-pressed',String(enabled));
    if (!dimensions || !modal.open) return;
    const fit = Math.min(Math.max(1,stage.clientWidth - 24) / dimensions.width,
      Math.max(1,stage.clientHeight - 24) / dimensions.height);
    const width = dimensions.width * fit, height = dimensions.height * fit;
    image.style.width = width + 'px'; image.style.height = height + 'px';
    const url = urls[enabled ? index + 1 : 0];
    if (image.getAttribute('src') !== url) image.src = url;
  }
  function step(delta) { index = Math.max(0,Math.min(levels.length - 1,index + delta)); enabled = true; render(); }
  function release() {
    image.removeAttribute('src'); dimensions = null;
    for (const ready of decoded) ready.removeAttribute('src'); decoded = [];
    for (const url of urls) URL.revokeObjectURL(url); urls = [];
  }
  async function open() {
    if (busy || modal.open) return;
    busy = true; button.disabled = true; button.setAttribute('aria-busy','true');
    status.textContent = 'Pobieranie podglądu…';
    try {
      const snapshot = await window.ktxDocumentSnapshot.capture();
      const source = new Image(); decoded.push(source);
      const url = URL.createObjectURL(snapshot.png); urls.push(url); source.src = url; await source.decode();
      dimensions = {width:source.naturalWidth,height:source.naturalHeight};
      if (!dimensions.width || !dimensions.height) throw new Error('Nie udało się odczytać podglądu.');
      await prepare(source);
      index = 0; enabled = true; modal.showModal(); render(); status.textContent = '';
    } catch (error) {
      release(); status.textContent = error.message || 'Nie udało się pobrać podglądu.';
    } finally {
      busy = false; button.disabled = false; button.removeAttribute('aria-busy');
    }
  }
  button.addEventListener('click',open);
  left.addEventListener('click',()=>step(-1)); right.addEventListener('click',()=>step(1));
  original.addEventListener('click',()=>{enabled = false; render();});
  diagnostic.addEventListener('click',()=>{enabled = true; render();});
  document.getElementById('contrastClose').addEventListener('click',()=>modal.close());
  modal.addEventListener('close',()=>{if (!modal.open) {release(); button.focus();}});
  modal.addEventListener('keydown',event=>{
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);}
  });
  new ResizeObserver(render).observe(stage);
})();
