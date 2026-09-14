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

// Serialized into Photopea. Keep ES5, no throw (Photopea can abort the whole script).
function ktxCreateRimLight(thickness){
  var doc=null,source=null,rim=null,oldUnits=null,marker=null,markerVisible=null;
  var stage='alpha selection failed';
  function px(v){
    var n=null;
    try{n=v.value}catch(e){}
    if(n==null||n!==n){try{n=v.as('px')}catch(e2){}}
    if(n==null||n!==n)n=Number(v);
    if(typeof n!=='number'||!isFinite(n))return NaN;
    return n;
  }
  function box(item,keepSelection){
    if(!keepSelection)doc.selection.deselect();
    var b=item.bounds;
    var a=[px(b[0]),px(b[1]),px(b[2]),px(b[3])];
    for(var i=0;i<4;i++)if(!isFinite(a[i]))return null;
    if(a[2]<=a[0]||a[3]<=a[1])return null;
    return a;
  }
  function area(a){return a?(a[2]-a[0])*(a[3]-a[1]):0}
  function sameLayer(a,b){
    if(a===b)return true;
    return a&&b&&a.id!=null&&b.id!=null&&a.id===b.id;
  }
  function findNamed(layers,name){
    for(var i=0;i<layers.length;i++){
      var layer=layers[i];
      if(layer&&layer.name===name)return layer;
      if(layer&&layer.typename==='LayerSet'){
        var found=findNamed(layer.layers,name);
        if(found)return found;
      }
    }
    return null;
  }
  function white(){
    var c=new SolidColor();
    c.rgb.red=255;c.rgb.green=255;c.rgb.blue=255;
    return c;
  }
  function loadAlpha(layer){
    doc.selection.deselect();
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
  function expandSel(pxCount){
    try{doc.selection.expand(pxCount);return true}catch(e){}
    try{
      var d=new ActionDescriptor();
      d.putUnitDouble(charIDToTypeID('By  '),charIDToTypeID('#Pxl'),pxCount);
      executeAction(charIDToTypeID('Expn'),d,DialogModes.NO);
      return true;
    }catch(e2){return false}
  }
  function contractSel(pxCount){
    try{doc.selection.contract(pxCount);return true}catch(e){}
    try{
      var d=new ActionDescriptor();
      d.putUnitDouble(charIDToTypeID('By  '),charIDToTypeID('#Pxl'),pxCount);
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
    doc.activeLayer=rim;
  }
  function subtractSource(sb){
    if(!loadAlpha(source))return false;
    doc.activeLayer=rim;
    try{doc.selection.clear()}catch(e){return false}
    doc.selection.deselect();
    return ringLooksValid(sb,true);
  }
  function ringLooksValid(sb,requireOutward){
    var rb=box(rim);
    if(!rb)return false;
    var dw=px(doc.width),dh=px(doc.height);
    if(area(rb)>dw*dh*0.85&&area(sb)<dw*dh*0.7)return false;
    var pad=thickness+6;
    if(rb[0]<sb[0]-pad||rb[1]<sb[1]-pad||rb[2]>sb[2]+pad||rb[3]>sb[3]+pad){
      if(area(rb)>area(sb)*3)return false;
    }
    if(requireOutward){
      var grew=(sb[0]-rb[0])+(sb[1]-rb[1])+(rb[2]-sb[2])+(rb[3]-sb[3]);
      if(grew<0.5)return false;
    }
    if(!loadAlpha(rim))return false;
    var before=box(doc.selection,true);
    if(!before){doc.selection.deselect();return false}
    if(contractSel(Math.max(1,thickness))){
      var inner=box(doc.selection,true);
      doc.selection.deselect();
      if(inner&&area(inner)>area(before)*0.45)return false;
    }else{
      doc.selection.deselect();
    }
    return !!box(rim);
  }
  function outlineStroke(sb){
    if(!loadAlpha(source))return false;
    makeRim();
    doc.activeLayer=rim;
    var ok=false;
    try{
      doc.selection.stroke(white(),thickness,StrokeLocation.OUTSIDE,ColorBlendMode.NORMAL,100,false);
      ok=true;
    }catch(e){
      try{doc.selection.stroke(white(),thickness);ok=true}catch(e2){ok=false}
    }
    if(!ok)return false;
    return subtractSource(sb);
  }
  function outlineExpand(sb){
    if(!loadAlpha(source))return false;
    makeRim();
    doc.activeLayer=rim;
    if(!expandSel(thickness))return false;
    try{doc.selection.fill(white())}catch(e){return false}
    return subtractSource(sb);
  }
  function keepLightSide(sb,vx,vy){
    var cx=(sb[0]+sb[2])/2,cy=(sb[1]+sb[3])/2;
    var len=Math.sqrt(vx*vx+vy*vy);
    var lx=vx/len,ly=vy/len;
    var pxv=-ly,pyv=lx;
    var extra=Math.min(sb[2]-sb[0],sb[3]-sb[1])*0.12;
    cx=cx-lx*extra;cy=cy-ly*extra;
    var big=Math.max(px(doc.width),px(doc.height))*4;
    var x1=cx+pxv*big,y1=cy+pyv*big;
    var x2=cx-pxv*big,y2=cy-pyv*big;
    var x3=x2-lx*big,y3=y2-ly*big;
    var x4=x1-lx*big,y4=y1-ly*big;
    doc.selection.deselect();
    doc.activeLayer=rim;
    try{
      doc.selection.select([[x1,y1],[x2,y2],[x3,y3],[x4,y4]]);
    }catch(e){
      var mx=cx,my=cy;
      var left=Math.max(0,sb[0]-thickness-2),top=Math.max(0,sb[1]-thickness-2);
      var right=Math.min(px(doc.width),sb[2]+thickness+2),bottom=Math.min(px(doc.height),sb[3]+thickness+2);
      if(Math.abs(vx)>=Math.abs(vy)){
        if(vx>=0)right=mx;else left=mx;
      }else{
        if(vy>=0)bottom=my;else top=my;
      }
      doc.selection.select([[left,top],[right,top],[right,bottom],[left,bottom]]);
    }
    try{doc.selection.clear()}catch(e2){return false}
    doc.selection.deselect();
    return !!box(rim);
  }
  function aboveSource(){
    if(!sameLayer(rim.parent,source.parent))return false;
    var layers=source.parent.layers;
    for(var i=1;i<layers.length;i++){
      if(sameLayer(layers[i],source))return sameLayer(layers[i-1],rim);
    }
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
    if(!source||sameLayer(source,marker)||source.name==='KTX_LIGHT_SOURCE'||source.name==='RIM LIGHT')
      return 'Zaznacz warstwę z renderem';
    if(source.typename==='LayerSet')return 'Zaznacz warstwę renderu, nie grupę';
    var sb=loadAlpha(source);
    if(!sb)return 'Warstwa renderu nie ma widocznych pikseli';
    var mb=box(marker);
    if(!mb)return 'Znacznik źródła światła jest pusty';
    var vx=(mb[0]+mb[2])/2-(sb[0]+sb[2])/2;
    var vy=(mb[1]+mb[3])/2-(sb[1]+sb[3])/2;
    if(Math.sqrt(vx*vx+vy*vy)<0.01)return 'Przesuń źródło światła poza środek renderu';
    markerVisible=marker.visible;

    stage='outline creation failed';
    var outlined=false;
    try{outlined=outlineStroke(sb)}catch(e){outlined=false}
    if(!outlined){
      try{outlined=outlineExpand(sb)}catch(e2){outlined=false}
    }
    if(!outlined)return 'Nie udało się zrobić zewnętrznego obrysu 2 px';

    stage='center subtraction failed';
    if(!ringLooksValid(sb,true))return 'Wynik był pełną sylwetką, nie linią';

    stage='directional filtering failed';
    if(!keepLightSide(sb,vx,vy))return 'Nie udało się zostawić strony źródła światła';
    if(!box(rim))return 'Po filtrze kierunku nie zostało pikseli';
    if(!ringLooksValid(sb,false))return 'Po filtrze kierunku warstwa nie jest cienkim obrysem';

    stage='layer placement failed';
    try{rim.move(source,ElementPlacement.PLACEBEFORE)}catch(e){return 'Nie udało się położyć RIM LIGHT nad renderem'}
    if(!aboveSource())return 'Warstwa nie trafiła bezpośrednio nad render';
    if(rim.kind!==LayerKind.NORMAL)return 'RIM LIGHT nie jest warstwą rastrową';
    try{if(rim.grouped)rim.grouped=false}catch(e){}
    rim.opacity=100;
    rim.blendMode=BlendMode.NORMAL;
    marker.visible=false;
    doc.selection.deselect();
    doc.activeLayer=rim;
    app.preferences.rulerUnits=oldUnits;
    return '';
  }

  var error='';
  try{error=build()}catch(e){error=''+e}
  if(!error){
    app.echoToOE('KTX_OK|RIM LIGHT gotowy • biały obrys '+thickness+' px • nad renderem');
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
