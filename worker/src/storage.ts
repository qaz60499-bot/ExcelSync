import type { StorageCapabilitiesView } from '../../src/shared/storage-capabilities'

export interface StoredObject {
  fileId: string
  messageId: number
  fileUniqueId?: string
  previewFileId?: string
  size?: number
}

export interface StorageStatus {
  provider: string
  reachable: boolean
  detail?: string
}

export type StoragePurpose = 'files'

export type StorageCapabilities = StorageCapabilitiesView

export interface StorageProfile {
  profile: string
  purpose: StoragePurpose
  provider: string
  chatId: string
}

export interface StorageProvider {
  readonly name: string
  readonly capabilities: StorageCapabilities
  status(): Promise<StorageStatus>
  upload(input: {
    bytes: Uint8Array
    fileName: string
    mimeType: string
    caption?: string
  }): Promise<StoredObject>
  uploadStream(input: {
    body: ReadableStream<Uint8Array>
    sizeBytes: number
    fileName: string
    mimeType: string
    caption?: string
  }): Promise<StoredObject>
  clone(input: { fileId: string; caption?: string }): Promise<StoredObject>
  download(fileId: string): Promise<Response>
}
