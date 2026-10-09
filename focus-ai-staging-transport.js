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
    if (code === 'OPENAI_REDIRECT_REJECTED') {
      var redirect = data.error.diagnostic || {};
      var status = Number.isInteger(redirect.httpStatus) && redirect.httpStatus >= 300
        && redirect.httpStatus < 400 ? redirect.httpStatus : '?';
      var hostname = typeof redirect.hostname === 'string' && /^[a-z0-9.-]{1,253}$/i.test(redirect.hostname)
        && redirect.hostname.split('.').every(function (segment) { return segment.length <= 24; })
        ? redirect.hostname : '[ukryty]';
      var pathname = typeof redirect.pathname === 'string' && /^\/[a-z0-9/._~-]{0,159}$/i.test(redirect.pathname)
        && redirect.pathname.split('/').every(function (segment) { return segment.length <= 24; })
        ? redirect.pathname : '[ukryta]';
      return error(code, 'Odrzucono przekierowanie OpenAI.\nKod: OPENAI_REDIRECT_REJECTED'
        + '\nHTTP: ' + status + '\nCel: ' + hostname + pathname
        + '\nPoprzednie porady pozostają. Próba zużyła limit; nie ponawiamy automatycznie.');
    }
    if (code === 'OPENAI_NETWORK_ERROR' || code === 'OPENAI_REQUEST_BUILD_ERROR') {
      var diagnostic = data.error.diagnostic || {};
      var categories = ['FETCH_FAILED','DNS_OR_CONNECTION','ABORTED','UNKNOWN_NETWORK_ERROR',
        'REDIRECT_BLOCKED','INVALID_REQUEST_OPTIONS','REQUEST_BUILD_FAILED'];
      var names = ['TypeError','AbortError','TimeoutError','NetworkError','Error','UnknownError'];
      var category = categories.includes(diagnostic.category) ? diagnostic.category : 'UNKNOWN_NETWORK_ERROR';
      var exceptionName = names.includes(diagnostic.exceptionName) ? diagnostic.exceptionName : 'UnknownError';
      var stage = diagnostic.stage === 'request_build' ? 'REQUEST_BUILD'
        : diagnostic.stage === 'redirect_fetch' ? 'REDIRECT_FETCH' : 'UPSTREAM_FETCH';
      return error(code, (code === 'OPENAI_NETWORK_ERROR' ? 'Nie udało się połączyć z OpenAI.'
        : 'Nie udało się przygotować żądania OpenAI.')
        + '\nKod: ' + code + '\nSzczegóły: ' + category + ' · ' + exceptionName + ' · ' + stage
        + '\nPoprzednie porady pozostają. Próba zużyła limit; nie ponawiamy automatycznie.');
    }
    var openAI = {
      OPENAI_TIMEOUT: 'Upłynął czas analizy. Koszt może zostać naliczony; próba zużyła limit. Nie ponawiamy automatycznie.',
      OPENAI_UNAVAILABLE: 'Nie otrzymano odpowiedzi OpenAI. Koszt może zostać naliczony; próba zużyła limit. Nie ponawiamy automatycznie.',
      OPENAI_REFUSAL: 'Model odmówił analizy. Próba zużyła limit.',
      OPENAI_OUTPUT_LIMIT: 'Odpowiedź przekroczyła limit 4000 tokenów. Nie pokazujemy urwanych porad. Próba zużyła limit.',
      OPENAI_CONTENT_FILTER: 'OpenAI nie ukończył odpowiedzi z powodu filtrowania treści. Próba zużyła limit.',
      OPENAI_INCOMPLETE: 'OpenAI nie ukończył odpowiedzi. Próba zużyła limit.',
      OPENAI_INVALID_RESPONSE: 'OpenAI zwrócił niepoprawną odpowiedź. Próba zużyła limit.',
      OPENAI_INVALID_RESULT: 'Odpowiedź OpenAI nie pasuje do poradnika. Próba zużyła limit.',
      OPENAI_FAILED: 'OpenAI zakończył próbę błędem. Próba zużyła limit.',
      OPENAI_ERROR: 'OpenAI odrzucił próbę. Próba zużyła limit.',
      OPENAI_SPEND_LIMIT: 'OpenAI wstrzymał dostęp z powodu limitu wydatków, rozliczeń lub kredytów. Sprawdź projekt OpenAI. Próba zużyła limit.',
      OPENAI_RATE_LIMIT: 'OpenAI ograniczył częstotliwość żądań. Próba zużyła limit.',
      OPENAI_AUTH_ERROR: 'Sprawdź sekret OPENAI_API_KEY i uprawnienia projektu OpenAI w Cloudflare. Próba zużyła limit.'
    };
    if (Object.prototype.hasOwnProperty.call(openAI, code)) return error(code, openAI[code] + ' Poprzednie porady i stany pozostają.');
    if (code === 'DAILY_LIMIT' || code === 'MONTHLY_LIMIT') return error(code,
      (code === 'DAILY_LIMIT' ? 'Wykorzystano 5 prób AI w dniu UTC. Limit odnowi się o 00:00 UTC.'
        : 'Wykorzystano 50 prób AI w miesiącu UTC. Limit odnowi się pierwszego dnia kolejnego miesiąca o 00:00 UTC.')
      + ' To limit prób, nie pieniędzy. Poprzednie porady i stany pozostają.');
    if (['AI_DISABLED', 'PAID_STAGING_NOT_APPROVED', 'OPENAI_NOT_CONFIGURED', 'CONFIGURATION_ERROR', 'MODEL_NOT_ALLOWED'].includes(code))
      return error(code, 'Serwer nie jest gotowy do wybranego trybu STAGING. Sprawdź konfigurację i instrukcję; nie wysłano żądania do OpenAI. Poprzednie porady pozostają.');
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
      if (signal && signal.aborted) throw error('CANCELLED', 'Przerwano połączenie lub upłynął czas oczekiwania. W AI koszt może zostać naliczony. Nie ponawiamy automatycznie. Poprzednie porady pozostają.');
      throw error('NETWORK_ERROR', 'Nie można połączyć się ze STAGING. Sprawdź internet i serwer. Możliwa jest blokada CORS: ALLOWED_ORIGINS musi zawierać https://kubixsio.github.io. W AI koszt może zostać naliczony, jeśli żądanie dotarło. Nie ponawiamy automatycznie. Poprzednie porady pozostają.');
    }
    var data;
    try { data = await jsonResponse(response, limit, signal); }
    catch (value) { if (!response.ok) throw httpError(response); throw value; }
    if (!response.ok) throw httpError(response, data);
    return {data: data, headers: response.headers};
  }
  function count(headers, name) {
    var raw = headers.get(name);
    if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
    var value = Number(raw); return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  async function analyze(body, token, noChanges, signal, progress, executionMode) {
    var headers = null;
    var mode = executionMode || 'MOCK';
    function stage(text) { if (!signal || !signal.aborted) { if (progress) progress(text); } }
    try {
      if (!['MOCK', 'AI'].includes(mode) || (mode === 'AI' && noChanges))
        throw error('INVALID_MODE', 'Nieprawidłowy tryb analizy. Test braku poprawek jest dostępny tylko w MOCK.');
      if (typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token))
        throw error('TOKEN_REQUIRED', 'Wpisz token zarejestrowanego urządzenia STAGING. Token pozostaje wyłącznie w pamięci sesji.');
      var status = await initialize();
      if (!status.ready) throw error(status.code, status.message);
      if (typeof body !== 'string' || encoder.encode(body).length > MAX_BODY) throw error('PAYLOAD_TOO_LARGE', 'Żądanie przekracza limit 16 MiB. Poprzednie porady pozostają.');
      stage('Sprawdzam gotowość serwera STAGING ' + mode + '…');
      var health = (await request('/health', {method: 'GET'}, signal, 16384)).data;
      if (!health || health.ok !== true || health.service !== 'kubixsio-focus-point'
        || (mode === 'MOCK' && health.signedMockAvailable !== true &&
          !(health.mode === 'mock' && health.aiEnabled === false && health.mockDeviceProofRequired === true))
        || (mode === 'AI' && (health.version !== '2.1.0' || health.mode !== 'ai' || health.aiEnabled !== true || health.paidAiReady !== true)))
        throw error('STAGING_NOT_READY', 'Serwer nie potwierdził gotowości wybranego trybu ' + mode + '. Sprawdź instrukcję STAGING. Nie wysłano tokenu ani obrazu. Poprzednie porady pozostają.');
      stage('Pobieram jednorazowy challenge urządzenia…');
      var challenge = (await request('/auth/challenge', {method: 'POST', headers: {Authorization: 'Bearer ' + token}}, signal, 16384)).data;
      stage('Podpisuję cały obraz i dane Focus Point zapisanym kluczem…');
      try { headers = await client().signedHeaders(body, token, challenge, SERVER); }
      catch (_) { throw error('SIGNING_FAILED', 'Nie udało się podpisać danych. Sprawdź token urządzenia STAGING, profil przeglądarki i zegar systemowy. Nie twórz nowego klucza. Poprzednie porady pozostają.'); }
      // Signing V1 canonical stays /analyze + AI in both execution modes.
      // Explicit MOCK selects the server branch with no OpenAI or paid admission.
      headers['X-Focus-Mode'] = mode;
      stage('Wysyłam podpisane żądanie do STAGING ' + mode + (mode === 'AI' ? ' — rzeczywista analiza OpenAI…' : ' — demonstracja bez OpenAI…'));
      var result = await request('/analyze' + (noChanges ? '?example=no_changes' : ''),
        {method: 'POST', headers: headers, body: body}, signal, 192 * 1024);
      var source = mode === 'AI' ? 'ai' : 'demo';
      if (result.headers.get('X-Analysis-Source') !== source || result.headers.get('X-Device-Proof-Verified') !== 'true')
        throw error('UNCONFIRMED_RESULT', 'Serwer nie potwierdził właściwego źródła wyniku i podpisu urządzenia. Poprzednie porady pozostają.');
      return {result: result.data, source: source, telemetry: source === 'ai' ? {
        day: count(result.headers, 'X-AI-Attempts-Day'), month: count(result.headers, 'X-AI-Attempts-Month'),
        inputTokens: count(result.headers, 'X-OpenAI-Input-Tokens'), outputTokens: count(result.headers, 'X-OpenAI-Output-Tokens'),
        cachedTokens: count(result.headers, 'X-OpenAI-Cached-Tokens')
      } : null};
    } finally { token = ''; body = ''; headers = null; }
  }
  window.ktxFocusStaging = Object.freeze({initialize: initialize, analyze: analyze});
})();
