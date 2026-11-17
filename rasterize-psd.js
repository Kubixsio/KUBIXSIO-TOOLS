(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ktxRasterizePsd = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  const maxBytes = 128 * 1024 * 1024;
  const placedTags = new Set(['SoLd', 'SoLE']);
  const layerTags = new Set([
    'lyid', 'luni', 'lnsr', 'lsct', 'lsdk', 'lclr', 'fxrp', 'shmd', 'lspf', 'knko',
    'clbl', 'infx', 'tsly', 'lmgm', 'vmgm', 'lyvr', 'brst', 'iOpa', 'lfx2', 'lrFX',
    'lmfx', 'lfxs', 'vmsk', 'vsms', 'PlLd', 'plLd', 'SoLd', 'SoLE'
  ]);
  const placedKeys = new Set([
    'Idnt', 'placed', 'PgNm', 'totalPages', 'Crop', 'frameStep', 'duration',
    'frameCount', 'Annt', 'Type', 'Trnf', 'nonAffineTransform', 'warp', 'quiltWarp',
    'Sz  ', 'Rslt', 'comp', 'compInfo', 'Impr'
  ]);
  const filterTags = new Set(['FXid', 'FEid', 'FELS']);
  const alternateLayerTags = new Set(['Layr', 'Lr16', 'Lr32']);

  // Read layer records and descriptors of the PSD exported by Photopea. Pixel data
  // is kept encoded. Unknown placed formats and metadata never count as filter-free.
  function readLayers(buffer) {
    if (buffer.byteLength > maxBytes) throw new Error('PSD_TOO_LARGE');
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    let position = 0, end = bytes.length;
    function take(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > end - position) throw new Error('INVALID_PSD');
      const start = position;
      position += length;
      return start;
    }
    const u8 = () => view.getUint8(take(1));
    const u16 = () => view.getUint16(take(2));
    const i16 = () => view.getInt16(take(2));
    const u32 = () => view.getUint32(take(4));
    const text = n => String.fromCharCode(...bytes.subarray(take(n), position));
    const tagData = n => bytes.subarray(take(n), position);
    function unicode(read = false) {
      const count = u32(), at = take(count * 2);
      if (!read) return;
      if (!count || count > 256) throw new Error('INVALID_PLACED_ID');
      let value = '';
      for (let i = 0; i < count; i++) value += String.fromCharCode(view.getUint16(at + i * 2));
      return value.replace(/\0$/, '');
    }
    function key() {
      const n = u32() || 4;
      if (n > 256) throw new Error('UNSUPPORTED_KEY');
      return text(n);
    }

    function readPlaced(data) {
      const oldPosition = position, oldEnd = end;
      position = data.byteOffset - bytes.byteOffset;
      end = position + data.byteLength;
      let budget = 50000, placedId = null, sourceId = null, filterFree = true;
      function value(type, depth) {
        if (--budget < 0 || depth > 20) throw new Error('DESCRIPTOR_LIMIT');
        switch (type) {
          case 'Objc': case 'GlbO': return descriptor(depth + 1);
          case 'VlLs': {
            const length = u32();
            if (length > budget) throw new Error('DESCRIPTOR_LIMIT');
            for (let i = 0; i < length; i++) value(text(4), depth + 1);
            return;
          }
          case 'TEXT': return unicode();
          case 'enum': key(); return key();
          case 'long': return take(4);
          case 'doub': case 'comp': return take(8);
          case 'UntF': return take(12);
          case 'UnFl': return take(8);
          case 'bool': return take(1);
          case 'tdta': case 'alis': return take(u32());
          case 'ObAr': {
            if (u32() !== 16) throw new Error('UNSUPPORTED_OBJECT_ARRAY');
            unicode();
            if (!['rationalPoint', 'UntF'].includes(key())) throw new Error('UNSUPPORTED_OBJECT_ARRAY');
            const columns = u32();
            if (columns > 8) throw new Error('UNSUPPORTED_OBJECT_ARRAY');
            for (let i = 0; i < columns; i++) {
              if (!['Hrzn', 'Vrtc', 'slice'].includes(key()) || text(4) !== 'UnFl') throw new Error('UNSUPPORTED_OBJECT_ARRAY');
              take(4); // Units
              const count = u32();
              budget -= count;
              if (budget < 0) throw new Error('DESCRIPTOR_LIMIT');
              take(count * 8);
            }
            return;
          }
          default: throw new Error('UNSUPPORTED_DESCRIPTOR');
        }
      }
      function descriptor(depth, top = false) {
        unicode();
        key();
        const count = u32(), seen = new Set();
        if (count > budget) throw new Error('DESCRIPTOR_LIMIT');
        for (let i = 0; i < count; i++) {
          const name = key();
          if (seen.has(name)) throw new Error('DUPLICATE_DESCRIPTOR_KEY');
          if (/filter|^Fltr$/i.test(name) || top && !placedKeys.has(name)) filterFree = false;
          seen.add(name);
          const type = text(4);
          if (top && name === 'placed' && type === 'TEXT') placedId = unicode(true);
          else if (top && name === 'Idnt' && type === 'TEXT') sourceId = unicode(true);
          else value(type, depth);
        }
        return seen.has('Idnt') && seen.has('Type') && seen.has('Trnf');
      }
      try {
        if (text(4) !== 'soLD') return {};
        const version = u32();
        if ((version !== 4 && version !== 5) || u32() !== 16 || !descriptor(0, true)) return {};
        if (end - position > 3) return {};
        while (position < end) if (u8() !== 0) return {};
        return {placedId, sourceId, filterFree: !!placedId && !!sourceId && filterFree};
      } catch (_) {
        return {placedId, filterFree: false};
      } finally {
        position = oldPosition;
        end = oldEnd;
      }
    }

    if (text(4) !== '8BPS' || u16() !== 1) throw new Error('UNSUPPORTED_PSD');
    take(20);
    take(u32()); // Color mode data
    take(u32()); // Image resources
    const sectionLength = u32(), sectionEnd = position + sectionLength;
    if (sectionLength < 4 || sectionEnd > end) throw new Error('INVALID_PSD');
    const layerLength = u32(), layerEnd = position + layerLength;
    if (layerLength < 2 || layerEnd > sectionEnd) throw new Error('INVALID_PSD');
    end = layerEnd;
    const count = Math.abs(i16()), layers = new Map(), records = [];
    if (count > 6000) throw new Error('LAYER_LIMIT');
    let ambiguousFilters = false;
    const filterIds = new Set();
    for (let i = 0; i < count; i++) {
      take(16); // Layer rectangle
      const channelCount = u16(), channels = [];
      if (channelCount > 56) throw new Error('INVALID_PSD');
      for (let c = 0; c < channelCount; c++) channels.push({id: i16(), length: u32()});
      if (text(4) !== '8BIM') throw new Error('INVALID_PSD');
      const blend = text(4), opacity = u8(), clipping = u8(), flags = u8();
      take(1);
      const extraLength = u32(), extraEnd = position + extraLength;
      if (extraEnd > end) throw new Error('INVALID_PSD');
      end = extraEnd;
      const mask = tagData(u32()), blendingRanges = tagData(u32());
      const nameLength = u8();
      take(nameLength + (4 - (nameLength + 1) % 4) % 4);
      const tags = new Map();
      while (position < end) {
        if (text(4) !== '8BIM') throw new Error('INVALID_PSD');
        const tag = text(4), length = u32(), data = tagData(length);
        take(length % 2);
        if (tags.has(tag)) throw new Error('DUPLICATE_LAYER_TAG');
        tags.set(tag, data);
      }
      const idData = tags.get('lyid');
      const id = idData?.length === 4 ? new DataView(idData.buffer, idData.byteOffset, 4).getUint32(0) : null;
      const placed = [...tags.keys()].filter(tag => placedTags.has(tag));
      const info = placed.length === 1 ? readPlaced(tags.get(placed[0])) : {};
      const filterFree = info.filterFree === true && !(flags & 32) && channels.every(channel => channel.id >= -3) &&
        [...tags.keys()].every(tag => layerTags.has(tag));
      const record = {id, blend, opacity, clipping, flags, mask, blendingRanges, channels, tags,
        placedId: info.placedId, sourceId: info.sourceId, filterFree};
      if (id !== null) {
        if (layers.has(id)) throw new Error('DUPLICATE_LAYER_ID');
        layers.set(id, record);
      }
      records.push(record);
      end = layerEnd;
    }
    for (const record of records) {
      for (const channel of record.channels) channel.bytes = tagData(channel.length);
    }
    if (layerEnd - position > 3) throw new Error('INVALID_LAYER_SECTION');
    position = layerEnd;
    end = sectionEnd;
    if (position < end) take(u32()); // Global mask record
    while (position < end) {
      if (end - position <= 3) {
        while (position < end) if (u8() !== 0) throw new Error('INVALID_PSD');
        break;
      }
      if (text(4) !== '8BIM') throw new Error('INVALID_PSD');
      const tag = text(4), length = u32();
      if (alternateLayerTags.has(tag) || tag === 'FMsk') ambiguousFilters = true;
      if (filterTags.has(tag)) {
        const outerEnd = end, blockEnd = position + length;
        if (blockEnd > end) throw new Error('INVALID_FILTER_BLOCK');
        end = blockEnd;
        const version = u32();
        if (version < 1 || version > 3) throw new Error('UNSUPPORTED_FILTER_BLOCK');
        while (position < end) {
          if (u32() !== 0) throw new Error('UNSUPPORTED_FILTER_BLOCK');
          const size = u32(), start = position;
          if (size < 2 || size > end - start) throw new Error('INVALID_FILTER_BLOCK');
          const idLength = u8();
          if (!idLength || idLength >= size) throw new Error('INVALID_FILTER_ID');
          filterIds.add(text(idLength).replace(/^\$/, ''));
          take(size - (position - start) + (4 - size % 4) % 4);
        }
        end = outerEnd;
      } else take(length);
      take((4 - length % 4) % 4);
    }
    for (const id of filterIds) if (!records.some(layer => layer.placedId === id)) ambiguousFilters = true;
    for (const layer of layers.values()) {
      if (ambiguousFilters || filterIds.has(layer.placedId)) layer.filterFree = false;
    }
    return layers;
  }

  return Object.freeze({maxBytes, readLayers});
});
