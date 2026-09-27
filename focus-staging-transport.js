/* STAGING only. Reuses ktxDeviceAuth and the existing P-256 signing contract.
 * No registration, private-key export, token persistence, logging or retry.
 */
(function () {
  'use strict';
  var SERVER = 'https://kubixsio-focus-point-staging.polizaless1.workers.dev';
  var ORIGIN = 'https://kubixsio.github.io';
  var MAX_BODY = 16 * 1024 * 1024;
  var encoder = new TextEncoder();
  function error(code, message) {
    var value = new Error(message); value.focusApiMessage = message; value.focusCode = code; return value;
  }
  function client() {
    var auth = window.ktxDeviceAuth;
    if (!auth || typeof auth.registration !== 'function' || typeof auth.signedHeaders !== 'function'
      || auth.configuration.origin !== ORIGIN || auth.configuration.server !== SERVER)
      throw error('CLIENT_UNAVAILABLE', 'Nie załadowano zgodnego modułu urządzenia. Odśwież wersję STAGING pluginu.');
    try { auth.checkSetupContext(); }
    catch (_) { throw error('CONTEXT_REQUIRED', 'Otwórz wersję STAGING jako panel w Photopea, w tym samym profilu przeglądarki co zarejestrowane urządzenie.'); }
    return auth;
  }
  async function initialize() {
    try {
      var auth = client(), registration = await auth.registration();
      if (!registration) throw error('KEY_MISSING', 'Brak zarejestrowanego urządzenia w tym panelu. Użyj profilu przeglądarki i Photopea, w których zapisano klucz. Nie twórz drugiego klucza.');
      await auth.checkLocalIdentity();
      return {ready: true, message: 'Urządzenie gotowe do podpisywania. Wpisz jego token STAGING na tę sesję.'};
    } catch (value) {
      return {ready: false, code: value.focusCode || 'KEY_UNAVAILABLE', message: value.focusApiMessage
        || 'Zapisany klucz urządzenia jest niedostępny lub niezgodny. Sprawdź profil przeglądarki i dostęp do danych witryn. Nie rejestruj urządzenia ponownie.'};
    }
  }
  function httpError(response, data) {
    var code = data && data.error && data.error.code;
    if (response.status === 401) return error('UNAUTHORIZED', 'Token jest nieprawidłowy lub dostęp urządzenia został unieważniony. Sprawdź token STAGING. Poprzednie porady pozostają.');
    if (code === 'DEVICE_PROOF_INVALID' || code === 'DEVICE_PROOF_REQUIRED' || code === 'DEVICE_KEY_REQUIRED')
      return error(code, 'Nie udało się potwierdzić podpisu urządzenia. Sprawdź, czy używasz właściwego profilu, tokenu i zatwierdzonego klucza STAGING. Poprzednie porady pozostają.');
    if (response.status === 403) return error('ACCESS_DENIED', 'Serwer odrzucił dostęp. Konfiguracja CORS musi dopuszczać https://kubixsio.github.io. Poprzednie porady pozostają.');
    if (code === 'NONCE_REPLAY' || code === 'NONCE_EXPIRED' || code === 'NONCE_INVALID')
      return error(code, 'Podpis wygasł albo challenge został już wykorzystany. Uruchom analizę ponownie, aby pobrać nowy challenge. Poprzednie porady pozostają.');
    if (response.status === 429) {
      var wait = Number(response.headers.get('Retry-After'));
      return error('RATE_LIMIT', 'Za dużo żądań. Odczekaj ' + (Number.isInteger(wait) && wait > 0 && wait <= 3600 ? wait : 60)
        + ' sekund przed kolejną próbą. Poprzednie porady pozostają.');
    }
    if (response.status === 413) return error('PAYLOAD_TOO_LARGE', 'Żądanie przekracza limit 16 MiB, łącznie z aktualnym i poprzednim obrazem. Poprzednie porady pozostają.');
    if ([400, 415, 422].includes(response.status)) return error('INVALID_DATA', 'Serwer odrzucił dane analizy. Odśwież podgląd i sprawdź oznaczenia oraz dodatnie wagi. Poprzednie porady pozostają.');
    if (code === 'AI_DISABLED' || code === 'CONFIGURATION_ERROR') return error('STAGING_NOT_READY', 'Konfiguracja serwera nie pozwala na podpisaną analizę MOCK. Sprawdź instrukcję wersji STAGING. Nie włączaj AI.');
    return error('SERVER_ERROR', 'Serwer STAGING jest niedostępny lub odrzucił żądanie. Spróbuj później. Poprzednie porady pozostają.');
  }
  async function jsonResponse(response, limit, signal) {
    if (!/application\/json\b/i.test(response.headers.get('Content-Type') || ''))
      throw error('INVALID_RESPONSE', 'Serwer zwrócił odpowiedź w niepoprawnym formacie. Poprzednie porady pozostają.');
    var length = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > limit) throw error('INVALID_RESPONSE', 'Odpowiedź serwera jest za duża. Poprzednie porady pozostają.');
    var reader = response.body && response.body.getReader(), chunks = [], size = 0;
    if (!reader) throw error('INVALID_RESPONSE', 'Serwer zwrócił pustą odpowiedź. Poprzednie porady pozostają.');
    try {
      while (true) {
        if (signal && signal.aborted) throw error('CANCELLED', 'Przerwano połączenie. Poprzednie porady pozostają.');
        var part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) throw error('INVALID_RESPONSE', 'Odpowiedź serwera jest za duża. Poprzednie porady pozostają.');
        chunks.push(part.value);
      }
      var bytes = new Uint8Array(size), offset = 0;
      chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
      try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
      catch (_) { throw error('INVALID_RESPONSE', 'Serwer zwrócił niepoprawny JSON. Poprzednie porady pozostają.'); }
    } finally { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
  }
  async function request(path, options, signal, limit) {
    if (!['/health', '/auth/challenge', '/analyze', '/analyze?example=no_changes'].includes(path))
      throw error('DESTINATION_BLOCKED', 'Niedozwolony adres serwera.');
    if (signal && signal.aborted) throw error('CANCELLED', 'Przerwano połączenie. Poprzednie porady pozostają.');
    var response;
    try {
      response = await fetch(SERVER + path, Object.assign({mode: 'cors', credentials: 'omit', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: signal}, options));
    } catch (_) {
      if (signal && signal.aborted) throw error('CANCELLED', 'Przerwano połączenie lub upłynął czas oczekiwania. Poprzednie porady pozostają.');
      throw error('NETWORK_ERROR', 'Nie można połączyć się ze STAGING. Sprawdź internet i dostępność serwera. Możliwa jest blokada CORS: ALLOWED_ORIGINS musi zawierać https://kubixsio.github.io. Poprzednie porady pozostają.');
    }
    var data;
    try { data = await jsonResponse(response, limit, signal); }
    catch (value) { if (!response.ok) throw httpError(response); throw value; }
    if (!response.ok) throw httpError(response, data);
    return {data: data, headers: response.headers};
  }
  async function analyze(body, token, noChanges, signal, progress) {
    var headers = null;
    function stage(text) { if (!signal || !signal.aborted) { if (progress) progress(text); } }
    try {
      if (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token))
        throw error('TOKEN_REQUIRED', 'Wpisz token zarejestrowanego urządzenia STAGING. Token pozostaje wyłącznie w pamięci sesji.');
      var status = await initialize();
      if (!status.ready) throw error(status.code, status.message);
      if (typeof body !== 'string' || encoder.encode(body).length > MAX_BODY) throw error('PAYLOAD_TOO_LARGE', 'Żądanie przekracza limit 16 MiB. Poprzednie porady pozostają.');
      stage('Sprawdzam gotowość serwera STAGING MOCK…');
      var health = (await request('/health', {method: 'GET'}, signal, 16384)).data;
      if (health.ok !== true || health.service !== 'kubixsio-focus-point' || health.mode !== 'mock'
        || health.aiEnabled !== false || health.mockDeviceProofRequired !== true)
        throw error('STAGING_NOT_READY', 'Serwer nie potwierdził podpisanych analiz MOCK. Wymagana jest zaakceptowana poprawka STAGING i MOCK_DEVICE_PROOF_REQUIRED=true. Nie wysłano tokenu ani obrazu.');
      stage('Pobieram jednorazowy challenge urządzenia…');
      var challenge = (await request('/auth/challenge', {method: 'POST', headers: {Authorization: 'Bearer ' + token}}, signal, 16384)).data;
      stage('Podpisuję cały obraz i dane Focus Point zapisanym kluczem…');
      try { headers = await client().signedHeaders(body, token, challenge, SERVER); }
      catch (_) { throw error('SIGNING_FAILED', 'Nie udało się podpisać danych. Sprawdź token urządzenia STAGING, profil przeglądarki i zegar systemowy. Nie twórz nowego klucza. Poprzednie porady pozostają.'); }
      // Signing V1 canonical stays /analyze + AI. MOCK is a transport execution
      // selector, not a new signature format. It makes paid execution impossible.
      headers['X-Focus-Mode'] = 'MOCK';
      stage('Wysyłam podpisane żądanie do STAGING MOCK…');
      var result = await request('/analyze' + (noChanges ? '?example=no_changes' : ''),
        {method: 'POST', headers: headers, body: body}, signal, 192 * 1024);
      if (result.headers.get('X-Analysis-Source') !== 'demo' || result.headers.get('X-Device-Proof-Verified') !== 'true')
        throw error('UNCONFIRMED_RESULT', 'Serwer nie potwierdził demonstracyjnego wyniku i weryfikacji podpisu. Poprzednie porady pozostają.');
      return result.data;
    } finally { token = ''; body = ''; headers = null; }
  }
  window.ktxFocusStaging = Object.freeze({initialize: initialize, analyze: analyze});
})();
