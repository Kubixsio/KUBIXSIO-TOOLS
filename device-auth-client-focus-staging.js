/* Lokalna konfiguracja STAGING. Bez fetch, logowania i automatycznej rejestracji.
 * Zachowuje nazwę IndexedDB i format podpisu backendu 2.0.0.
 * Nigdy nie utrwala tokenu. Nie wywołuje /auth/challenge ani /analyze.
 */
(function () {
  'use strict';
  const ORIGIN = 'https://kubixsio.github.io';
  const PARENT_ORIGIN = 'https://www.photopea.com';
  const SERVER = 'https://kubixsio-focus-point-staging.polizaless1.workers.dev';
  const DB_NAME = 'kubixsio-private-device-auth-v1';
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const encoder = new TextEncoder();
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const base64url = bytes => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function digest(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function assertSecureOrigin() {
    if (!window.isSecureContext || window.location.origin !== ORIGIN)
      throw new Error('Otwórz stronę przez HTTPS pod adresem kubixsio.github.io, jako panel w Photopea.');
    if (!crypto.subtle || !window.indexedDB)
      throw new Error('Ta przeglądarka nie udostępnia kryptografii lub IndexedDB.');
  }
  function checkSetupContext() {
    assertSecureOrigin();
    let parentOrigin = '';
    try { parentOrigin = new URL(document.referrer).origin; } catch {}
    if (window.location.ancestorOrigins?.length === 1)
      parentOrigin = window.location.ancestorOrigins[0];
    if (window.top === window.self || window.parent !== window.top || parentOrigin !== PARENT_ORIGIN)
      throw new Error('Otwórz konfigurację jako bezpośredni panel w Photopea, w tym samym profilu co Kubixsio Tools. Osobna karta nie zapewnia wspólnej pamięci klucza.');
    return true;
  }
  async function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Nie można otworzyć pamięci klucza. Sprawdź ustawienia danych witryn.'));
    });
  }
  async function localKey(value) {
    const connection = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = connection.transaction('keys', value ? 'readwrite' : 'readonly');
        // add, a nie put: druga karta nie może nadpisać istniejącego klucza.
        const request = value ? transaction.objectStore('keys').add(value, 'active')
          : transaction.objectStore('keys').get('active');
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(value || result);
        transaction.onerror = transaction.onabort = () => reject(new Error(
          'Nie udało się zapisać lub odczytać klucza. Być może inna karta już go utworzyła. Odśwież konfigurację.'));
      });
    } finally { connection.close(); }
  }
  function validateDevice(device) {
    if (!device) return null;
    const key = device.privateKey, publicKey = device.publicKey;
    if (!UUID.test(device.id) || typeof device.label !== 'string' || !device.label.trim()
      || device.label.length > 100 || !/^[a-f0-9]{64}$/.test(device.tokenHash)
      || device.server !== SERVER || device.version !== 1
      || publicKey?.kty !== 'EC' || publicKey.crv !== 'P-256' || publicKey.d !== undefined
      || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.x) || !/^[A-Za-z0-9_-]{43}$/.test(publicKey.y)
      || key?.type !== 'private' || key.extractable !== false
      || key.algorithm?.name !== 'ECDSA' || key.algorithm.namedCurve !== 'P-256'
      || key.usages.length !== 1 || key.usages[0] !== 'sign')
      throw new Error('W tym profilu istnieje starszy lub niezgodny klucz. Nie nadpisujemy go. Zachowaj stare dane i wyjaśnij sytuację przed rejestracją.');
    return device;
  }
  async function loadIdentity() {
    // Odczyt nie zależy od referrera: latest.html przekierowuje do plugin.html.
    // Przeglądarka sama dobiera partycję IndexedDB dla kontekstu osadzenia.
    assertSecureOrigin();
    return validateDevice(await localKey());
  }
  function publicRegistration(device) {
    const publicJson = JSON.stringify(device.publicKey);
    const values = [device.id, device.label, device.tokenHash, publicJson].map(quote);
    return {
      deviceId: device.id,
      label: device.label,
      server: SERVER,
      sql: 'INSERT INTO devices(id,label,token_hash,public_key_jwk) VALUES(' + values.join(',') + ');',
      verificationSql: 'SELECT id,label,auth_version,revoked_at,CASE WHEN token_hash='
        + quote(device.tokenHash) + ' AND public_key_jwk=' + quote(publicJson)
        + " THEN 'ZGODNE' ELSE 'NIEZGODNE' END AS registration FROM devices WHERE id=" + quote(device.id) + ';',
      revocationSql: 'UPDATE devices SET revoked_at=unixepoch(),auth_version=auth_version+1 WHERE id='
        + quote(device.id) + ';'
    };
  }
  async function canonicalMessage(body, nonce) {
    return 'KUBIXSIO_FOCUS_POINT_V1\nPOST\n/analyze\nAI\n' + nonce + '\n' + await digest(encoder.encode(body));
  }
  async function signBody(device, body, nonce) {
    const message = await canonicalMessage(body, nonce);
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, encoder.encode(message)));
    if (signature.length !== 64) throw new Error('Przeglądarka zwróciła niezgodny format podpisu.');
    return { message, signature };
  }
  async function checkDevice(device) {
    const nonce = crypto.randomUUID(), body = '{"purpose":"local-device-check","version":1}';
    const proof = await signBody(device, body, nonce);
    const publicKey = await crypto.subtle.importKey('jwk', device.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
      proof.signature, encoder.encode(proof.message));
    if (!valid) throw new Error('Zapisany klucz prywatny nie pasuje do klucza publicznego.');
    return { valid: true, privateKeyExportable: false, signatureBytes: 64, networkRequests: 0 };
  }
  async function createLocalIdentity(label) {
    checkSetupContext();
    if (await localKey()) throw new Error('Ten profil ma już klucz. Odśwież stronę; nie nadpisujemy kluczy.');
    if (typeof label !== 'string' || !label.trim() || label.length > 100)
      throw new Error('Podaj nazwę urządzenia od 1 do 100 znaków.');
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const device = { version: 1, id: crypto.randomUUID(), label: label.trim(),
      tokenHash: await digest(encoder.encode(token)),
      publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      privateKey: pair.privateKey, server: SERVER, createdAt: new Date().toISOString() };
    await checkDevice(device);
    await localKey(device); // Token nigdy nie trafia do IndexedDB.
    const restored = validateDevice(await localKey());
    await checkDevice(restored);
    return { ...publicRegistration(restored), token };
  }
  async function registration() {
    const device = await loadIdentity();
    return device ? publicRegistration(device) : null;
  }
  async function checkLocalIdentity() {
    const device = await loadIdentity();
    if (!device) throw new Error('Nie utworzono jeszcze klucza w tym profilu.');
    return checkDevice(device);
  }
  // Pomocnik przyszłego klienta. Challenge musi być przekazany przez klienta;
  // ta funkcja sama nie wysyła tokenu i nie wykonuje żadnego żądania.
  async function signedHeaders(body, token, challenge, server = SERVER) {
    if (server !== SERVER) throw new Error('Ta paczka obsługuje wyłącznie serwer STAGING.');
    if (typeof body !== 'string' || typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token))
      throw new Error('Brak poprawnej treści lub tokenu.');
    if (!challenge || challenge.signingVersion !== 1 || challenge.algorithm !== 'ECDSA-P256-SHA256'
      || !UUID.test(challenge.nonce) || !Number.isInteger(challenge.expiresAt)
      || challenge.expiresAt * 1000 <= Date.now() || challenge.expiresAt * 1000 > Date.now() + 310000)
      throw new Error('Niepoprawny lub wygasły challenge.');
    const device = await loadIdentity();
    if (!device) throw new Error('Brak klucza tego profilu.');
    if (await digest(encoder.encode(token)) !== device.tokenHash) throw new Error('Token nie pasuje do lokalnego urządzenia.');
    const proof = await signBody(device, body, challenge.nonce);
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Focus-Mode': 'AI',
      'X-Focus-Nonce': challenge.nonce, 'X-Focus-Signature': base64url(proof.signature) };
  }
  window.ktxDeviceAuth = Object.freeze({ createLocalIdentity, registration, checkLocalIdentity, signedHeaders, checkSetupContext,
    configuration: Object.freeze({ origin: ORIGIN, parentOrigin: PARENT_ORIGIN, server: SERVER, database: DB_NAME }) });
})();
