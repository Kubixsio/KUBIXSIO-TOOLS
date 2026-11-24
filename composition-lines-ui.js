(function () {
  'use strict';
  const root = document.getElementById('compositionLines'), api = window.ktxCompositionLines;
  if (!root || !api) return;
  const cross = root.querySelector('#compositionLinesCross'), grid = root.querySelector('#compositionLinesGrid');
  const add = root.querySelector('#compositionLinesAdd'), status = root.querySelector('#compositionLinesStatus');
  let mode = 'cross', busy = false;
  function choose(value) {
    if (busy) return;
    mode = value; cross.setAttribute('aria-pressed', String(mode === 'cross')); grid.setAttribute('aria-pressed', String(mode === 'grid'));
  }
  cross.addEventListener('click', () => choose('cross'));
  grid.addEventListener('click', () => choose('grid'));
  add.addEventListener('click', async () => {
    if (busy) return;
    busy = true; cross.disabled = grid.disabled = add.disabled = true;
    status.textContent = 'Dodaję linie pomocnicze…';
    try {
      await api.add(mode);
      status.textContent = 'Dodano ' + (mode === 'cross' ? 'KRZYŻ' : 'SIATKĘ') + '.';
    } catch (error) {status.textContent = error.message;}
    finally {busy = false; cross.disabled = grid.disabled = add.disabled = false;}
  });
})();
