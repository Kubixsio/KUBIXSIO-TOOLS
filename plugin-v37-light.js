const KTX_LIGHT_SOURCE_LAYER='KTX_LIGHT_SOURCE';
const KTX_RIM_THICKNESS=2;

function setLightSource(){
 setStatus('Ustawiam źródło światła...','busy');
 postScript('var doc=null,oldUnits=null;try{doc=app.activeDocument;if(!doc)throw new Error("Brak otwartego dokumentu");function p(v){try{return v.as("px")}catch(e){}try{return v.value}catch(e){}return Number(v)}function find(layers){for(var i=0;i<layers.length;i++){var L=layers[i];if(L&&L.name==="KTX_LIGHT_SOURCE")return L;try{if(L.layers){var f=find(L.layers);if(f)return f}}catch(e){}}return null}function empty(L){try{var b=L.bounds;return (p(b[2])-p(b[0])<=0)||(p(b[3])-p(b[1])<=0)}catch(e){return true}}var marker=find(doc.layers);if(marker&&empty(marker)){try{marker.remove()}catch(x){}marker=null}if(!marker){try{oldUnits=app.preferences.rulerUnits;app.preferences.rulerUnits=Units.PIXELS}catch(x){}marker=doc.artLayers.add();marker.name="KTX_LIGHT_SOURCE";marker.kind=LayerKind.TEXT;var t=marker.textItem;t.contents="+";t.size=32;t.position=[p(doc.width)/2,p(doc.height)/2];var col=new SolidColor();col.rgb.red=255;col.rgb.green=210;col.rgb.blue=0;t.color=col;try{t.justification=Justification.CENTER}catch(x){}if(oldUnits!==null)try{app.preferences.rulerUnits=oldUnits}catch(x){}}marker.visible=true;marker.opacity=100;doc.activeLayer=marker;try{app.currentTool="moveTool"}catch(x){}app.echoToOE("KTX_OK|Źródło światła gotowe — przesuń żółty +, potem zaznacz render")}catch(e){try{if(oldUnits!==null)app.preferences.rulerUnits=oldUnits}catch(x){}app.echoToOE("KTX_ERR|LIGHTSOURCE|"+e.toString())}');
}

function runRimLight(){
  setStatus('Tworzę RIM LIGHT...','busy');
  postScript('('+ktxCreateRimLight.toString()+')('+KTX_RIM_THICKNESS+');');
}

// Serialized into Photopea. Keep ES5 syntax.
function ktxCreateRimLight(thickness){
  var doc=null,source=null,rim=null,oldUnits=null,marker=null,markerVisible=null;
  var stage='alpha selection failed';

  function px(v){
    var n=null;
    try{n=v.as('px')}catch(e){}
    if(n==null||n!==n){try{n=v.value}catch(e2){}}
    if(n==null||n!==n)n=Number(v);
    return (typeof n==='number'&&isFinite(n))?n:NaN;
  }

  function box(item,keepSelection){
    if(!keepSelection)try{doc.selection.deselect()}catch(e){}
    var b=item.bounds;
    var a=[px(b[0]),px(b[1]),px(b[2]),px(b[3])];
    for(var i=0;i<4;i++)if(!isFinite(a[i]))return null;
    if(a[2]<=a[0]||a[3]<=a[1])return null;
    return a;
  }

  function sameLayer(a,b){
    if(a===b)return true;
    return a&&b&&a.id!=null&&b.id!=null&&a.id===b.id;
  }

  function findNamed(layers,name){
    for(var i=0;i<layers.length;i++){
      var L=layers[i];
      if(L&&L.name===name)return L;
      try{if(L&&L.layers){var f=findNamed(L.layers,name);if(f)return f}}catch(e){}
    }
    return null;
  }

  function white(){
    var c=new SolidColor();
    c.rgb.red=255;c.rgb.green=255;c.rgb.blue=255;
    return c;
  }

  function loadAlpha(layer){
    try{doc.selection.deselect()}catch(e){}
    doc.activeLayer=layer;
    var ch=charIDToTypeID('Chnl');
    var sel=new ActionReference(),tr=new ActionReference(),d=new ActionDescriptor();
    sel.putProperty(ch,charIDToTypeID('fsel'));
    tr.putEnumerated(ch,ch,charIDToTypeID('Trsp'));
    d.putReference(charIDToTypeID('null'),sel);
    d.putReference(charIDToTypeID('T   '),tr);
    executeAction(charIDToTypeID('setd'),d,DialogModes.NO);
    return box(doc.selection,true);
  }

  function contractSel(n){
    try{doc.selection.contract(n);return true}catch(e){}
    try{
      var d=new ActionDescriptor();
      d.putUnitDouble(charIDToTypeID('By  '),charIDToTypeID('#Pxl'),n);
      executeAction(charIDToTypeID('Cntc'),d,DialogModes.NO);
      return true;
    }catch(e2){return false}
  }

  function makeRim(){
    if(rim){try{rim.remove()}catch(e){}rim=null}
    rim=doc.artLayers.add();
    rim.name='RIM LIGHT';
    rim.opacity=100;
    rim.blendMode=BlendMode.NORMAL;
    try{rim.grouped=false}catch(e){}
    try{rim.move(source,ElementPlacement.PLACEBEFORE)}catch(e){}
    doc.activeLayer=rim;
  }

  // Build a SOLID inner border: fill the render alpha white, then remove
  // the alpha contracted by N px. Unlike an outside stroke, the remaining
  // pixels sit on top of the render and are not just an antialiased fringe.
  function createSolidInnerOutline(){
    if(!loadAlpha(source))return false;
    makeRim();
    doc.activeLayer=rim;
    try{doc.selection.fill(white(),ColorBlendMode.NORMAL,100,false)}catch(e){
      try{doc.selection.fill(white())}catch(e2){return false}
    }
    if(!loadAlpha(source))return false;
    if(!contractSel(thickness))return false;
    doc.activeLayer=rim;
    try{doc.selection.clear()}catch(e3){return false}
    try{doc.selection.deselect()}catch(e4){}
    return !!box(rim);
  }

  // Clear the half-plane facing away from the light source. This keeps
  // the editable white line only on the light-facing side.
  function keepLightSide(sb,vx,vy){
    var cx=(sb[0]+sb[2])/2,cy=(sb[1]+sb[3])/2;
    var len=Math.sqrt(vx*vx+vy*vy);
    if(len<0.01)return false;
    var lx=vx/len,ly=vy/len;
    var pxv=-ly,pyv=lx;
    var extra=Math.min(sb[2]-sb[0],sb[3]-sb[1])*0.10;
    cx=cx-lx*extra;cy=cy-ly*extra;
    var big=Math.max(px(doc.width),px(doc.height))*4;
    var x1=cx+pxv*big,y1=cy+pyv*big;
    var x2=cx-pxv*big,y2=cy-pyv*big;
    var x3=x2-lx*big,y3=y2-ly*big;
    var x4=x1-lx*big,y4=y1-ly*big;
    try{doc.selection.deselect()}catch(e){}
    doc.activeLayer=rim;
    try{
      doc.selection.select([[x1,y1],[x2,y2],[x3,y3],[x4,y4]]);
    }catch(e1){
      var dw=px(doc.width),dh=px(doc.height);
      var left=0,top=0,right=dw,bottom=dh;
      if(Math.abs(vx)>=Math.abs(vy)){
        if(vx>=0)right=cx;else left=cx;
      }else{
        if(vy>=0)bottom=cy;else top=cy;
      }
      try{doc.selection.select([[left,top],[right,top],[right,bottom],[left,bottom]])}catch(e2){return false}
    }
    try{doc.selection.clear()}catch(e3){return false}
    try{doc.selection.deselect()}catch(e4){}
    return !!box(rim);
  }

  function aboveSource(){
    try{
      if(!sameLayer(rim.parent,source.parent))return false;
      var layers=source.parent.layers;
      for(var i=1;i<layers.length;i++)if(sameLayer(layers[i],source))return sameLayer(layers[i-1],rim);
    }catch(e){}
    return false;
  }

  function build(){
    doc=app.activeDocument;
    if(!doc)return 'Brak otwartego dokumentu';
    source=doc.activeLayer;
    oldUnits=app.preferences.rulerUnits;
    app.preferences.rulerUnits=Units.PIXELS;
    marker=findNamed(doc.layers,'KTX_LIGHT_SOURCE');
    if(!marker)return 'Najpierw kliknij USTAW ŹRÓDŁO ŚWIATŁA';
    if(!source||sameLayer(source,marker)||source.name==='KTX_LIGHT_SOURCE'||source.name==='RIM LIGHT')return 'Zaznacz warstwę z renderem';
    if(source.typename==='LayerSet')return 'Zaznacz warstwę renderu, nie grupę';

    var sb=loadAlpha(source);
    if(!sb)return 'Warstwa renderu nie ma widocznych pikseli';
    var mb=box(marker);
    if(!mb)return 'Znacznik źródła światła jest pusty';
    var vx=(mb[0]+mb[2])/2-(sb[0]+sb[2])/2;
    var vy=(mb[1]+mb[3])/2-(sb[1]+sb[3])/2;
    if(Math.sqrt(vx*vx+vy*vy)<0.01)return 'Przesuń źródło światła poza środek renderu';
    markerVisible=marker.visible;

    stage='solid outline creation failed';
    if(!createSolidInnerOutline())return 'Nie udało się utworzyć pełnej białej linii '+thickness+' px';

    stage='directional filtering failed';
    if(!keepLightSide(sb,vx,vy))return 'Nie udało się zostawić strony źródła światła';
    if(!box(rim))return 'Po filtrze kierunku nie zostało pikseli';

    stage='layer placement failed';
    try{rim.move(source,ElementPlacement.PLACEBEFORE)}catch(e){return 'Nie udało się położyć RIM LIGHT nad renderem'}
    if(!aboveSource())return 'Warstwa nie trafiła bezpośrednio nad render';
    rim.name='RIM LIGHT';
    rim.opacity=100;
    rim.blendMode=BlendMode.NORMAL;
    try{if(rim.grouped)rim.grouped=false}catch(e){}
    marker.visible=false;
    try{doc.selection.deselect()}catch(e){}
    doc.activeLayer=rim;
    app.preferences.rulerUnits=oldUnits;
    return '';
  }

  var error='';
  try{error=build()}catch(e){error=''+e}
  if(!error){
    app.echoToOE('KTX_OK|RIM LIGHT gotowy • pełna biała linia '+thickness+' px • nad renderem');
  }else{
    var cleanup=[];
    try{if(doc)doc.selection.deselect()}catch(x){cleanup.push('odznaczenie: '+x)}
    try{if(rim)rim.remove()}catch(x){cleanup.push('usunięcie RIM LIGHT: '+x)}
    try{if(doc&&source)doc.activeLayer=source}catch(x){cleanup.push('wybór renderu: '+x)}
    try{if(marker&&markerVisible!==null)marker.visible=markerVisible}catch(x){}
    try{if(oldUnits!==null)app.preferences.rulerUnits=oldUnits}catch(x){}
    app.echoToOE('KTX_ERR|RIMLIGHT|'+stage+': '+error+(cleanup.length?' | Sprzątanie: '+cleanup.join('; '):''));
  }
}
