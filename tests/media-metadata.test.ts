// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { exifDateToIso, parseExif } from '../web/media-metadata.js'

function u16le(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
}

function u32le(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function u16be(bytes, offset, value) {
  bytes[offset] = (value >>> 8) & 0xff
  bytes[offset + 1] = value & 0xff
}

function u32be(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function ascii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
}

function makeTiff(dateOriginal = '2024:02:18 06:51:47', createDate = '2024:02:18 06:51:48') {
  const bytes = new Uint8Array(160)
  ascii(bytes, 0, 'II')
  u16le(bytes, 2, 42)
  u32le(bytes, 4, 8)
  u16le(bytes, 8, 1)
  u16le(bytes, 10, 0x8769)
  u16le(bytes, 12, 4)
  u32le(bytes, 14, 1)
  u32le(bytes, 18, 26)
  u32le(bytes, 22, 0)
  u16le(bytes, 26, 2)
  u16le(bytes, 28, 0x9003)
  u16le(bytes, 30, 2)
  u32le(bytes, 32, 20)
  u32le(bytes, 36, 56)
  u16le(bytes, 40, 0x9004)
  u16le(bytes, 42, 2)
  u32le(bytes, 44, 20)
  u32le(bytes, 48, 76)
  u32le(bytes, 52, 0)
  ascii(bytes, 56, `${dateOriginal}\0`)
  ascii(bytes, 76, `${createDate}\0`)
  return bytes.slice(0, 96)
}

function makeBlob(bytes, type, name) {
  const blob = new Blob([bytes], { type })
  Object.defineProperty(blob, 'name', { value: name })
  return blob
}

function box(type, payload) {
  const bytes = new Uint8Array(8 + payload.length)
  u32be(bytes, 0, bytes.length)
  ascii(bytes, 4, type)
  bytes.set(payload, 8)
  return bytes
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function makeJpeg(tiff) {
  const exifHeader = new Uint8Array(6)
  ascii(exifHeader, 0, 'Exif')
  const appPayload = concat(exifHeader, tiff)
  const app = new Uint8Array(4 + appPayload.length)
  app[0] = 0xff
  app[1] = 0xe1
  u16be(app, 2, appPayload.length + 2)
  app.set(appPayload, 4)
  return concat(Uint8Array.from([0xff, 0xd8]), app, Uint8Array.from([0xff, 0xd9]))
}

function makeHeic(tiff) {
  const exifPayload = new Uint8Array(4 + tiff.length)
  u32be(exifPayload, 0, 0)
  exifPayload.set(tiff, 4)
  const infePayload = new Uint8Array(12)
  infePayload[0] = 2
  u16be(infePayload, 4, 1)
  u16be(infePayload, 6, 0)
  ascii(infePayload, 8, 'Exif')
  const infe = box('infe', infePayload)
  const iinfPayload = new Uint8Array(6 + infe.length)
  iinfPayload[0] = 0
  u16be(iinfPayload, 4, 1)
  iinfPayload.set(infe, 6)
  const iinf = box('iinf', iinfPayload)
  const ilocPayload = new Uint8Array(22)
  ilocPayload[0] = 0
  ilocPayload[4] = 0x44
  ilocPayload[5] = 0x00
  u16be(ilocPayload, 6, 1)
  u16be(ilocPayload, 8, 1)
  u16be(ilocPayload, 10, 0)
  u16be(ilocPayload, 12, 1)
  u32be(ilocPayload, 18, exifPayload.length)
  const iloc = box('iloc', ilocPayload)
  const meta = box('meta', concat(new Uint8Array(4), iinf, iloc))
  const ftypPayload = new Uint8Array(16)
  ascii(ftypPayload, 0, 'heic')
  u32be(ftypPayload, 4, 0)
  ascii(ftypPayload, 8, 'heic')
  ascii(ftypPayload, 12, 'mif1')
  const ftyp = box('ftyp', ftypPayload)
  const extentOffset = ftyp.length + meta.length + 8
  const ilocExtentOffsetInMeta = 8 + 4 + iinf.length + 8 + 14
  u32be(meta, ilocExtentOffsetInMeta, extentOffset)
  return concat(ftyp, meta, box('mdat', exifPayload))
}

describe('mobile media metadata parser', () => {
  it('normalizes EXIF dates', () => {
    expect(exifDateToIso('2024:02:18 06:51:47')).toBe(new Date('2024-02-18T06:51:47').toISOString())
    expect(exifDateToIso('invalid')).toBeNull()
  })

  it('reads DateTimeOriginal and CreateDate from JPEG EXIF', async () => {
    const result = await parseExif(makeBlob(makeJpeg(makeTiff()), 'image/jpeg', 'IMG_4300.jpeg'))
    expect(result.dateTimeOriginal).toBe(new Date('2024-02-18T06:51:47').toISOString())
    expect(result.createDate).toBe(new Date('2024-02-18T06:51:48').toISOString())
  })

  it('reads DateTimeOriginal and CreateDate from HEIC Exif item', async () => {
    const result = await parseExif(makeBlob(makeHeic(makeTiff()), 'image/heic', 'IMG_4300.HEIC'))
    expect(result.dateTimeOriginal).toBe(new Date('2024-02-18T06:51:47').toISOString())
    expect(result.createDate).toBe(new Date('2024-02-18T06:51:48').toISOString())
  })

  it('falls back to an empty object for unsupported images', async () => {
    const result = await parseExif(makeBlob(new Uint8Array([1, 2, 3, 4]), 'image/png', 'x.png'))
    expect(result).toEqual({})
  })
})
