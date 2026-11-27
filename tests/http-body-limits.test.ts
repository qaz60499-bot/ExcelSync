import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_JSON_REQUEST_BYTES, requestJson } from '../worker/src/http'

describe('Worker JSON input memory boundary', () => {
  it('rejects declared oversized bodies before reading them', async () => {
    let read = false
    await expect(requestJson({ headers: new Headers({ 'content-type': 'application/json', 'content-length': String(MAX_JSON_REQUEST_BYTES + 1) }), async json() { read = true; return {} } }, z.object({}))).rejects.toMatchObject({ status: 413, code: 'REQUEST_TOO_LARGE' })
    expect(read).toBe(false)
  })
  it('enforces the actual byte count for chunked input', async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_JSON_REQUEST_BYTES)); controller.enqueue(new Uint8Array(1)) },
      cancel() { canceled = true }
    })
    await expect(requestJson({ headers: new Headers({ 'content-type': 'application/json' }), body, async json() { throw new Error('MUST_NOT_BUFFER_UNBOUNDED') } }, z.object({}))).rejects.toMatchObject({ status: 413, code: 'REQUEST_TOO_LARGE' })
    expect(canceled).toBe(true)
  })
  it('preserves Unicode payload validation and malformed JSON errors', async () => {
    const request = new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '中文文件.xlsx' }) })
    await expect(requestJson(request, z.object({ name: z.string() }))).resolves.toEqual({ name: '中文文件.xlsx' })
    const invalid = new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })
    await expect(requestJson(invalid, z.object({}))).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' })
  })
})
