import { describe, expect, it } from 'vitest'
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
