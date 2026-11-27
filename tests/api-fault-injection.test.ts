import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, WorkerApi } from '../src/main/api'

class MemorySessionStore {
  session: any = null
  cleared = 0
  saved = 0
  async stableDeviceId() { return '11111111-1111-4111-8111-111111111111' }
  async load() { return this.session }
  async save(value: any) { this.session = value; this.saved += 1 }
  async clear() { this.session = null; this.cleared += 1 }
  async readBootstrapNonce() { return null }
  async deleteBootstrapNonce() {}
}

function response(status: number, code = `HTTP_${status}`): Response {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function stalledResponse(status: number, contentType: string, signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"code":"PARTIAL'))
      signal?.addEventListener('abort', () => controller.error(new Error('aborted by request timeout')), { once: true })
    }
  })
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

afterEach(() => vi.useRealTimers())

function apiFor(fetcher: (input: string, init?: RequestInit) => Promise<Response>, store = new MemorySessionStore()) {
  return {
    api: new WorkerApi(
      store as any,
      () => 'https://staging.example.test',
      fetcher,
      () => ({ deviceName: 'E2E Windows', osName: 'win32', osVersion: 'test', clientVersion: '1.4.1' })
    ),
    store
  }
}

describe('WorkerApi deterministic network fault mapping', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    it(`marks HTTP ${status} retryable`, async () => {
      const { api } = apiFor(async () => response(status))
      await expect(api.health()).rejects.toMatchObject({ status, retryable: true })
    })
  }

  for (const status of [400, 401, 403, 404, 409, 413]) {
    it(`marks HTTP ${status} non-retryable`, async () => {
      const { api } = apiFor(async () => response(status))
      await expect(api.health()).rejects.toMatchObject({ status, retryable: false })
    })
  }

  it('maps connection reset / DNS-style fetch failures to retryable NETWORK_ERROR', async () => {
    const { api } = apiFor(async () => { throw new Error('ECONNRESET simulated') })
    await expect(api.health()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true })
  })

  it('fails closed on malformed, empty, wrong-content-type and oversized successful responses', async () => {
    const malformed = apiFor(async () => new Response('{"ok":', { status: 200, headers: { 'content-type': 'application/json' } })).api
    await expect(malformed.health()).rejects.toMatchObject({ code: 'INVALID_RESPONSE_JSON', retryable: true })

    const empty = apiFor(async () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })).api
    await expect(empty.health()).rejects.toMatchObject({ code: 'EMPTY_RESPONSE', retryable: true })

    const wrongType = apiFor(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'text/html' } })).api
    await expect(wrongType.health()).rejects.toMatchObject({ code: 'INVALID_RESPONSE_CONTENT_TYPE', retryable: true })

    const oversized = apiFor(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) }
    })).api
    await expect(oversized.health()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', retryable: false })
  })

  it('honors request timeout without hanging indefinitely', async () => {
    const api = new WorkerApi(
      new MemorySessionStore() as any,
      () => 'https://staging.example.test',
      async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test timeout')), { once: true })
      }),
      () => ({ deviceName: 'E2E Windows', osName: 'win32', osVersion: 'test', clientVersion: '1.4.1' })
    )
    const started = Date.now()
    await expect((api as any).json('/health', { method: 'GET' }, { auth: false, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps the timeout active while reading a successful JSON body', async () => {
    const { api } = apiFor(async (_input, init) => stalledResponse(200, 'application/json', init?.signal ?? undefined))
    const started = Date.now()
    await expect((api as any).json('/health', { method: 'GET' }, { auth: false, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps the timeout active while reading a JSON HTTP error body', async () => {
    const { api } = apiFor(async (_input, init) => stalledResponse(503, 'application/json', init?.signal ?? undefined))
    await expect((api as any).json('/health', { method: 'GET' }, { auth: false, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true })
  })

  it('cancels outstanding bodies during shutdown and permits later requests', async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let calls = 0
    const { api } = apiFor(async (_input, init) => {
      if (++calls > 1) return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      const response = stalledResponse(200, 'application/json', init?.signal ?? undefined)
      markStarted()
      return response
    })
    const pending = api.health()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
    await started
    api.cancelRequests()
    await rejected
    await expect(api.health()).resolves.toMatchObject({ ok: true })
  })

  it('does not wait on a stalled non-JSON HTTP error body', async () => {
    const { api } = apiFor(async (_input, init) => stalledResponse(503, 'text/plain', init?.signal ?? undefined))
    await expect((api as any).json('/health', { method: 'GET' }, { auth: false, timeoutMs: 500 }))
      .rejects.toMatchObject({ code: 'HTTP_503', status: 503, retryable: true })
  })

  it('applies the timeout while downloading a binary response body', async () => {
    vi.useFakeTimers()
    const { api, store } = apiFor(async (_input, init) => stalledResponse(200, 'application/octet-stream', init?.signal ?? undefined))
    store.session = { token: 'test-session-token' }
    const download = api.downloadCurrent('file-id')
    const rejected = expect(download).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true })
    await vi.advanceTimersByTimeAsync(180_000)
    await rejected
  })

  it('composes a caller signal with the timeout instead of replacing the timeout', async () => {
    const caller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    const { api } = apiFor(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined
      return stalledResponse(200, 'application/json', fetchSignal)
    })
    await expect((api as any).json('/health', { method: 'GET', signal: caller.signal }, { auth: false, timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: true })
    expect(fetchSignal).not.toBe(caller.signal)
    expect(caller.signal.aborted).toBe(false)
  })

  it('clears an authenticated session on 401 without swallowing the failure', async () => {
    const store = new MemorySessionStore()
    store.session = {
      token: 'test-session-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      username: 'e2e',
      deviceId: null,
      auth: null
    }
    let invalidated = 0
    const api = new WorkerApi(
      store as any,
      () => 'https://staging.example.test',
      async () => response(401, 'SESSION_INVALID'),
      () => ({ deviceName: 'E2E Windows', osName: 'win32', osVersion: 'test', clientVersion: '1.4.1' }),
      () => { invalidated += 1 }
    )
    await expect(api.me()).rejects.toBeInstanceOf(ApiError)
    expect(store.cleared).toBe(1)
    expect(store.session).toBeNull()
    expect(invalidated).toBe(1)
  })
})
