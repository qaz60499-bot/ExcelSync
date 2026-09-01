import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { filePartitionForName, isSupportedFileName } from '../src/shared/file-types'

const rendererPath = new URL('../src/renderer/src/App.tsx', import.meta.url)
const workerPath = new URL('../worker/src/index.ts', import.meta.url)
const wranglerPath = new URL('../wrangler.jsonc', import.meta.url)
const migration4Path = new URL('../migrations/0004_personal_cloud_photos.sql', import.meta.url)
const migration5Path = new URL('../migrations/0005_photo_legacy_metadata.sql', import.meta.url)

describe('ExcelSync product boundary', () => {
  it('does not expose the Personal Cloud photo product in the desktop renderer', async () => {
    const source = await readFile(rendererPath, 'utf8')
    expect(source).not.toContain("'photos'")
    expect(source).not.toContain('Personal Cloud')
    expect(source).not.toContain('PhotosPage')
  })

  it('does not route or publish the Personal Cloud photo product from the ExcelSync Worker', async () => {
    const [worker, wrangler] = await Promise.all([
      readFile(workerPath, 'utf8'),
      readFile(wranglerPath, 'utf8')
    ])
    expect(worker).not.toContain('handlePhotoRoute')
    expect(worker).not.toContain('/storage/photos/')
    expect(worker).not.toContain('TELEGRAM_PHOTOS_BOT_TOKEN')
    expect(worker).not.toContain('LEGACY_PHOTO_SERVICE')
    expect(wrangler).not.toContain('LEGACY_PHOTO_SERVICE')
    expect(wrangler).not.toContain('"assets"')
  })

  it('keeps historical D1 migration numbers without creating a photo domain on fresh databases', async () => {
    const [migration4, migration5] = await Promise.all([
      readFile(migration4Path, 'utf8'),
      readFile(migration5Path, 'utf8')
    ])
    expect(migration4).toContain("purpose TEXT NOT NULL CHECK (purpose = 'files')")
    expect(migration4).toContain("VALUES ('files-primary', 'files', 'telegram', NULL)")
    expect(migration4).not.toContain('photo_assets')
    expect(migration4).not.toContain('photos-private')
    expect(migration5).not.toMatch(/ALTER TABLE\s+photo_/i)
  })

  it('still treats image files as normal managed files with generic image preview support', () => {
    expect(isSupportedFileName('photo.webp')).toBe(true)
    expect(filePartitionForName('photo.webp')).toBe('image')
  })
})
