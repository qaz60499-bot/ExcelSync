import { link, lstat, opendir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isManagedFile, sha256File } from './file-utils'

interface RecoveryCallbacks {
  knownSyncedHash(relativePath: string): string | null
  onRecovered(relativePath: string, action: string): void
  onError(relativePath: string, error: unknown): void
}

// These names are written by our two replacement paths. They also constitute a
// recovery marker if the process dies before it can execute its finally block.
const replacementBackup = /^(.*)\.excelsync-(?:displaced-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp|backup-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/i

export async function recoverInterruptedReplacements(root: string, callbacks: RecoveryCallbacks): Promise<{ recovered: number; errors: number; examined: number }> {
  const base = resolve(root)
  const queue = [{ path: base, depth: 0 }]
  const stats = { recovered: 0, errors: 0, examined: 0 }
  const reportError = (path: string, error: unknown): void => {
    stats.errors++
    callbacks.onError(relative(base, path).replaceAll('\\', '/'), error)
  }
  while (queue.length) {
    const directory = queue.shift()!
    try {
      const entries = await opendir(directory.path)
      for await (const entry of entries) {
        if (++stats.examined > 100_000) {
          reportError(directory.path, new Error('INTERRUPTED_RECOVERY_SCAN_LIMIT'))
          return stats
        }
        if (entry.isSymbolicLink()) continue
        const path = join(directory.path, entry.name)
        if (entry.isDirectory()) {
          if (directory.depth < 64) queue.push({ path, depth: directory.depth + 1 })
          else reportError(path, new Error('INTERRUPTED_RECOVERY_DEPTH_LIMIT'))
          continue
        }
        if (!entry.isFile()) continue
        const match = replacementBackup.exec(entry.name)
        if (!match || !isManagedFile(match[1]!)) continue
        const canonical = join(directory.path, match[1]!)
        const relativePath = relative(base, canonical).replaceAll('\\', '/')
        try {
          let canonicalExists = false
          try {
            const info = await lstat(canonical)
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('RECOVERY_TARGET_NOT_REGULAR_FILE')
            canonicalExists = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (!canonicalExists) {
            // Exclusive creation never overwrites a save made during startup.
            try {
              await link(path, canonical)
              await rm(path)
              callbacks.onRecovered(relativePath, 'restored-original')
              stats.recovered++
              continue
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
          }
          const backupHash = await sha256File(path)
          const currentHash = await sha256File(canonical)
          if (backupHash === currentHash || backupHash === callbacks.knownSyncedHash(relativePath)) {
            await rm(path)
            callbacks.onRecovered(relativePath, 'removed-verified-backup')
          } else {
            const extension = extname(canonical)
            const name = basename(canonical, extension)
            const recovered = join(dirname(canonical), `${name} (recovered ${randomUUID()})${extension}`)
            await link(path, recovered)
            await rm(path)
            callbacks.onRecovered(relative(base, recovered).replaceAll('\\', '/'), 'preserved-divergent-original')
          }
          stats.recovered++
        } catch (error) { reportError(path, error) }
      }
    } catch (error) { reportError(directory.path, error) }
  }
  return stats
}
