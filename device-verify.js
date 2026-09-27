(function () {
  'use strict';
  const SERVER='https://kubixsio-focus-point-staging.polizaless1.workers.dev';
  const ALLOWED_PATHS=new Set(['/health','/auth/challenge','/auth/verify']);
  const KNOWN_CODES=new Set(['NOT_FOUND','UNAUTHORIZED','DEVICE_KEY_REQUIRED','DEVICE_PROOF_REQUIRED',
    'DEVICE_PROOF_INVALID','NONCE_INVALID','NONCE_REPLAY','NONCE_EXPIRED','RATE_LIMIT',
    'INVALID_TEST_DATA','INVALID_JSON','INVALID_QUERY','INVALID_MODE','PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE','UNSUPPORTED_ENCODING','ORIGIN_NOT_ALLOWED','DATABASE_NOT_CONFIGURED',
    'INTERNAL_ERROR','CONFIGURATION_ERROR','CORS_NOT_CONFIGURED']);
  const element=id=>document.getElementById(id);
  const buttons=['run','parallel','prepare-expiry','check-expiry'];
  let ready=false,busy=false,nextRunAt=0,prepared=null,epoch=0;
  const controllers=new Set();
  class TestError extends Error { constructor(code){super(code);this.code=code;} }
  function updateButtons() {
    const seconds=Math.max(0,Math.ceil((nextRunAt-Date.now())/1000));
    for(const id of buttons) element(id).disabled=!ready||busy||seconds>0
      ||(id==='check-expiry'&&(!prepared||Date.now()<prepared.expiresAt*1000+2000));
    element('cooldown').textContent=seconds?'Do następnego testu poczekaj '+seconds+' s (limit 6 zapytań/min na urządzenie).':'';
    if(prepared) element('expiry-info').textContent=Date.now()<prepared.expiresAt*1000+2000
      ?'Poczekaj do '+new Date(prepared.expiresAt*1000+2000).toLocaleTimeString()+'. Podpis pozostaje wyłącznie w pamięci tej strony.'
      :'Challenge powinien już wygasnąć. Możesz uruchomić sprawdzenie.';
  }
  function result(label,text) {
    const row=document.createElement('li');row.textContent=label+' — '+text;element('results').appendChild(row);
  }
  function errorMessage(error) {
    const code=error instanceof TestError?error.code:'LOCAL_KEY_ERROR';
    const messages={NETWORK:'Nie udało się połączyć ze staging. Sprawdź połączenie i CORS; przeglądarka nie rozróżnia ich jednoznacznie.',
      TIMEOUT:'Przekroczono czas odpowiedzi. Nie ponawiamy żądania automatycznie.',
      ABORTED:'Test zatrzymano i wyczyszczono dane.',UNAUTHORIZED:'Token jest nieprawidłowy lub dostęp urządzenia został unieważniony.',
      RATE_LIMIT:'Za dużo zapytań. Odczekaj co najmniej minutę.',NOT_FOUND:'Endpoint testowy jest wyłączony lub Worker nie został zaktualizowany.',
      UNSAFE_HEALTH:'Staging nie potwierdził trybu MOCK, wyłączonego AI i włączonego testu. Zatrzymano test.',
      INVALID_RESPONSE:'Serwer zwrócił nieoczekiwaną odpowiedź.',NO_TOKEN:'Wpisz token tego urządzenia.',
      LOCAL_KEY_ERROR:'Nie udało się użyć lokalnego klucza lub token nie pasuje do tego urządzenia. Sprawdź profil i swoją kopię tokenu.',
      EXPECTATION_FAILED:'Wynik nie spełnia oczekiwań bezpieczeństwa. Zatrzymano test.',
      NONCE_EXPIRED:'Challenge wygasł.',NONCE_REPLAY:'Challenge został już wykorzystany.',NONCE_INVALID:'Challenge jest nieprawidłowy.'};
    return (messages[code]||'Test odrzucony przez staging.')+' ['+code+']';
  }
  async function request(path,method,headers,body) {
    if(!ALLOWED_PATHS.has(path)) throw new TestError('EXPECTATION_FAILED');
    const controller=new AbortController();controllers.add(controller);
    let timedOut=false;
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},15000);
    try {
      let response;
      try {response=await fetch(SERVER+path,{method,headers,body,mode:'cors',credentials:'omit',cache:'no-store',
        redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});}
      catch {throw new TestError(timedOut?'TIMEOUT':controller.signal.aborted?'ABORTED':'NETWORK');}
      if(!response.body) throw new TestError('INVALID_RESPONSE');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {
        while(true) {const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
          if(size>16384){await reader.cancel();throw new TestError('INVALID_RESPONSE');}chunks.push(part.value);}
      } catch(error) {throw error instanceof TestError?error:new TestError(timedOut?'TIMEOUT':'INVALID_RESPONSE');}
      finally {reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new TestError('INVALID_RESPONSE');}
      const code=KNOWN_CODES.has(data?.error?.code)?data.error.code:null;
      // Nie wypisujemy body odpowiedzi, nagłówków ani wiadomości błędu serwera.
      return {status:response.status,data,code};
    } finally {clearTimeout(timeout);controllers.delete(controller);}
  }
  function expect(response,status,code) {
    if(response.status!==status||(code&&response.code!==code)) {
      if(response.code==='RATE_LIMIT') throw new TestError('RATE_LIMIT');
      if(response.code==='NOT_FOUND') throw new TestError('NOT_FOUND');
      if(response.code==='UNAUTHORIZED') throw new TestError('UNAUTHORIZED');
      throw new TestError('EXPECTATION_FAILED');
    }
  }
  function expectSuccess(response) {
    expect(response,200);
    const value=response.data;
    if(value?.ok!==true||value.purpose!=='device-signature-test'||value.tokenValid!==true
      ||value.signatureValid!==true||value.challengeConsumed!==true
      ||value.openAICalled!==false||value.analysisQuotaUsed!==false) throw new TestError('INVALID_RESPONSE');
  }
  async function health() {
    const response=await request('/health','GET');
    expect(response,200);
    if(response.data?.ok!==true||response.data.service!=='kubixsio-focus-point'
      ||response.data.mode!=='mock'||response.data.aiEnabled!==false||response.data.authVerifyEnabled!==true)
      throw new TestError('UNSAFE_HEALTH');
  }
  async function prepare(token,guard) {
    if(!token) throw new TestError('NO_TOKEN');
    await health();guard();
    const challenge=await request('/auth/challenge','POST',{Authorization:'Bearer '+token});
    guard();
    expect(challenge,200);
    const body=JSON.stringify({schemaVersion:1,purpose:'device-signature-test',testId:crypto.randomUUID()});
    let headers;
    try {headers=await window.ktxDeviceAuth.signedHeaders(body,token,challenge.data,SERVER);}
    catch {throw new TestError('LOCAL_KEY_ERROR');}
    return {body,headers,expiresAt:challenge.data.expiresAt};
  }
  async function run(action) {
    if(busy||!ready||Date.now()<nextRunAt)return;
    const token=element('token').value.trim(),myEpoch=epoch;
    if(!token){element('status').textContent=errorMessage(new TestError('NO_TOKEN'));return;}
    busy=true;element('token').disabled=true;element('results').replaceChildren();updateButtons();
    element('status').textContent='Testowanie STAGING…';
    try {await action(token,()=>{if(myEpoch!==epoch)throw new TestError('ABORTED');});
      if(myEpoch===epoch)element('status').textContent='Test zakończony zgodnie z oczekiwaniami. Nie wykonano analizy obrazu.';}
    catch(error){if(myEpoch===epoch)element('status').textContent=errorMessage(error);}
    finally {busy=false;nextRunAt=Date.now()+61000;element('token').disabled=!ready;updateButtons();}
  }
  element('run').addEventListener('click',()=>run(async(token,guard)=>{
    prepared=null;element('expiry-info').textContent='';
    const proof=await prepare(token,guard);guard();
    const altered=JSON.stringify({...JSON.parse(proof.body),testId:crypto.randomUUID()});
    let response=await request('/auth/verify','POST',proof.headers,altered);guard();
    expect(response,403,'DEVICE_PROOF_INVALID');result('Zmieniona treść','OK — podpis odrzucony (403).');
    const badSignature=(proof.headers['X-Focus-Signature'][0]==='A'?'B':'A')+proof.headers['X-Focus-Signature'].slice(1);
    response=await request('/auth/verify','POST',{...proof.headers,'X-Focus-Signature':badSignature},proof.body);guard();
    expect(response,403,'DEVICE_PROOF_INVALID');result('Zmieniony podpis','OK — podpis odrzucony (403).');
    // Losowy token testowy nie jest nigdzie utrwalany ani wyświetlany.
    response=await request('/auth/verify','POST',{...proof.headers,Authorization:'Bearer '+crypto.randomUUID()+crypto.randomUUID()},proof.body);guard();
    expect(response,401,'UNAUTHORIZED');result('Nieprawidłowy token','OK — dostęp odrzucony (401).');
    response=await request('/auth/verify','POST',proof.headers,proof.body);guard();
    expectSuccess(response);result('Poprawny token, podpis i challenge','OK — przyjęte (200), challenge zużyty.');
    response=await request('/auth/verify','POST',proof.headers,proof.body);guard();
    expect(response,409,'NONCE_REPLAY');result('Ponowne użycie challenge','OK — odrzucone (409 NONCE_REPLAY).');
    result('OpenAI i limit analiz','Serwer potwierdził openAICalled=false i analysisQuotaUsed=false.');
  }));
  element('parallel').addEventListener('click',()=>run(async(token,guard)=>{
    const proof=await prepare(token,guard);guard();
    const responses=await Promise.all([request('/auth/verify','POST',proof.headers,proof.body),
      request('/auth/verify','POST',proof.headers,proof.body)]);guard();
    if(responses.filter(value=>value.status===200).length!==1
      ||responses.filter(value=>value.status===409&&value.code==='NONCE_REPLAY').length!==1)
      throw new TestError(responses.some(value=>value.code==='RATE_LIMIT')?'RATE_LIMIT':'EXPECTATION_FAILED');
    expectSuccess(responses.find(value=>value.status===200));
    result('Dwa równoczesne żądania','OK — dokładnie jedno 200 i jedno 409 NONCE_REPLAY.');
    result('OpenAI i limit analiz','Bez analizy i bez zużycia limitu płatnych analiz.');
  }));
  element('prepare-expiry').addEventListener('click',()=>run(async(token,guard)=>{
    const proof=await prepare(token,guard);guard();prepared=proof;updateButtons();
    result('Challenge przygotowany','Poczekaj na wskazany czas, potem kliknij SPRAWDŹ WYGAŚNIĘTY CHALLENGE.');
  }));
  element('check-expiry').addEventListener('click',()=>run(async(_token,guard)=>{
    if(!prepared||Date.now()<prepared.expiresAt*1000+2000)throw new TestError('EXPECTATION_FAILED');
    await health();guard();
    const response=await request('/auth/verify','POST',prepared.headers,prepared.body);guard();
    // Istniejący /auth/challenge usuwa przeterminowane wiersze. Jeżeli w tym
    // czasie pobrano inny challenge, stary może już nie istnieć w D1.
    if(response.status===409&&response.code==='NONCE_INVALID')
      result('Wygasły challenge','OK — odrzucony (409 NONCE_INVALID; wygasły wpis mógł zostać usunięty).');
    else {expect(response,410,'NONCE_EXPIRED');result('Wygasły challenge','OK — odrzucony (410 NONCE_EXPIRED).');}
    prepared=null;element('expiry-info').textContent='';
  }));
  function clear() {
    epoch++;prepared=null;element('token').value='';element('expiry-info').textContent='';
    for(const controller of controllers)controller.abort();
    element('results').replaceChildren();element('status').textContent='Token i dane testu wyczyszczone. Klucz urządzenia pozostał w przeglądarce.';
    updateButtons();
  }
  element('clear').addEventListener('click',clear);window.addEventListener('pagehide',clear);
  let interval=setInterval(updateButtons,1000);
  window.addEventListener('pagehide',()=>{clearInterval(interval);interval=null;});
  window.addEventListener('pageshow',()=>{if(interval===null)interval=setInterval(updateButtons,1000);});
  (async()=>{
    try {
      window.ktxDeviceAuth.checkSetupContext();
      const device=await window.ktxDeviceAuth.registration();
      if(!device||device.server!==SERVER)throw new TestError('LOCAL_KEY_ERROR');
      await window.ktxDeviceAuth.checkLocalIdentity();
      element('identity').textContent='Urządzenie: '+device.label+' | ID: '+device.deviceId;
      ready=true;element('token').disabled=false;element('status').textContent='Lokalny klucz gotowy. Wpisz token i wybierz test. Bez płatnych analiz.';
    } catch(error){element('status').textContent=errorMessage(error);}
    updateButtons();
  })();
})();
