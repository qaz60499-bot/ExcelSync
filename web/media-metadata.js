export function exifDateToIso(value) {
  if (!value) return null
  const match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function parseExif(file) {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  try {
    if (type.includes('heic') || type.includes('heif') || type.includes('avif') || /\.(heic|heif|avif)$/.test(name)) {
      return await parseHeifExif(file)
    }
  } catch {}
  try {
    if (/jpe?g/.test(type) || /\.jpe?g$/.test(name)) return await parseJpegExif(file)
  } catch {}
  return {}
}

async function parseJpegExif(file) {
  const buffer = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer()
  const view = new DataView(buffer)
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {}
  let offset = 2
  while (offset + 4 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1
      continue
    }
    const marker = view.getUint8(offset + 1)
    if (marker === 0xda || marker === 0xd9) break
    const length = view.getUint16(offset + 2)
    if (length < 2) break
    if (marker === 0xe1 && offset + 2 + length <= view.byteLength) {
      if (offset + 10 <= view.byteLength && String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4)) === 'Exif') {
        return parseTiff(view, offset + 10)
      }
    }
    offset += 2 + length
  }
  return {}
}

function isoBox(view, offset) {
  if (offset < 0 || offset + 8 > view.byteLength) return null
  let length = view.getUint32(offset, false)
  let header = 8
  const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7))
  if (length === 1) {
    if (offset + 16 > view.byteLength) return null
    const high = view.getUint32(offset + 8, false)
    const low = view.getUint32(offset + 12, false)
    if (high > 0x1fffff) return null
    length = high * 2 ** 32 + low
    header = 16
  }
  if (length === 0) length = view.byteLength - offset
  if (length < header || offset + length > view.byteLength) return null
  return { type, offset, start: offset + header, end: offset + length, length, header }
}

function findIsoBox(view, start, end, type) {
  let offset = start
  while (offset + 8 <= end && offset + 8 <= view.byteLength) {
    const box = isoBox(view, offset)
    if (!box || box.end > end) return null
    if (box.type === type) return box
    offset = box.end
  }
  return null
}

function readSized(view, offset, size) {
  if (size === 0) return 0
  if (size < 0 || size > 8 || offset + size > view.byteLength) return null
  let value = 0
  for (let index = 0; index < size; index += 1) value = value * 256 + view.getUint8(offset + index)
  return Number.isSafeInteger(value) ? value : null
}

function findHeifExifItemId(view, iinf) {
  let offset = iinf.start
  if (offset + 6 > iinf.end) return null
  const version = view.getUint8(offset)
  offset += 4
  const count = version === 0 ? view.getUint16(offset, false) : view.getUint32(offset, false)
  offset += version === 0 ? 2 : 4
  for (let index = 0; index < count && offset + 8 <= iinf.end; index += 1) {
    const infe = isoBox(view, offset)
    if (!infe || infe.end > iinf.end) break
    if (infe.type === 'infe' && infe.start + 8 <= infe.end) {
      const infeVersion = view.getUint8(infe.start)
      let pointer = infe.start + 4
      let id
      if (infeVersion >= 3) {
        if (pointer + 4 > infe.end) return null
        id = view.getUint32(pointer, false)
        pointer += 4
      } else {
        if (pointer + 2 > infe.end) return null
        id = view.getUint16(pointer, false)
        pointer += 2
      }
      pointer += 2
      if (infeVersion >= 2 && pointer + 4 <= infe.end) {
        const itemType = String.fromCharCode(view.getUint8(pointer), view.getUint8(pointer + 1), view.getUint8(pointer + 2), view.getUint8(pointer + 3))
        if (itemType === 'Exif') return id
      }
    }
    offset = infe.end
  }
  return null
}

function findHeifExtent(view, iloc, itemId) {
  let offset = iloc.start
  if (offset + 8 > iloc.end) return null
  const version = view.getUint8(offset)
  offset += 4
  const firstSizes = view.getUint8(offset++)
  const secondSizes = view.getUint8(offset++)
  const offsetSize = firstSizes >> 4
  const lengthSize = firstSizes & 15
  const baseOffsetSize = secondSizes >> 4
  const indexSize = version === 1 || version === 2 ? secondSizes & 15 : 0
  const itemCount = version < 2 ? view.getUint16(offset, false) : view.getUint32(offset, false)
  offset += version < 2 ? 2 : 4
  for (let index = 0; index < itemCount; index += 1) {
    if (offset >= iloc.end) return null
    const id = version < 2 ? view.getUint16(offset, false) : view.getUint32(offset, false)
    offset += version < 2 ? 2 : 4
    if (version === 1 || version === 2) {
      if (offset + 2 > iloc.end) return null
      offset += 2
    }
    if (offset + 2 > iloc.end) return null
    offset += 2
    const baseOffset = readSized(view, offset, baseOffsetSize)
    if (baseOffset === null) return null
    offset += baseOffsetSize
    if (offset + 2 > iloc.end) return null
    const extentCount = view.getUint16(offset, false)
    offset += 2
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if (indexSize) {
        if (readSized(view, offset, indexSize) === null) return null
        offset += indexSize
      }
      const extentOffset = readSized(view, offset, offsetSize)
      if (extentOffset === null) return null
      offset += offsetSize
      const extentLength = readSized(view, offset, lengthSize)
      if (extentLength === null) return null
      offset += lengthSize
      if (id === itemId && extentLength > 0) return { offset: baseOffset + extentOffset, length: extentLength }
    }
  }
  return null
}

async function parseHeifExif(file) {
  let headSize = Math.min(file.size, 4 * 1024 * 1024)
  let buffer = await file.slice(0, headSize).arrayBuffer()
  let view = new DataView(buffer)
  let meta = null
  let offset = 0
  while (offset + 8 <= view.byteLength) {
    const box = isoBox(view, offset)
    if (!box) break
    if (box.type === 'meta') {
      meta = box
      break
    }
    offset = box.end
  }
  if (!meta && headSize < file.size) {
    headSize = Math.min(file.size, 8 * 1024 * 1024)
    buffer = await file.slice(0, headSize).arrayBuffer()
    view = new DataView(buffer)
    offset = 0
    while (offset + 8 <= view.byteLength) {
      const box = isoBox(view, offset)
      if (!box) break
      if (box.type === 'meta') {
        meta = box
        break
      }
      offset = box.end
    }
  }
  if (!meta || meta.start + 4 >= meta.end) return {}
  const childStart = meta.start + 4
  const iinf = findIsoBox(view, childStart, meta.end, 'iinf')
  const iloc = findIsoBox(view, childStart, meta.end, 'iloc')
  if (!iinf || !iloc) return {}
  const itemId = findHeifExifItemId(view, iinf)
  if (itemId === null) return {}
  const extent = findHeifExtent(view, iloc, itemId)
  if (!extent || extent.offset < 0 || extent.length <= 8 || extent.offset + extent.length > file.size) return {}
  const exifBuffer = await file.slice(extent.offset, extent.offset + extent.length).arrayBuffer()
  const exifView = new DataView(exifBuffer)
  if (exifView.byteLength < 8) return {}
  const tiffBase = 4 + exifView.getUint32(0, false)
  if (tiffBase + 8 > exifView.byteLength) return {}
  return parseTiff(exifView, tiffBase)
}

function parseTiff(view, base) {
  try {
    if (base < 0 || base + 8 > view.byteLength) return {}
    const marker = view.getUint16(base, false)
    if (marker !== 0x4949 && marker !== 0x4d4d) return {}
    const littleEndian = marker === 0x4949
    const u16 = (offset) => view.getUint16(offset, littleEndian)
    const u32 = (offset) => view.getUint32(offset, littleEndian)
    const ifd0 = base + u32(base + 4)
    if (ifd0 < base || ifd0 + 2 > view.byteLength) return {}
    let exifPtr = 0
    let gpsPtr = 0
    const scan = (position, callback) => {
      if (position < base || position + 2 > view.byteLength) return
      const count = u16(position)
      for (let index = 0; index < count; index += 1) {
        const entry = position + 2 + index * 12
        if (entry + 12 > view.byteLength) break
        callback(u16(entry), u16(entry + 2), u32(entry + 4), entry + 8)
      }
    }
    scan(ifd0, (tag, _type, _count, data) => {
      if (tag === 0x8769) exifPtr = base + u32(data)
      if (tag === 0x8825) gpsPtr = base + u32(data)
    })
    const output = {}
    const readAscii = (type, count, data) => {
      if (type !== 2) return ''
      const start = count <= 4 ? data : base + u32(data)
      if (start < 0 || start >= view.byteLength) return ''
      let string = ''
      for (let index = 0; index < count && start + index < view.byteLength; index += 1) {
        const char = view.getUint8(start + index)
        if (!char) break
        string += String.fromCharCode(char)
      }
      return string
    }
    if (exifPtr) scan(exifPtr, (tag, type, count, data) => {
      if (tag === 0x9003) output.dateTimeOriginal = exifDateToIso(readAscii(type, count, data))
      if (tag === 0x9004) output.createDate = exifDateToIso(readAscii(type, count, data))
    })
    if (gpsPtr) {
      let latRef = ''
      let lonRef = ''
      let latitude = null
      let longitude = null
      const rational = (pointer) => {
        if (pointer < 0 || pointer + 8 > view.byteLength) return Number.NaN
        const denominator = u32(pointer + 4)
        return denominator ? u32(pointer) / denominator : Number.NaN
      }
      const triple = (data) => {
        const pointer = base + u32(data)
        const degree = rational(pointer)
        const minute = rational(pointer + 8)
        const second = rational(pointer + 16)
        return [degree, minute, second].every(Number.isFinite) ? degree + minute / 60 + second / 3600 : null
      }
      scan(gpsPtr, (tag, type, count, data) => {
        if (tag === 1) latRef = readAscii(type, count, data)
        if (tag === 2) latitude = triple(data)
        if (tag === 3) lonRef = readAscii(type, count, data)
        if (tag === 4) longitude = triple(data)
      })
      if (latitude !== null) output.latitude = latRef === 'S' ? -latitude : latitude
      if (longitude !== null) output.longitude = lonRef === 'W' ? -longitude : longitude
    }
    return output
  } catch {
    return {}
  }
}
