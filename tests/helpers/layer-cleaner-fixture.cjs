// Minimal PSD records for parser tests. Channel payloads are not image fixtures.
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const tag = (name, data) => Buffer.concat([Buffer.from('8BIM'+name),u32(data.length),data,Buffer.alloc(data.length%2)]);
function psdFixture(layers) {
  const records = [], channels = [];
  for (const layer of layers) {
    const rect = layer.rect || [0,0,0,0], ch = layer.channels || [{id:0,length:2}];
    const name = Buffer.from('Layer'), nameField = Buffer.concat([Buffer.from([name.length]),name,Buffer.alloc((4-(name.length+1)%4)%4)]);
    const extras = Buffer.concat([u32(layer.mask ? 20 : 0),Buffer.alloc(layer.mask ? 20 : 0),u32(0),nameField,
      tag('lyid',u32(layer.id)), ...(layer.tags || []).map(([name,data])=>tag(name,data))]);
    records.push(Buffer.concat([...rect.map(i32),u16(ch.length),...ch.map(c=>Buffer.concat([u16(c.id & 65535),u32(c.length)])),
      Buffer.from('8BIMnorm'),Buffer.from([layer.opacity??255,layer.clipping||0,layer.flags||0,0]),u32(extras.length),extras]));
    for (const c of ch) channels.push(Buffer.alloc(c.length));
  }
  const info = Buffer.concat([u16(layers.length),...records,...channels]);
  const section = Buffer.concat([u32(info.length),info,u32(0)]);
  const b = Buffer.concat([Buffer.from('8BPS'),u16(1),Buffer.alloc(6),u16(3),u32(32),u32(32),u16(8),u16(3),u32(0),u32(0),u32(section.length),section]);
  return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
}
function neutralMetadata(id, change = () => {}) {
  const key = value => Buffer.concat([u32(value.length),Buffer.from(value)]);
  function descriptor(fields) {
    return Buffer.concat([u32(0),key('null'),u32(Object.keys(fields).length),
      ...Object.entries(fields).flatMap(([name,data])=>[key(name),encode(data)])]);
  }
  function encode(value) {
    if(typeof value==='boolean')return Buffer.concat([Buffer.from('bool'),Buffer.from([Number(value)])]);
    if(typeof value==='number')return Buffer.concat([Buffer.from('long'),i32(value)]);
    if(Array.isArray(value))return Buffer.concat([Buffer.from('VlLs'),u32(value.length),...value.map(encode)]);
    if(value.unit){const b=Buffer.alloc(8);b.writeDoubleBE(value.value);return Buffer.concat([Buffer.from('UntF'+value.unit),b]);}
    if(value.enum)return Buffer.concat([Buffer.from('enum'),key(value.enum),key(value.value)]);
    return Buffer.concat([Buffer.from('Objc'),descriptor(value)]);
  }
  const fields={LyrI:id,layerSettings:[{compList:[0],enab:true,Ofst:{Hrzn:0,Vrtc:0},FXRefPoint:{Hrzn:0,Vrtc:0},
    blendOptions:{'Md  ':{enum:'BlnM',value:'Nrml'},Opct:{unit:'#Prc',value:100},fillOpacity:{unit:'#Prc',value:100}}}]};
  change(fields);
  const body=Buffer.concat([u32(16),descriptor(fields)]);
  return Buffer.concat([u32(1),Buffer.from('8BIMcmls'),u32(0),u32(body.length),body]);
}
module.exports={psdFixture,neutralMetadata};
