import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const secret = process.env.EXCELSYNC_BRIDGE_SECRET
const mode = process.env.EXCELSYNC_TEST_TELEGRAM_MODE ?? 'success'
let progress = null

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const server = createServer(async (request, response) => {
  if (request.headers['x-excelsync-bridge-secret'] !== secret) {
    send(response, 403, { ok: false, error: { code: 'BRIDGE_FORBIDDEN', message: 'BRIDGE_FORBIDDEN' } })
    return
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/health') {
    const authorized = mode !== 'auth-failure'
    send(response, 200, { ok: true, result: { authorized, chatId: authorized ? '-10042' : null, chatTitle: authorized ? 'Test group' : null } })
    return
  }
  if (request.method === 'GET' && url.pathname === '/progress') {
    if (!progress || progress.id !== url.searchParams.get('id')) {
      send(response, 409, { ok: false, error: { code: 'TRANSFER_PROGRESS_NOT_FOUND', message: 'TRANSFER_PROGRESS_NOT_FOUND' } })
      return
    }
    send(response, 200, { ok: true, result: progress })
    return
  }
  if (request.method === 'POST' && url.pathname === '/upload') {
    const body = await readBody(request)
    if (mode === 'network-failure') {
      request.socket.destroy()
      return
    }
    if (mode === 'auth-failure') {
      send(response, 409, { ok: false, error: { code: 'TELEGRAM_AUTHORIZATION_LOST', message: 'Telegram authorization expired' } })
      return
    }
    progress = {
      id: body.operationId,
      direction: 'upload',
      fileName: basename(body.path),
      phase: 'transferring',
      transferredBytes: 1,
      totalBytes: 10,
      bytesPerSecond: 1,
      updatedAt: Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
    const bytes = await readFile(body.path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const size = mode === 'receipt-mismatch' ? bytes.length + 1 : bytes.length
    send(response, 200, {
      ok: true,
      result: {
        backend: 'telegram_user_group', chatId: body.chatId, messageId: 99, fileName: basename(body.path), size,
        sha256: mode === 'receipt-mismatch' ? '0'.repeat(64) : sha256,
        mimeType: 'application/octet-stream', createdAt: new Date().toISOString()
      }
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/download') {
    await readBody(request)
    send(response, 409, { ok: false, error: { code: 'TELEGRAM_MESSAGE_DOCUMENT_NOT_FOUND', message: 'Telegram message has no document' } })
    return
  }
  if (request.method === 'POST' && url.pathname === '/shutdown') {
    send(response, 200, { ok: true, result: { stopping: true } })
    server.close(() => process.exit(0))
    return
  }
  send(response, 404, { ok: false, error: { code: 'BRIDGE_ROUTE_NOT_FOUND', message: 'BRIDGE_ROUTE_NOT_FOUND' } })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`READY ${server.address().port}`)
})
