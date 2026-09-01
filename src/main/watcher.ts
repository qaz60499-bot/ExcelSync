import chokidar, { type FSWatcher } from 'chokidar'
import { resolve } from 'node:path'
import { isManagedFile, isOfficeLockFile } from './file-utils'

export interface WatcherCallbacks {
  onFileReady(path: string): Promise<void>
  onFileDeleted(path: string): Promise<void>
  onOfficeLock?(path: string, active: boolean): Promise<void>
  onWatcherError?(error: Error): void
}

export class ExcelWatcher {
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly callbacks: WatcherCallbacks) {}

  async start(directory: string): Promise<void> {
    await this.stop()
    const root = resolve(directory)
    this.watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      depth: 20,
      ignored: (path, stats) => Boolean(stats?.isFile() && !isManagedFile(path) && !isOfficeLockFile(path))
    })

    this.watcher.on('add', (path) => {
      if (isOfficeLockFile(path)) void this.callbacks.onOfficeLock?.(path, true)
      else this.schedule(path)
    })
    this.watcher.on('change', (path) => {
      if (isOfficeLockFile(path)) void this.callbacks.onOfficeLock?.(path, true)
      else this.schedule(path)
    })
    this.watcher.on('unlink', (path) => {
      this.cancel(path)
      if (isOfficeLockFile(path)) void this.callbacks.onOfficeLock?.(path, false)
      else if (isManagedFile(path)) void this.callbacks.onFileDeleted(path)
    })
    this.watcher.on('error', (error) => this.callbacks.onWatcherError?.(error instanceof Error ? error : new Error(String(error))))
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.watcher) {
      const watcher = this.watcher
      this.watcher = null
      await watcher.close()
    }
  }

  private cancel(path: string): void {
    const timer = this.timers.get(path)
    if (timer) clearTimeout(timer)
    this.timers.delete(path)
  }

  private schedule(path: string): void {
    if (!isManagedFile(path)) return
    this.cancel(path)
    const timer = setTimeout(() => {
      this.timers.delete(path)
      void this.callbacks.onFileReady(path)
    }, 900)
    this.timers.set(path, timer)
  }
}
