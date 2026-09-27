(function () {
  'use strict';
  const element = id => document.getElementById(id);
  const generateButton = element('generate'), status = element('status');
  let busy = false;
  function displayRegistration(value) {
    element('result').hidden = false;
    element('identity').textContent = 'Urządzenie: ' + value.label + ' | ID: ' + value.deviceId;
    element('sql').value = value.sql;
    element('verification-sql').value = value.verificationSql;
    element('revocation-sql').value = value.revocationSql;
    element('label').value = value.label;
    element('label').disabled = true;
    generateButton.disabled = true;
    element('token-section').hidden = !value.token;
    element('token-lost').hidden = !!value.token;
    element('token').value = value.token || '';
  }
  function clearToken() {
    element('token').value = '';
    element('token').type = 'password';
    element('show-token').textContent = 'POKAŻ TOKEN';
    element('token-section').hidden = true;
    element('token-lost').hidden = false;
  }
  async function initialize() {
    try {
      const configuration = window.ktxDeviceAuth.configuration;
      element('context').textContent = 'Origin strony: ' + window.location.origin + ' | Środowisko: STAGING';
      window.ktxDeviceAuth.checkSetupContext();
      const existing = await window.ktxDeviceAuth.registration();
      if (existing) {
        displayRegistration(existing);
        await window.ktxDeviceAuth.checkLocalIdentity();
        status.textContent = 'Wczytano klucz tego profilu. Lokalny test podpisu: OK. Zatwierdzenie w D1 sprawdź osobno.';
      } else {
        generateButton.disabled = false;
        status.textContent = 'Gotowe. Nadaj nazwę urządzeniu i utwórz lokalny klucz. Serwer: ' + configuration.server;
      }
    } catch (error) {
      generateButton.disabled = true;
      status.textContent = error.message;
    }
  }
  generateButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true; generateButton.disabled = true;
    status.textContent = 'Tworzenie i sprawdzanie lokalnego klucza…';
    try {
      const value = await window.ktxDeviceAuth.createLocalIdentity(element('label').value);
      displayRegistration(value);
      status.textContent = 'Klucz gotowy. Lokalny test podpisu: OK. Zachowaj token prywatnie, a następnie zatwierdź SQL w D1 STAGING.';
    } catch (error) {
      status.textContent = error.message;
      // Nie odblokowuj tworzenia, jeśli zapis jednak zakończył się sukcesem.
      try { generateButton.disabled = !!(await window.ktxDeviceAuth.registration()); } catch { generateButton.disabled = true; }
    } finally { busy = false; }
  });
  element('show-token').addEventListener('click', () => {
    const hidden = element('token').type === 'password';
    element('token').type = hidden ? 'text' : 'password';
    element('show-token').textContent = hidden ? 'UKRYJ TOKEN' : 'POKAŻ TOKEN';
    if (hidden) { element('token').focus(); element('token').select(); }
  });
  element('clear').addEventListener('click', () => {
    clearToken(); status.textContent = 'Token usunięto z pola. Klucz i publiczne dane rejestracji pozostały w tym profilu.';
  });
  element('check').addEventListener('click', async () => {
    element('check').disabled = true;
    try {
      await window.ktxDeviceAuth.checkLocalIdentity();
      status.textContent = 'Lokalny test podpisu: OK. Klucz prywatny jest nieeksportowalny; podpis pasuje do klucza publicznego. Nie wykonano żadnego żądania sieciowego.';
    } catch (error) { status.textContent = error.message; }
    finally { element('check').disabled = false; }
  });
  window.addEventListener('pagehide', clearToken);
  initialize();
})();
