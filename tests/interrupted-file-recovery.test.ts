import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverInterruptedReplacements } from '../src/main/interrupted-file-recovery'
import { sha256File } from '../src/main/file-utils'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'excelsync-interrupted-')); roots.push(root); return root }
const callbacks = { knownSyncedHash: () => null, onRecovered: () => {}, onError: () => {} }

describe('interrupted local replacement recovery', () => {
  it('restores the real original bytes after a child dies between rename and install, and is idempotent', async () => {
    const root = await fixture()
    const canonical = join(root, 'saved.txt')
    const displaced = `${canonical}.excelsync-displaced-${randomUUID()}.tmp`
    await writeFile(canonical, 'last local save before process death')
    const child = spawnSync(process.execPath, ['-e', "require('node:fs').renameSync(process.argv[1],process.argv[2]);process.exit(73)", canonical, displaced], { windowsHide: true })
    expect(child.status).toBe(73)
    await expect(readFile(canonical)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await recoverInterruptedReplacements(root, callbacks)
    expect(result.recovered).toBe(1)
    expect(result.errors).toBe(0)
    expect(await readFile(canonical, 'utf8')).toBe('last local save before process death')
    expect((await recoverInterruptedReplacements(root, callbacks)).recovered).toBe(0)
  })

  it('keeps a newer canonical save and makes divergent displaced bytes visible as a managed recovery copy', async () => {
    const root = await fixture()
    const canonical = join(root, 'saved.txt')
    const displaced = `${canonical}.excelsync-displaced-${randomUUID()}.tmp`
    await writeFile(canonical, 'newer canonical save')
    await writeFile(displaced, 'interrupted unsynced original')
    await recoverInterruptedReplacements(root, callbacks)
    expect(await readFile(canonical, 'utf8')).toBe('newer canonical save')
    const copies = (await readdir(root)).filter(name => name.includes('(recovered '))
    expect(copies).toHaveLength(1)
    expect(await readFile(join(root, copies[0]!), 'utf8')).toBe('interrupted unsynced original')
  })

  it('recognizes the storage-router backup marker and cleans only verified redundant/committed bytes', async () => {
    const root = await fixture()
    const canonical = join(root, 'saved.txt')
    const backup = `${canonical}.excelsync-backup-${randomUUID()}`
    await writeFile(backup, 'known committed baseline')
    const baseline = await sha256File(backup)
    await writeFile(canonical, 'installed remote content')
    const result = await recoverInterruptedReplacements(root, { ...callbacks, knownSyncedHash: () => baseline })
    expect(result.errors).toBe(0)
    expect(await readdir(root)).toEqual(['saved.txt'])
    expect(await readFile(canonical, 'utf8')).toBe('installed remote content')
  })

  it('leaves unrelated temporary names and invalid markers untouched', async () => {
    const root = await fixture()
    await writeFile(join(root, 'user.tmp'), 'user temporary file')
    await writeFile(join(root, 'saved.txt.excelsync-displaced-not-a-uuid.tmp'), 'not our marker')
    const result = await recoverInterruptedReplacements(root, callbacks)
    expect(result.recovered).toBe(0)
    expect(await readdir(root)).toHaveLength(2)
  })
})
