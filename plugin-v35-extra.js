let watermarkJob = {mode:"corner",opacity:70}, watermarkBytes = null, watermarkTimer, watermarkRun = 0;
window.ktxWatermarkDiagnostics = [];
function watermarkDiag(stage, details) {
  const entry = Object.assign({stage, mode:watermarkJob.mode, requestedOpacity:watermarkJob.opacity}, details);
  window.ktxWatermarkDiagnostics.push(entry);
  if (window.ktxWatermarkDiagnostics.length > 40) window.ktxWatermarkDiagnostics.shift();
  console.info('WATERMARK', JSON.stringify(entry));
}
function watermarkFail(error) {
  clearTimeout(watermarkTimer);
  watermarkDiag('error', {error:String(error)});
  watermarkStage='idle'; watermarkBytes=null;
  setStatus('Błąd — WATERMARK: '+String(error),'err');
}
async function runWatermark() {
  if (watermarkStage!=='idle') return;
  const run=++watermarkRun;
  watermarkJob=window.ktxWatermarkControls.getOptions();
  watermarkStage='capturing';watermarkState=null;watermarkBytes=null;
  watermarkGotState=false;watermarkGotPrepDone=false;
  watermarkDiag('ui');
  setStatus('Dodaję watermark...','busy');
  // This timer only reports a missing reply. It never schedules an editing operation.
  watermarkTimer=setTimeout(()=>watermarkFail('Brak potwierdzenia Photopea'),45000);
  postScript('try{var d=app.activeDocument;var ids=[];for(var i=0;i<d.layers.length;i++)ids.push(Number(d.layers[i].id));app.echoToOE("KTX_WM_STATE|"+JSON.stringify({name:String(d.name),source:String(d.source),count:d.layers.length,ids:ids}))}catch(e){app.echoToOE("KTX_ERR|WATERMARK|"+String(e))}');
  try {
    const url=watermarkJob.mode==='full'?new URL('watermark-full.png',window.location.href).href:WATERMARK_URL;
    const response=await fetch(url);
    if (!response.ok) throw new Error('Nie udało się pobrać PNG ('+response.status+')');
    const bytes=await response.arrayBuffer();
    if (bytes.byteLength<24 || bytes.byteLength>16*1024*1024 ||
        ![137,80,78,71,13,10,26,10].every((v,i)=>new Uint8Array(bytes)[i]===v)) throw new Error('Niepoprawny PNG watermarka');
    if (run!==watermarkRun || watermarkStage!=='capturing') return;
    watermarkBytes=bytes;maybeOpenWatermark();
  } catch(error) { if(run===watermarkRun)watermarkFail(error.message); }
}
function maybeOpenWatermark() {
  if(watermarkStage!=='capturing'||!watermarkGotState||!watermarkGotPrepDone||!watermarkBytes)return;
  watermarkStage='opening';
  watermarkDiag('binary-import');
  window.parent.postMessage(watermarkBytes,'*');
}
function placeWatermark(state) {
  var source=app.activeDocument, target=null;
  for(var i=0;i<app.documents.length;i++) if(String(app.documents[i].source)===state.source) target=app.documents[i];
  if(!target || String(source.source)===state.source) return {error:"Import PNG nie utworzył dokumentu źródłowego"};
  if(target.layers.length!==state.count) return {error:"Zmieniono warstwy dokumentu podczas importu"};
  var sw=Number(source.width),sh=Number(source.height),dw=Number(target.width),dh=Number(target.height);
  var originalBounds=source.activeLayer.bounds;
  var x=Number(originalBounds[0])*dw/sw,y=Number(originalBounds[1])*dh/sh;
  source.selection.selectAll();source.selection.copy();source.selection.deselect();
  app.activeDocument=target;var placed=target.paste();target.activeLayer=placed;
  placed.resize(dw/sw*100,dh/sh*100,AnchorPosition.MIDDLECENTER);
  var b=placed.bounds;
  placed.translate(x-Number(b[0]),y-Number(b[1]));
  var id=Number(placed.id);
  source.close(SaveOptions.DONOTSAVECHANGES);app.activeDocument=target;
  return {error:null,id:id,opacity:Number(target.activeLayer.opacity),blend:String(target.activeLayer.blendMode)};
}
function placeImportedWatermark() {
  watermarkStage='placing';
  postScript(placeWatermark.toString()+';try{var r=placeWatermark('+JSON.stringify(watermarkState)+');if(r.error)app.echoToOE("KTX_ERR|WATERMARK|"+r.error);else app.echoToOE("KTX_WM_PLACED|"+JSON.stringify(r))}catch(e){app.echoToOE("KTX_ERR|WATERMARK|"+String(e))}');
}
// Executed by Photopea's scripting interpreter. Avoid returns inside try blocks
// and compare stable layer IDs, since repeated layer access creates fresh wrappers.
function applyWatermark(doc, state, job) {
  app.echoToOE("KTX_WM_DIAG|"+JSON.stringify({stage:"apply-start",count:doc.layers.length,expected:state.count+1,mode:job.mode,opacity:job.opacity}));
  function findLayer(id) {
    for (var i = 0; i < doc.layers.length; i++) {
      if (Number(doc.layers[i].id) === id) return doc.layers[i];
    }
    return null;
  }
  if (!state || String(doc.name) !== state.name ||
      state.source && String(doc.source) !== state.source) return {error:"Zmieniono dokument docelowy"};
  if (doc.layers.length !== state.count + 1) return {error:"PNG nie dodał dokładnie jednej warstwy"};
  app.echoToOE("KTX_WM_DIAG|"+JSON.stringify({stage:"identify"}));
  var importedId = null;
  for (var i = 0; i < doc.layers.length; i++) {
    var candidateId = Number(doc.layers[i].id), known = false;
    for (var j = 0; j < state.ids.length; j++) if (candidateId === state.ids[j]) known = true;
    if (!known) {
      if (importedId !== null || !isFinite(candidateId)) return {error:"Niejednoznaczna nowa warstwa"};
      importedId = candidateId;
    }
  }
  if (importedId === null) return {error:"Nie znaleziono nowej warstwy WATERMARK"};
  app.echoToOE("KTX_WM_DIAG|"+JSON.stringify({stage:"identified",id:importedId}));
  var layer = findLayer(importedId);
  if (!layer) return {error:"Brak nowej warstwy"};
  if (layer.isBackgroundLayer) return {error:"Odrzucono warstwę Background"};
  doc.activeLayer = layer;
  layer.rasterize(RasterizeType.ENTIRELAYER);
  layer = findLayer(importedId);
  if (job.mode === "corner") {
    function removeOld(layers) {
      for (var n = layers.length - 1; n >= 0; n--) {
        var old = layers[n];
        if (old.layers) removeOld(old.layers);
        if (Number(old.id) !== importedId && String(old.name) === "WATERMARK" && !old.isBackgroundLayer) old.remove();
      }
    }
    removeOld(doc.layers);
  }
  layer = findLayer(importedId);
  var top = doc.layers[0];
  if (Number(top.id) !== importedId) layer.move(top, ElementPlacement.PLACEBEFORE);
  if (Number(doc.layers[0].id) !== importedId) return {error:"Nie udało się przenieść WATERMARK na samą górę"};
  doc.activeLayer = findLayer(importedId);
  doc.activeLayer.name = job.mode === "full" ? "WATERMARK NA CAŁOŚĆ" : "WATERMARK";
  app.echoToOE("KTX_WM_DIAG|"+JSON.stringify({stage:"before-settings",id:importedId,opacity:Number(doc.activeLayer.opacity),blend:String(doc.activeLayer.blendMode)}));
  doc.activeLayer.opacity = job.opacity;
  if (job.mode === "full") doc.activeLayer.blendMode = BlendMode.OVERLAY;
  app.echoToOE("KTX_WM_DIAG|"+JSON.stringify({stage:"after-settings",id:importedId,opacity:Number(doc.activeLayer.opacity),blend:String(doc.activeLayer.blendMode)}));
  // Photopea quantizes opacity to 8 bits, e.g. 70% reads back as 70.196%.
  if (Number(doc.activeLayer.id) !== importedId ||
      Math.abs(Number(doc.activeLayer.opacity) - job.opacity) > 100 / 255 ||
      job.mode === "full" && String(doc.activeLayer.blendMode) !== String(BlendMode.OVERLAY))
    return {error:"Nie udało się potwierdzić ustawień watermarka"};
  return {error:null};
}
function finishWatermark() {
  watermarkStage='finishing';
  postScript(applyWatermark.toString()+';try{var r=applyWatermark(app.activeDocument,'+JSON.stringify(watermarkState)+','+JSON.stringify(watermarkJob)+');if(r && r.error)app.echoToOE("KTX_ERR|WATERMARK|"+r.error);else app.echoToOE("KTX_OK|Watermark gotowy")}catch(e){app.echoToOE("KTX_ERR|WATERMARK|"+String(e))}');
}
updateNoiseUI();
window.addEventListener('message',function(e){if(e.data==='done'){if(vignetteStage==='loading'){finishVignette();return}if(vignetteStage==='finishing'){vignetteStage='idle';setStatus('Winieta gotowa','');return}if(watermarkStage==='capturing'){watermarkGotPrepDone=true;maybeOpenWatermark();return}if(watermarkStage==='opening'){placeImportedWatermark();return}if(watermarkStage==='finishing'||watermarkStage!=='idle')return;if(window.folderizeBusy)return;setStatus('Gotowe','');return}if(typeof e.data!=='string')return;
if(e.data.indexOf('KTX_WM_DIAG|')===0){try{watermarkDiag('photopea',JSON.parse(e.data.substring(12)))}catch(err){watermarkFail(err.message)}return}
if(e.data.indexOf('KTX_WM_PLACED|')===0&&watermarkStage==='placing'){try{watermarkDiag('placed',JSON.parse(e.data.substring(14)));finishWatermark()}catch(err){watermarkFail(err.message)}return}
if(e.data.indexOf('KTX_WM_STATE|')===0&&watermarkStage==='capturing'){try{watermarkState=JSON.parse(e.data.substring(13));watermarkGotState=true;maybeOpenWatermark()}catch(err){watermarkFail('Odczyt projektu: '+err.message)}return}if(e.data.indexOf('KTX_OK|')===0){if(e.data.indexOf('Winieta gotowa')>0)vignetteStage='idle';if(e.data.indexOf('Watermark gotowy')>0){clearTimeout(watermarkTimer);watermarkDiag('verified');watermarkStage='idle';watermarkBytes=null;}setStatus(e.data.substring(7),'');return}if(e.data.indexOf('KTX_ERR|WATERMARK|')===0){watermarkFail(e.data.substring(18));return}if(e.data.indexOf('KTX_ERR|')===0){vignetteStage='idle';watermarkStage='idle';setStatus('Błąd — '+e.data.substring(8),'err')}});