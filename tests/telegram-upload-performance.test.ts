import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Telegram private-group upload performance regressions', () => {
  it('ships Telethon native crypto acceleration in the packaged bridge', async () => {
    const [requirements, buildScript, bridge] = await Promise.all([
      readFile(new URL('../scripts/telegram-storage-requirements.txt', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/build-telegram-storage-bridge.cjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/telegram-storage-bridge.py', import.meta.url), 'utf8')
    ])

    expect(requirements).toMatch(/^cryptg>=0\.6,<0\.7$/m)
    expect(buildScript).toContain("'--hidden-import', 'cryptg'")
    expect(bridge).toContain('import cryptg')
    expect(bridge).toContain('"cryptoAccelerated": True')
  })

  it('uploads with Telegram maximum 512 KiB parts before sending the document message', async () => {
    const bridge = await readFile(new URL('../scripts/telegram-storage-bridge.py', import.meta.url), 'utf8')

    expect(bridge).toContain('UPLOAD_PART_SIZE_KB = 512')
    expect(bridge).toContain('uploaded_file = await client.upload_file(')
    expect(bridge).toContain('part_size_kb=UPLOAD_PART_SIZE_KB')
    expect(bridge).toContain('file_size=size')
    expect(bridge).toContain('await client.send_file(\n        entity,\n        uploaded_file,')
  })

  it('keeps multiple independent sync jobs available for aggregate throughput', async () => {
    const engine = await readFile(new URL('../src/main/sync-engine.ts', import.meta.url), 'utf8')
    expect(engine).toContain('private readonly maxConcurrentJobs = 3')
  })
})
