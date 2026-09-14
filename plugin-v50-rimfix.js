function runRimLight(){
  setStatus('Tworzę RIM LIGHT...','busy');
  postScript('('+ktxCreateRimLightV50.toString()+')(2);');
}

function ktxCreateRimLightV50(thickness){
  var doc=null,source=null,rim=null,marker=null,oldUnits=null,markerVisible=null;
  var stage='start';

  function px(v){
    var n=null;
    try{n=v.as('px')}catch(e){}
    if(n==null||n!==n){try{n=v.value}catch(e2){}}
    if(n==null||n!==n)n=Number(v);
    return (typeof n==='number'&&isFinite(n))?n:NaN;
  }
  function box(item,keepSelection){
    if(!keepSelection){try{doc.selection.deselect()}catch(e){}}
    var b=item.bounds,a=[px(b[0]),px(b[1]),px(b[2]),px(b[3])];
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
    var c=new SolidColor();c.rgb.red=255;c.rgb.green=255;c.rgb.blue=255;return c;
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
  function expandSelection(n){
    try{doc.selection.expand(n);return true}catch(e){}
    try{
      var d=new ActionDescriptor();
      d.putUnitDouble(charIDToTypeID('By  '),charIDToTypeID('#Pxl'),n);
      executeAction(charIDToTypeID('Expn'),d,DialogModes.NO);
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
  function createOutline(){
    if(!loadAlpha(source))return false;
    makeRim();
    doc.activeLayer=rim;
    var c=white(),ok=false;
    try{
      doc.selection.stroke(c,thickness,StrokeLocation.OUTSIDE,ColorBlendMode.NORMAL,100,false);
      ok=true;
    }catch(e){
      try{doc.selection.stroke(c,thickness);ok=true}catch(e2){ok=false}
    }
    if(ok){
      try{
        loadAlpha(source);doc.activeLayer=rim;doc.selection.clear();doc.selection.deselect();
      }catch(e3){}
      if(box(rim))return true;
    }

    makeRim();
    if(!loadAlpha(source))return false;
    if(!expandSelection(thickness))return false;
    doc.activeLayer=rim;
    try{doc.selection.fill(c)}catch(e4){return false}
    if(!loadAlpha(source))return false;
    doc.activeLayer=rim;
    try{doc.selection.clear();doc.selection.deselect()}catch(e5){return false}
    return !!box(rim);
  }
  function keepLightSide(sb,vx,vy){
    var cx=(sb[0]+sb[2])/2,cy=(sb[1]+sb[3])/2;
    var len=Math.sqrt(vx*vx+vy*vy);
    if(len<0.01)return false;
    var lx=vx/len,ly=vy/len,pxv=-ly,pyv=lx;
    var extra=Math.min(sb[2]-sb[0],sb[3]-sb[1])*0.12;
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
      var dw=px(doc.width),dh=px(doc.height),left=0,top=0,right=dw,bottom=dh;
      if(Math.abs(vx)>=Math.abs(vy)){if(vx>=0)right=cx;else left=cx}
      else{if(vy>=0)bottom=cy;else top=cy}
      try{doc.selection.select([[left,top],[right,top],[right,bottom],[left,bottom]])}catch(e2){return false}
    }
    try{doc.selection.clear();doc.selection.deselect()}catch(e3){return false}
    return !!box(rim);
  }
  function strengthen(){
    try{
      if(!loadAlpha(rim))return;
      doc.activeLayer=rim;
      var c=white();
      for(var i=0;i<10;i++){
        try{doc.selection.fill(c,ColorBlendMode.NORMAL,100,false)}catch(e){try{doc.selection.fill(c)}catch(e2){break}}
      }
      doc.selection.deselect();
    }catch(e3){try{doc.selection.deselect()}catch(e4){}}
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

    stage='alpha selection failed';
    var sb=loadAlpha(source);
    if(!sb)return 'Warstwa renderu nie ma widocznych pikseli';
    var mb=box(marker);
    if(!mb)return 'Znacznik źródła światła jest pusty';
    var vx=(mb[0]+mb[2])/2-(sb[0]+sb[2])/2;
    var vy=(mb[1]+mb[3])/2-(sb[1]+sb[3])/2;
    if(Math.sqrt(vx*vx+vy*vy)<0.01)return 'Przesuń źródło światła poza środek renderu';
    markerVisible=marker.visible;

    stage='outline creation failed';
    if(!createOutline())return 'Nie udało się utworzyć obrysu';

    stage='directional filtering failed';
    if(!keepLightSide(sb,vx,vy))return 'Nie udało się zostawić strony źródła światła';
    if(!box(rim))return 'Po filtrze kierunku nie zostało pikseli';

    strengthen();

    stage='layer placement failed';
    try{rim.move(source,ElementPlacement.PLACEBEFORE)}catch(e){return 'Nie udało się położyć RIM LIGHT nad renderem'}
    if(!aboveSource())return 'Warstwa nie trafiła bezpośrednio nad render';
    rim.name='RIM LIGHT';rim.opacity=100;rim.blendMode=BlendMode.NORMAL;
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
    app.echoToOE('KTX_OK|RIM LIGHT gotowy • 2 px • wzmocniona biel • nad renderem');
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
