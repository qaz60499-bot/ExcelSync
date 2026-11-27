import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerApi } from '../src/main/api'
import { DesktopStorageRouter } from '../src/main/desktop-storage-router'

function apiFor(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  return new WorkerApi({ load: async () => ({ token: 'test-session' }) } as any, () => 'https://example.test', fetcher)
}

describe('streamed Bot downloads', () => {
  it('writes verified current and historical bytes without buffering the response or rereading the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-stream-'))
    const bytes = Buffer.alloc(256 * 1024 + 13, 91)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const routes: string[] = []
    const api = apiFor(async url => {
      routes.push(url)
      let offset = 0
      const response = new Response(new ReadableStream({ pull(controller) {
        if (offset >= bytes.length) { controller.close(); return }
        controller.enqueue(bytes.subarray(offset, offset + 65536)); offset += 65536
      } }), { headers: { 'x-excelsync-hash': hash, 'x-excelsync-version': '3', 'x-excelsync-size': String(bytes.length) } })
      response.arrayBuffer = async () => { throw new Error('must stream') }
      return response
    })
    try {
      const router = new DesktopStorageRouter(api, {} as any)
      const current = await router.downloadCurrentTo('file', join(root, 'current.csv'))
      const history = await router.downloadVersionTo('file', 3, join(root, 'history.csv'))
      expect(current).toMatchObject({ version: 3, hash, size: bytes.length })
      expect(history).toEqual(current)
      expect(await readFile(join(root, 'current.csv'))).toEqual(bytes)
      expect(await readFile(join(root, 'history.csv'))).toEqual(bytes)
      expect(routes[1]).toContain('/versions/3/download')
      expect(await readdir(root)).toHaveLength(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  for (const fault of ['hash','size','body']) {
    it(`preserves the previous destination and removes partial bytes after ${fault} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'excelsync-stream-'))
      const destination = join(root, 'existing.csv')
      await writeFile(destination, 'original')
      const api = apiFor(async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('new data'))
        if (fault === 'body') controller.error(new Error('connection lost'))
        else controller.close()
      } }), { headers: { ...(fault === 'hash' ? { 'x-excelsync-hash': 'a'.repeat(64) } : {}), ...(fault === 'size' ? { 'x-excelsync-size': '99' } : {}) } }))
      try {
        await expect(new DesktopStorageRouter(api, {} as any).downloadCurrentTo('file', destination)).rejects.toThrow()
        expect(await readFile(destination, 'utf8')).toBe('original')
        expect(await readdir(root)).toEqual(['existing.csv'])
        expect((api as any).activeRequests.size).toBe(0)
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }

  it('cancels an in-flight body on shutdown and removes the partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'excelsync-stream-'))
    let started!: () => void
    const bodyStarted = new Promise<void>(resolve => { started = resolve })
    const api = apiFor(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1,2,3]))
      init!.signal!.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true })
      started()
    } })))
    try {
      const pending = api.downloadTo('file', join(root, 'partial.csv'))
      const rejected = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
      await bodyStarted
      api.cancelRequests()
      await rejected
      expect(await readdir(root)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
