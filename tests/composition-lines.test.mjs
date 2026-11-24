import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import lines from '../composition-lines.js';

const cases=[
  [1920,1080,[959,539],[639,1279,359,719]],
  [1280,720,[639,359],[426,852,239,479]],
  [3840,2160,[1919,1079],[1279,2559,719,1439]],
  [1080,1080,[539,539],[359,719,359,719]],
  [1080,1920,[539,959],[359,719,639,1279]],
  [1001,703,[500,351],[333,666,233,468]]
];
for(const [width,height,cross,grid] of cases) for(const mode of ['cross','grid']) {
  test(`${mode} geometry uses exactly 2px full-length lines at ${width}×${height}`,()=>{
    const expected=mode==='cross'?[[cross[0],0,cross[0]+2,height],[0,cross[1],width,cross[1]+2]]:
      [[grid[0],0,grid[0]+2,height],[grid[1],0,grid[1]+2,height],[0,grid[2],width,grid[2]+2],[0,grid[3],width,grid[3]+2]];
    assert.deepEqual(lines.geometry(width,height,mode),expected);
  });
}

function model({noDocument=false, refuseLock=false, refuseOpacity=false, failDraw=false}={}) {
  let nextId=10;
  const app={documents:[],activeDocument:null};
  class Layer {
    constructor(doc,name,kind=0) {this.doc=doc;this.parent=doc;this.name=name;this.id=++nextId;
      this.kind=kind;this.typename='ArtLayer';this.visible=true;this.opacity=100;this.blendMode='norm';this.allLocked=false;this.rectangles=[];}
    move(relative,placement) {
      assert.equal(placement,'before');this.removeFromParent();
      this.parent=relative.parent;this.parent.layers.splice(this.parent.layers.indexOf(relative),0,this);
    }
    removeFromParent(){this.parent.layers.splice(this.parent.layers.indexOf(this),1);}
    remove(){if(this.allLocked)throw Error('Layer locked');this.removeFromParent();}
  }
  function document(width,height,name) {
    const doc={width,height,name,layers:[],activeLayer:null,selection:{sentinel:true},
      get guides(){throw Error('Native guides must not be used');},
      saveToOE(){throw Error('Adding lines must not export PSD or PNG');},
      close(){app.documents.splice(app.documents.indexOf(doc),1);app.activeDocument=app.documents.at(-1);}};
    doc.artLayers={add(){const layer=new Layer(doc,'New');
      layer.parent=doc.activeLayer?.typename==='LayerSet'?doc.activeLayer:doc.activeLayer?.parent||doc;
      layer.parent.layers.unshift(layer);doc.activeLayer=layer;
      if(app.running&&refuseLock)Object.defineProperty(layer,'allLocked',{get:()=>false,set:()=>{}});
      if(app.running&&refuseOpacity)Object.defineProperty(layer,'opacity',{get:()=>100,set:()=>{}});
      return layer;}};
    const background=doc.artLayers.add();background.name='Background';background.isBackgroundLayer=true;
    app.documents.push(doc);app.activeDocument=doc;return doc;
  }
  app.documents.add=()=>{throw Error('Lines must not create extra documents');};
  const doc=document(1280,720,'User');
  doc.selection={select(points){doc.selected=points;},fill(color){if(failDraw)throw Error('Draw failed');
    doc.activeLayer.rectangles.push([doc.selected[0][0],doc.selected[0][1],doc.selected[2][0],doc.selected[2][1]]);
    doc.activeLayer.color=color.rgb.hexValue;},deselect(){doc.selected=null;}};
  const group=new Layer(doc,'LINIE POMOCNICZE — KRZYŻ');group.typename='LayerSet';group.layers=[];doc.layers.unshift(group);
  const pixel=new Layer(doc,'Moje LINIE POMOCNICZE');pixel.parent=group;group.layers.push(pixel);doc.activeLayer=pixel;
  const text=new Layer(doc,lines.style.names.grid,2);doc.layers.push(text);
  const smart=new Layer(doc,lines.style.names.cross,1);doc.layers.push(smart);
  if(noDocument)app.documents.length=0;
  function walk(layers,out=[]){for(const layer of layers){out.push(layer);if(layer.layers)walk(layer.layers,out);}return out;}
  function execute(mode) {
    app.running=true;
    let result;app.echoToOE=value=>{result=JSON.parse(value.slice('RESULT|'.length));};
    vm.runInNewContext(lines.buildScript('RESULT|',mode,'offline-token'),{
      app,LayerKind:{NORMAL:0},BlendMode:{NORMAL:'norm'},ElementPlacement:{PLACEBEFORE:'before',PLACEATBEGINNING:'beginning'},
      SaveOptions:{DONOTSAVECHANGES:0},SolidColor:class {rgb={};}
    });
    return result;
  }
  return {app,doc,group,pixel,text,smart,execute,walk,owned:()=>walk(doc.layers).filter(layer=>layer.typename==='ArtLayer'&&layer.kind===0&&Object.values(lines.style.names).includes(layer.name))};
}

for(const mode of ['cross','grid']) test(`${mode} creates a locked normal pixel layer at the document root and preserves user layers and active layer`,()=>{
  const m=model(), selection=m.doc.selection, original=m.doc.activeLayer;
  const result=m.execute(mode);assert.equal(result.error,undefined);
  const [layer]=m.owned();assert.equal(m.owned().length,1);assert.equal(layer.id,result.id);
  assert.equal(layer.parent,m.doc);assert.equal(m.doc.layers[0],layer);assert.equal(layer.kind,0);
  assert.equal(layer.name,lines.style.names[mode]);assert.equal(layer.opacity,35);assert.equal(layer.allLocked,true);
  assert.equal(layer.blendMode,'norm');assert.deepEqual(layer.rectangles,lines.geometry(1280,720,mode));
  assert.equal(m.app.documents.length,1);assert.equal(m.app.activeDocument,m.doc);assert.equal(m.doc.activeLayer,original);
  assert.equal(m.doc.selection,selection);assert.ok(m.walk(m.doc.layers).includes(m.pixel));
  assert.ok(m.doc.layers.includes(m.text));assert.ok(m.doc.layers.includes(m.smart));assert.ok(m.doc.layers.includes(m.group));
});

test('all replacement transitions preserve one helper even when it was hidden, unlocked and moved into a group',()=>{
  const m=model();
  for(const mode of ['cross','cross','grid','cross','grid','grid']){
    const old=m.owned()[0];
    if(old){old.allLocked=false;old.visible=false;old.removeFromParent();old.parent=m.group;m.group.layers.push(old);}
    const result=m.execute(mode);assert.equal(result.error,undefined,JSON.stringify(result));
    assert.equal(m.owned().length,1);assert.equal(m.owned()[0].name,lines.style.names[mode]);
    if(old)assert.ok(!m.walk(m.doc.layers).includes(old));
  }
});

test('missing document and invalid mode create no layers',()=>{
  const empty=model({noDocument:true});assert.equal(empty.execute('cross').error,'NO_DOCUMENT');
  const m=model(), count=m.walk(m.doc.layers).length;
  assert.equal(m.execute('unknown').error,'INVALID_MODE');assert.equal(m.walk(m.doc.layers).length,count);
});

for(const option of ['refuseLock','refuseOpacity','failDraw']) test(`native ${option} fails safely and keeps the previous helper`,()=>{
  const m=model({[option]:true});
  const previous={id:999,name:lines.style.names.cross,kind:0,typename:'ArtLayer',allLocked:true,isBackgroundLayer:false,parent:m.doc,
    remove(){throw Error('Must preserve old helper until the replacement is ready');}};
  m.doc.layers.unshift(previous);
  const result=m.execute('grid');assert.equal(result.error,'PHOTOPEA_ERROR');
  assert.deepEqual(m.owned(),[previous]);assert.equal(previous.allLocked,true);assert.equal(m.app.documents.length,1);
});

test('line controls are idle on startup, prevent duplicate operations and leave other tools enabled',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.KTX_TEST_BROWSER||undefined});
  try {
    const page=await browser.newPage();
    const html=await readFile(new URL('../plugin.html',import.meta.url),'utf8');
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace(/<img\b[^>]*>/g,''));
    await page.evaluate(()=>{window.calls=[];window.ktxCompositionLines={add(mode){calls.push(mode);return new Promise(resolve=>{window.finishLines=resolve;});}};});
    await page.addScriptTag({content:await readFile(new URL('../composition-lines-ui.js',import.meta.url),'utf8')});
    assert.deepEqual(await page.evaluate(()=>calls),[]);
    assert.equal(await page.locator('#compositionLines button').count(),3);
    assert.equal(await page.locator('#compositionLines input, #compositionLines select').count(),0);
    await page.locator('#compositionLinesGrid').click();
    await page.locator('#compositionLinesAdd').evaluate(button=>{button.click();button.click();});
    assert.deepEqual(await page.evaluate(()=>calls),['grid']);
    assert.equal(await page.locator('#rasterizeScan').isEnabled(),true);assert.equal(await page.locator('#layerCleanerScan').isEnabled(),true);
    await page.evaluate(()=>finishLines({id:1}));
    await page.locator('#compositionLinesStatus').getByText('Dodano SIATKĘ.',{exact:true}).waitFor();
    assert.equal(await page.locator('#compositionLinesAdd').isEnabled(),true);
    await page.evaluate(()=>{ktxCompositionLines.add=()=>Promise.reject(new Error('Otwórz dokument w Photopea, aby dodać linie.'));});
    await page.locator('#compositionLinesAdd').click();
    await page.locator('#compositionLinesStatus').getByText('Otwórz dokument w Photopea, aby dodać linie.',{exact:true}).waitFor();
    assert.equal(await page.locator('#compositionLinesAdd').isEnabled(),true);
    assert.equal(await page.locator('#rasterizeScan').isEnabled(),true);
  }finally{await browser.close();}
});
