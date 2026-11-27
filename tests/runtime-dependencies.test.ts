import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { runtimeDependencies } = createRequire(import.meta.url)('../scripts/runtime-dependencies.cjs')

describe('supply-chain runtime reachability', () => {
  it('includes the shipped Electron runtime and bundled ExcelJS dependencies despite dev flags', () => {
    const packages = {
      'node_modules/electron': { dev: true, dependencies: { installer: '1' } },
      'node_modules/installer': { dev: true },
      'node_modules/exceljs': { dev: true, dependencies: { archive: '1' } },
      'node_modules/archive': { dev: true, dependencies: { glob: '1' } },
      'node_modules/glob': { dev: true, dependencies: { braces: '1' } },
      'node_modules/glob/node_modules/braces': { dev: true },
      'node_modules/braces': { dev: true },
      'node_modules/vite': { dev: true }
    }
    expect([...runtimeDependencies({}, packages, ['exceljs'])].sort()).toEqual([
      'node_modules/archive', 'node_modules/electron', 'node_modules/exceljs',
      'node_modules/glob', 'node_modules/glob/node_modules/braces'
    ])
  })

  it('follows hoisted and optional production dependencies without looping on cycles', () => {
    const packages = {
      'node_modules/app': { dependencies: { child: '1' }, optionalDependencies: { optional: '1', missing: '1' } },
      'node_modules/app/node_modules/child': { dependencies: { app: '1' } },
      'node_modules/optional': {}
    }
    expect([...runtimeDependencies({ dependencies: { app: '1' } }, packages)].sort()).toEqual([
      'node_modules/app', 'node_modules/app/node_modules/child', 'node_modules/optional'
    ])
  })
})
