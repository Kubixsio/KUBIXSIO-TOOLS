(function () {
  'use strict';
  const api = window.ktxLayerCleaner, root = document.getElementById('layerCleaner');
  if (!api || !root) return;
  const open = root.querySelector('#layerCleanerScan'), panel = root.querySelector('#layerCleanerPanel');
  const status = root.querySelector('#layerCleanerStatus'), list = root.querySelector('#layerCleanerList');
  const cancel = root.querySelector('#layerCleanerCancel'), remove = root.querySelector('#layerCleanerDelete');
  const labels = {hidden: 'ukryta', empty: 'pusta', zero: '0%'};
  let snapshot = null, busy = false;
  function updateCount() {
    const count = list.querySelectorAll('input:checked').length;
    remove.textContent = 'USUŃ ' + count + ' WARSTW';
    remove.disabled = busy || !count;
  }
  function clear() {
    snapshot = null; list.replaceChildren(); panel.hidden = true;
    open.setAttribute('aria-expanded', 'false'); updateCount();
  }
  open.addEventListener('click', async function () {
    if (busy) return;
    clear(); busy = true; open.disabled = true; panel.hidden = false;
    open.setAttribute('aria-expanded', 'true');
    status.textContent = 'Skanuję dokument…';
    try {
      snapshot = await api.scan();
      for (const row of snapshot.candidates) {
        const label = document.createElement('label'); label.className = 'cleaner-row';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.value = String(row.id);
        check.addEventListener('change', updateCount);
        const name = document.createElement('span'); name.className = 'cleaner-name'; name.textContent = row.name; name.title = row.name;
        const reason = document.createElement('span'); reason.className = 'cleaner-reason'; reason.textContent = row.reasons.map(key => labels[key]).join(' · ');
        label.append(check, name, reason); list.append(label);
      }
      status.textContent = (snapshot.candidates.length ? 'Znaleziono ' + snapshot.candidates.length + ' warstw do usunięcia.' :
        'Nie znaleziono warstw do usunięcia.') + (snapshot.warning ? ' ' + snapshot.warning : '');
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; open.disabled = false; updateCount(); }
  });
  cancel.addEventListener('click', function () {
    if (!busy) clear();
  });
  remove.addEventListener('click', async function () {
    if (busy || !snapshot) return;
    const ids = Array.from(list.querySelectorAll('input:checked'), input => Number(input.value));
    if (!ids.length) return;
    busy = true; open.disabled = cancel.disabled = true; updateCount();
    status.textContent = 'Sprawdzam ponownie warstwy przed usunięciem…';
    try {
      const result = await api.remove(snapshot, ids);
      snapshot = null; list.replaceChildren();
      status.textContent = 'Usunięto ' + result.deleted.length + ' warstw. Pozostałe warstwy i grupy zachowano.';
    } catch (error) {
      // Invalidate the selection on failure: a partial native deletion must not be retried blindly.
      snapshot = null; list.replaceChildren();
      status.textContent = error.message + (error.detail ? ' ' + error.detail : '');
    } finally { busy = false; open.disabled = cancel.disabled = false; updateCount(); }
  });
})();
