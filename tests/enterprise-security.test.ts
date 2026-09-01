import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from '../worker/src/credential-crypto'
import { isOwner, isSystemAdmin, workspaceRoleAtLeast, type AuthUser } from '../worker/src/access'

const baseUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'member',
  displayName: 'Member',
  organizationId: '22222222-2222-4222-8222-222222222222',
  systemRole: 'MEMBER',
  status: 'ACTIVE'
}

describe('ExcelSync 1.3 enterprise security primitives', () => {
  it('keeps system roles separate from workspace roles', () => {
    expect(isSystemAdmin({ ...baseUser, systemRole: 'OWNER' })).toBe(true)
    expect(isSystemAdmin({ ...baseUser, systemRole: 'ADMIN' })).toBe(true)
    expect(isSystemAdmin(baseUser)).toBe(false)
    expect(isOwner({ ...baseUser, systemRole: 'OWNER' })).toBe(true)
    expect(isOwner({ ...baseUser, systemRole: 'ADMIN' })).toBe(false)

    expect(workspaceRoleAtLeast('VIEWER', 'VIEWER')).toBe(true)
    expect(workspaceRoleAtLeast('VIEWER', 'EDITOR')).toBe(false)
    expect(workspaceRoleAtLeast('EDITOR', 'EDITOR')).toBe(true)
    expect(workspaceRoleAtLeast('EDITOR', 'MANAGER')).toBe(false)
    expect(workspaceRoleAtLeast('MANAGER', 'VIEWER')).toBe(true)
    expect(workspaceRoleAtLeast('MANAGER', 'EDITOR')).toBe(true)
    expect(workspaceRoleAtLeast('MANAGER', 'MANAGER')).toBe(true)
  })

  it('encrypts Telegram credentials with AES-GCM and never embeds plaintext in ciphertext or IV', async () => {
    const master = 'test-master-key-that-is-longer-than-thirty-two-characters'
    const token = 'telegram-test-credential-value-without-real-token-shape'
    const first = await encryptCredential(master, token)
    const second = await encryptCredential(master, token)

    expect(first.ciphertext).not.toContain(token)
    expect(first.iv).not.toContain(token)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.iv).not.toBe(second.iv)
    expect(await decryptCredential(master, first.ciphertext, first.iv)).toBe(token)
    await expect(decryptCredential(`${master}-wrong`, first.ciphertext, first.iv)).rejects.toThrow('STORAGE_CREDENTIAL_DECRYPT_FAILED')
  })

  it('requires a sufficiently strong storage master secret', async () => {
    await expect(encryptCredential('too-short', 'telegram-token')).rejects.toThrow('STORAGE_MASTER_KEY_NOT_CONFIGURED')
  })

  it('migration establishes workspace ownership and version-level storage routing without dropping legacy metadata', async () => {
    const sql = await readFile(new URL('../migrations/0006_enterprise_workspaces.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS organizations')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspaces')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_members')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS storage_connections')
    expect(sql).toContain('ALTER TABLE files ADD COLUMN workspace_id')
    expect(sql).toContain('ALTER TABLE file_versions ADD COLUMN storage_connection_id')
    expect(sql).toContain('ALTER TABLE upload_intents ADD COLUMN storage_connection_id')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS tasks')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_logs')
    expect(sql).not.toMatch(/DROP\s+TABLE\s+(users|file_versions|files)/i)
  })
})
