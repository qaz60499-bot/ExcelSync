import { pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashPassword, newSessionToken, sha256Hex, sha256Text, verifyPassword } from '../worker/src/auth'

describe('worker authentication primitives', () => {
  it('hashes passwords without storing plaintext and verifies the right password', async () => {
    const password = 'correct-horse-battery-staple'
    const encoded = await hashPassword(password)
    expect(encoded).toContain('pbkdf2-sha256$')
    expect(encoded).not.toContain(password)
    expect(await verifyPassword(password, encoded)).toBe(true)
    expect(await verifyPassword('wrong-password-value', encoded)).toBe(false)
  })

  it('accepts a standards-compatible PBKDF2-SHA256 hash generated outside the Worker', async () => {
    const password = 'external-compatible-password'
    const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const derived = pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
    const toBase64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url')
    const encoded = `pbkdf2-sha256$100000$${toBase64Url(salt)}$${toBase64Url(derived)}`
    expect(await verifyPassword(password, encoded)).toBe(true)
  })

  it('rejects passwords below the minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow('PASSWORD_POLICY')
  })

  it('creates high-entropy opaque session tokens', () => {
    const first = newSessionToken()
    const second = newSessionToken()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(40)
    expect(first).not.toMatch(/[+/=]/)
  })

  it('produces stable SHA256 text and binary digests', async () => {
    expect(await sha256Text('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
