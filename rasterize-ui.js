(function () {
  'use strict';
  const api = window.ktxRasterize, root = document.getElementById('rasterize');
  if (!api || !root) return;
  const open = root.querySelector('#rasterizeScan');
  const panel = root.querySelector('#rasterizePanel');
  const status = root.querySelector('#rasterizeStatus');
  const list = root.querySelector('#rasterizeList');
  const cancel = root.querySelector('#rasterizeCancel');
  const apply = root.querySelector('#rasterizeApply');
  let snapshot = null, busy = false;

  function updateCount() {
    const count = list.querySelectorAll('input:checked').length;
    const noun = count === 1 ? 'WARSTWĘ' : count % 10 >= 2 && count % 10 <= 4 &&
      (count % 100 < 12 || count % 100 > 14) ? 'WARSTWY' : 'WARSTW';
    apply.textContent = 'RASTERYZUJ ' + count + ' ' + noun;
    apply.disabled = busy || count === 0;
  }

  function clear() {
    list.replaceChildren();
    snapshot = null;
    updateCount();
  }

  function setBusy(value) {
    busy = value;
    open.disabled = value;
    cancel.disabled = value;
    updateCount();
  }

  open.addEventListener('click', async () => {
    if (busy) return;
    clear();
    panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    setBusy(true);
    status.textContent = 'Skanuję dokument…';
    try {
      snapshot = await api.scan();
      const fragment = document.createDocumentFragment();
      for (const {id, name} of snapshot.candidates) {
        const row = document.createElement('label');
        row.className = 'cleaner-row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = String(id);
        check.checked = true;
        const label = document.createElement('span');
        label.className = 'cleaner-name';
        label.textContent = name;
        label.title = name;
        row.append(check, label);
        fragment.append(row);
      }
      list.append(fragment);
      status.textContent = snapshot.candidates.length
        ? 'Warstwy do rasteryzacji: ' + snapshot.candidates.length
        : 'Nie znaleziono warstw do rasteryzacji.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });

  list.addEventListener('change', updateCount);
  cancel.addEventListener('click', () => {
    if (busy) return;
    clear();
    panel.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    open.focus();
  });

  apply.addEventListener('click', async () => {
    if (busy || !snapshot) return;
    const ids = Array.from(list.querySelectorAll('input:checked'), input => Number(input.value));
    if (!ids.length) return;
    const selection = snapshot;
    clear();
    setBusy(true);
    status.textContent = 'Sprawdzam dokument i rasteryzuję wybrane warstwy…';
    try {
      const count = await api.rasterize(selection, ids);
      status.textContent = 'Zrasteryzowane warstwy: ' + count;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
})();
