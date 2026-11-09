let watermarkJob = {mode: "corner", opacity: 70};
function runWatermark(){if(watermarkStage!=='idle')return;watermarkJob=window.ktxWatermarkControls.getOptions();watermarkStage='capturing';watermarkState=null;watermarkGotState=false;watermarkGotPrepDone=false;setStatus('Dodaję watermark...','busy');postScript('try{var doc=app.activeDocument;if(!doc)throw new Error("Brak otwartego dokumentu");var ids=[];var names=[];for(var i=0;i<doc.layers.length;i++){var L=doc.layers[i];var id=null;try{id=Number(L.id)}catch(e){}ids.push(id);names.push(L.name)}app.echoToOE("KTX_WM_STATE|"+JSON.stringify({name:String(doc.name),source:String(doc.source),count:doc.layers.length,ids:ids,names:names}))}catch(e){app.echoToOE("KTX_ERR|WATERMARK|"+e.toString())}')}
function maybeOpenWatermark(){if(watermarkStage!=='capturing'||!watermarkGotState||!watermarkGotPrepDone)return;watermarkStage='opening';var url=watermarkJob.mode==='full'?new URL('watermark-full.png',window.location.href).href:WATERMARK_URL;postScript('app.open("'+url+'", null, true);')}
// Executed by Photopea's scripting interpreter. Avoid returns inside try blocks
// and compare stable layer IDs, since repeated layer access creates fresh wrappers.
function applyWatermark(doc, state, job) {
  function findLayer(id) {
    for (var i = 0; i < doc.layers.length; i++) {
      if (Number(doc.layers[i].id) === id) return doc.layers[i];
    }
    throw new Error("Nie znaleziono zaimportowanej warstwy");
  }
  if (!state || String(doc.name) !== state.name ||
      state.source && String(doc.source) !== state.source) throw new Error("Zmieniono dokument docelowy");
  if (doc.layers.length !== state.count + 1) throw new Error("PNG nie dodał dokładnie jednej warstwy");
  var importedId = null;
  for (var i = 0; i < doc.layers.length; i++) {
    var candidateId = Number(doc.layers[i].id), known = false;
    for (var j = 0; j < state.ids.length; j++) if (candidateId === state.ids[j]) known = true;
    if (!known) {
      if (importedId !== null || !isFinite(candidateId)) throw new Error("Niejednoznaczna nowa warstwa");
      importedId = candidateId;
    }
  }
  if (importedId === null) throw new Error("Nie znaleziono nowej warstwy WATERMARK");
  var layer = findLayer(importedId);
  if (layer.isBackgroundLayer) throw new Error("Odrzucono warstwę Background");
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
  var b = layer.bounds;
  var width = Number(b[2]) - Number(b[0]), height = Number(b[3]) - Number(b[1]);
  if (!(width > 0 && height > 0)) throw new Error("Puste granice watermarka");
  layer.resize(Number(doc.width) / width * 100, Number(doc.height) / height * 100, AnchorPosition.MIDDLECENTER);
  layer = findLayer(importedId);
  if (job.mode === "full") {
    b = layer.bounds;
    layer.translate(-Number(b[0]), -Number(b[1]));
  }
  var top = doc.layers[0];
  if (Number(top.id) !== importedId) layer.move(top, ElementPlacement.PLACEBEFORE);
  if (Number(doc.layers[0].id) !== importedId) throw new Error("Nie udało się przenieść WATERMARK na samą górę");
  doc.activeLayer = findLayer(importedId);
  doc.activeLayer.name = job.mode === "full" ? "WATERMARK NA CAŁOŚĆ" : "WATERMARK";
  doc.activeLayer.opacity = job.opacity;
  if (job.mode === "full") doc.activeLayer.blendMode = BlendMode.OVERLAY;
  // Photopea quantizes opacity to 8 bits, e.g. 70% reads back as 70.196%.
  if (Number(doc.activeLayer.id) !== importedId ||
      Math.abs(Number(doc.activeLayer.opacity) - job.opacity) > 100 / 255 ||
      job.mode === "full" && String(doc.activeLayer.blendMode) !== String(BlendMode.OVERLAY))
    throw new Error("Nie udało się potwierdzić ustawień watermarka");
}
function finishWatermark() {
  watermarkStage = 'finishing';
  postScript(applyWatermark.toString() + ';try{applyWatermark(app.activeDocument,' +
    JSON.stringify(watermarkState) + ',' + JSON.stringify(watermarkJob) +
    ');app.echoToOE("KTX_OK|Watermark gotowy")}catch(e){app.echoToOE("KTX_ERR|WATERMARK|"+String(e))}');
}
updateNoiseUI();
window.addEventListener('message',function(e){if(e.data==='done'){if(vignetteStage==='loading'){finishVignette();return}if(vignetteStage==='finishing'){vignetteStage='idle';setStatus('Winieta gotowa','');return}if(watermarkStage==='capturing'){watermarkGotPrepDone=true;maybeOpenWatermark();return}if(watermarkStage==='opening'){finishWatermark();return}if(watermarkStage==='finishing'||watermarkStage!=='idle')return;if(window.folderizeBusy)return;setStatus('Gotowe','');return}if(typeof e.data!=='string')return;if(e.data.indexOf('KTX_WM_STATE|')===0&&watermarkStage==='capturing'){try{watermarkState=JSON.parse(e.data.substring(13));watermarkGotState=true;maybeOpenWatermark()}catch(err){watermarkStage='idle';setStatus('Błąd — odczyt projektu','err')}return}if(e.data.indexOf('KTX_OK|')===0){if(e.data.indexOf('Winieta gotowa')>0)vignetteStage='idle';if(e.data.indexOf('Watermark gotowy')>0)watermarkStage='idle';setStatus(e.data.substring(7),'');return}if(e.data.indexOf('KTX_ERR|')===0){vignetteStage='idle';watermarkStage='idle';setStatus('Błąd — '+e.data.substring(8),'err')}});