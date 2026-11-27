import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly detail?: unknown
  ) {
    super(message)
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

export interface JsonRequestLike {
  headers: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
  json(): Promise<unknown>
}

export const MAX_JSON_REQUEST_BYTES = 1024 * 1024

async function limitedJson(request: JsonRequestLike): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_JSON_REQUEST_BYTES) throw new HttpError(413, 'REQUEST_TOO_LARGE')
  // Lightweight internal test adapters only expose json(); real Requests always
  // provide body, including when Content-Length is absent or untrusted.
  if (!request.body) return request.json()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_JSON_REQUEST_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new HttpError(413, 'REQUEST_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function requestJson<T>(request: JsonRequestLike, schema: z.ZodType<T>): Promise<T> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new HttpError(415, 'JSON_REQUIRED')
  let raw: unknown
  try {
    raw = await limitedJson(request)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'INVALID_JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', 'Invalid request payload', parsed.error.flatten())
  return parsed.data
}

export async function requestFormDataLimited(request: Request, maxBytes: number): Promise<FormData> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new HttpError(413, 'FILE_TOO_LARGE')
  }
  if (!request.body) throw new HttpError(400, 'INVALID_MULTIPART')

  let exceededLimit = false
  let receivedBytes = 0
  const limitedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength
      if (receivedBytes > maxBytes) {
        exceededLimit = true
        controller.error(new Error('MULTIPART_BODY_TOO_LARGE'))
        return
      }
      controller.enqueue(chunk)
    }
  }))
  const headers = new Headers()
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  try {
    return await new Response(limitedBody, { headers }).formData()
  } catch {
    if (exceededLimit) throw new HttpError(413, 'FILE_TOO_LARGE')
    throw new HttpError(400, 'INVALID_MULTIPART')
  }
}
