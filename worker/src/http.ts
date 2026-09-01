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
  json(): Promise<unknown>
}

export async function requestJson<T>(request: JsonRequestLike, schema: z.ZodType<T>): Promise<T> {
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) throw new HttpError(415, 'JSON_REQUIRED')
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new HttpError(400, 'INVALID_JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', 'Invalid request payload', parsed.error.flatten())
  return parsed.data
}
