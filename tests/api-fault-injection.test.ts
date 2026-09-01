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

  for (const status of [400, 401, 403, 404, 413]) {
    it(`marks HTTP ${status} non-retryable`, async () => {
      const { api } = apiFor(async () => response(status))
      await expect(api.health()).rejects.toMatchObject({ status, retryable: false })
    })
  }

  it('maps connection reset / DNS-style fetch failures to retryable NETWORK_ERROR', async () => {
    const { api } = apiFor(async () => { throw new Error('ECONNRESET simulated') })
    await expect(api.health()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0, retryable: true })
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
