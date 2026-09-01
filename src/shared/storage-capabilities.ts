export type StorageBackend = 'telegram_user_group' | 'telegram_bot'

export interface StorageCapabilitiesView {
  maxUploadBytes: number
  maxDownloadBytes: number
  maxReliableFileBytes: number
  supportsLargeFiles: boolean
}

export const TELEGRAM_USER_GROUP_CAPABILITIES: Readonly<StorageCapabilitiesView> = Object.freeze({
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  maxDownloadBytes: 2 * 1024 * 1024 * 1024,
  maxReliableFileBytes: 2 * 1024 * 1024 * 1024,
  supportsLargeFiles: true
})

export const TELEGRAM_OFFICIAL_BOT_CAPABILITIES: Readonly<StorageCapabilitiesView> = Object.freeze({
  maxUploadBytes: 20 * 1024 * 1024,
  maxDownloadBytes: 20 * 1024 * 1024,
  maxReliableFileBytes: 20 * 1024 * 1024,
  supportsLargeFiles: false
})

export function capabilitiesForStorageProvider(provider: string): Readonly<StorageCapabilitiesView> {
  const normalized = provider.toLowerCase()
  if (normalized === 'telegram_user_group') return TELEGRAM_USER_GROUP_CAPABILITIES
  if (normalized === 'telegram' || normalized === 'telegram_bot') return TELEGRAM_OFFICIAL_BOT_CAPABILITIES
  return Object.freeze({
    maxUploadBytes: 0,
    maxDownloadBytes: 0,
    maxReliableFileBytes: 0,
    supportsLargeFiles: false
  })
}
