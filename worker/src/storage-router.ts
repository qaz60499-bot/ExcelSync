import { decryptCredential } from './credential-crypto'
import { TelegramStorage } from './telegram-storage'
import type { StorageProfile, StorageProvider, StoragePurpose } from './storage'

export type StorageRuntimeEnv = Env & {
  TELEGRAM_BOT_TOKEN?: string
  STORAGE_MASTER_KEY?: string
}

export interface StorageConnectionInfo {
  id: string
  organizationId: string
  provider: string
  name: string
  chatId: string
  chatTitle: string | null
  status: 'ACTIVE' | 'DEGRADED' | 'DISABLED'
  credentialSource: 'ENCRYPTED' | 'LEGACY_WORKER_SECRET'
}

type StorageConnectionRow = {
  id: string
  organization_id: string
  provider: string
  name: string
  telegram_bot_username: string | null
  telegram_bot_name: string | null
  credential_ciphertext: string | null
  credential_iv: string | null
  credential_source: 'ENCRYPTED' | 'LEGACY_WORKER_SECRET'
  chat_id: string | null
  chat_title: string | null
  status: 'ACTIVE' | 'DEGRADED' | 'DISABLED'
}

export class StorageRouter {
  constructor(private readonly env: StorageRuntimeEnv) {}

  private async connection(connectionId: string): Promise<StorageConnectionRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, organization_id, provider, name, telegram_bot_username, telegram_bot_name, credential_ciphertext, credential_iv,
              credential_source, chat_id, chat_title, status
         FROM storage_connections WHERE id = ? LIMIT 1`
    ).bind(connectionId).first<StorageConnectionRow>()
    if (!row) throw new Error('STORAGE_CONNECTION_NOT_FOUND')
    if (row.status === 'DISABLED') throw new Error('STORAGE_CONNECTION_DISABLED')
    return row
  }

  private async credential(row: StorageConnectionRow): Promise<string> {
    if (row.credential_source === 'LEGACY_WORKER_SECRET') {
      const token = this.env.TELEGRAM_BOT_TOKEN
      if (!token || token === 'UNCONFIGURED') throw new Error('FILES_TELEGRAM_SECRET_NOT_CONFIGURED')
      return token
    }
    const master = this.env.STORAGE_MASTER_KEY
    if (!master) throw new Error('STORAGE_MASTER_KEY_NOT_CONFIGURED')
    if (!row.credential_ciphertext || !row.credential_iv) throw new Error('STORAGE_CREDENTIAL_MISSING')
    return decryptCredential(master, row.credential_ciphertext, row.credential_iv)
  }

  async resolveConnectionForCredentialCheck(connectionId: string, organizationId?: string): Promise<{ token: string; botUsername: string | null; botName: string | null }> {
    const row = await this.connection(connectionId)
    if (organizationId && row.organization_id !== organizationId) throw new Error('STORAGE_CONNECTION_NOT_FOUND')
    if (row.provider !== 'telegram') throw new Error(`STORAGE_PROVIDER_UNSUPPORTED_${row.provider.toUpperCase()}`)
    return { token: await this.credential(row), botUsername: row.telegram_bot_username, botName: row.telegram_bot_name }
  }

  async resolveConnection(connectionId: string): Promise<{ connection: StorageConnectionInfo; provider: StorageProvider }> {
    const row = await this.connection(connectionId)
    if (!row.chat_id) throw new Error('FILES_STORAGE_CHAT_NOT_CONNECTED')
    if (row.provider !== 'telegram') throw new Error(`STORAGE_PROVIDER_UNSUPPORTED_${row.provider.toUpperCase()}`)
    const token = await this.credential(row)
    return {
      connection: {
        id: row.id,
        organizationId: row.organization_id,
        provider: row.provider,
        name: row.name,
        chatId: row.chat_id,
        chatTitle: row.chat_title,
        status: row.status,
        credentialSource: row.credential_source
      },
      provider: new TelegramStorage(token, row.chat_id)
    }
  }

  async resolveWorkspaceDefault(workspaceId: string): Promise<{ connection: StorageConnectionInfo; provider: StorageProvider }> {
    const row = await this.env.DB.prepare(
      `SELECT default_storage_connection_id AS id
         FROM workspaces WHERE id = ? AND status = 'ACTIVE' LIMIT 1`
    ).bind(workspaceId).first<{ id: string | null }>()
    if (!row?.id) throw new Error('WORKSPACE_STORAGE_NOT_CONFIGURED')
    return this.resolveConnection(row.id)
  }

  async resolveVersion(fileId: string, version: number): Promise<{ connection: StorageConnectionInfo; provider: StorageProvider }> {
    const row = await this.env.DB.prepare(
      'SELECT storage_connection_id AS id FROM file_versions WHERE file_id = ? AND version = ? LIMIT 1'
    ).bind(fileId, version).first<{ id: string | null }>()
    const connectionId = row?.id ?? '00000000-0000-4000-8000-000000000003'
    return this.resolveConnection(connectionId)
  }

  /** Compatibility surface for 1.2.x code paths while 1.3.0 is rolling out. */
  async resolve(profileName: 'files-primary'): Promise<{ profile: StorageProfile; provider: StorageProvider }> {
    const legacyId = '00000000-0000-4000-8000-000000000003'
    try {
      const resolved = await this.resolveConnection(legacyId)
      return {
        profile: { profile: profileName, purpose: 'files', provider: resolved.connection.provider, chatId: resolved.connection.chatId },
        provider: resolved.provider
      }
    } catch (error) {
      const row = await this.env.DB.prepare(
        'SELECT profile, purpose, provider, chat_id FROM storage_profiles WHERE profile = ? AND purpose = ? AND enabled = 1 LIMIT 1'
      ).bind(profileName, 'files').first<{ profile: string; purpose: StoragePurpose; provider: string; chat_id: string | null }>()
      if (!row?.chat_id) throw error
      const token = this.env.TELEGRAM_BOT_TOKEN
      if (!token || token === 'UNCONFIGURED') throw new Error('FILES_TELEGRAM_SECRET_NOT_CONFIGURED')
      if (row.provider !== 'telegram') throw new Error(`STORAGE_PROVIDER_UNSUPPORTED_${row.provider.toUpperCase()}`)
      return {
        profile: { profile: row.profile, purpose: 'files', provider: row.provider, chatId: row.chat_id },
        provider: new TelegramStorage(token, row.chat_id)
      }
    }
  }

  async listConnections(organizationId: string): Promise<Array<{
    id: string
    name: string
    provider: string
    telegramBotId: string | null
    telegramBotUsername: string | null
    telegramBotName: string | null
    chatId: string | null
    chatTitle: string | null
    status: string
    credentialSource: string
    lastHealthCheckAt: string | null
    lastError: string | null
  }>> {
    const result = await this.env.DB.prepare(
      `SELECT id, name, provider, telegram_bot_id, telegram_bot_username, telegram_bot_name,
              chat_id, chat_title, status, credential_source, last_health_check_at, last_error
         FROM storage_connections
        WHERE organization_id = ? ORDER BY created_at ASC`
    ).bind(organizationId).all<Record<string, unknown>>()
    return result.results.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      provider: String(row.provider),
      telegramBotId: row.telegram_bot_id == null ? null : String(row.telegram_bot_id),
      telegramBotUsername: row.telegram_bot_username == null ? null : String(row.telegram_bot_username),
      telegramBotName: row.telegram_bot_name == null ? null : String(row.telegram_bot_name),
      chatId: row.chat_id == null ? null : String(row.chat_id),
      chatTitle: row.chat_title == null ? null : String(row.chat_title),
      status: String(row.status),
      credentialSource: String(row.credential_source),
      lastHealthCheckAt: row.last_health_check_at == null ? null : String(row.last_health_check_at),
      lastError: row.last_error == null ? null : String(row.last_error)
    }))
  }

  async status(organizationId?: string): Promise<Array<{
    id?: string
    profile: string
    purpose: StoragePurpose
    provider: string
    configured: boolean
    reachable: boolean
    detail?: string
  }>> {
    if (organizationId) {
      const connections = await this.listConnections(organizationId)
      const states = [] as Array<{ id?: string; profile: string; purpose: StoragePurpose; provider: string; configured: boolean; reachable: boolean; detail?: string }>
      for (const item of connections) {
        if (item.status === 'DISABLED') {
          states.push({ id: item.id, profile: item.name, purpose: 'files', provider: item.provider, configured: false, reachable: false, detail: 'STORAGE_CONNECTION_DISABLED' })
          continue
        }
        try {
          const resolved = await this.resolveConnection(item.id)
          const state = await resolved.provider.status()
          states.push({ id: item.id, profile: item.name, purpose: 'files', provider: item.provider, configured: true, reachable: state.reachable, detail: state.detail })
        } catch (error) {
          states.push({ id: item.id, profile: item.name, purpose: 'files', provider: item.provider, configured: Boolean(item.chatId), reachable: false, detail: error instanceof Error ? error.message : 'STORAGE_UNAVAILABLE' })
        }
      }
      return states
    }

    try {
      const resolved = await this.resolve('files-primary')
      const state = await resolved.provider.status()
      return [{ profile: 'files-primary', purpose: 'files', provider: resolved.profile.provider, configured: true, reachable: state.reachable, detail: state.detail }]
    } catch (error) {
      return [{ profile: 'files-primary', purpose: 'files', provider: 'telegram', configured: false, reachable: false, detail: error instanceof Error ? error.message : 'STORAGE_UNAVAILABLE' }]
    }
  }
}
