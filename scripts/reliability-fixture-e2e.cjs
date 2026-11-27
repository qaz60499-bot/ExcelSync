#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const artifactRoot = process.env.EXCELSYNC_REAL_E2E_ARTIFACT_ROOT || path.join(root, 'test-artifacts', 'reliability-20261125', 'real-e2e')
const reportPath = path.join(artifactRoot, 'fixture-e2e-report.json')
const source = path.join(root, 'tests', 'fixtures', 'reliability-engine-entry.ts')
const bundled = path.join(artifactRoot, 'reliability-engine-entry.cjs')

function redact(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret)\s*[:=]\s*[^\s&,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[LOCAL_PATH]').slice(0, 240)
}

function launch() {
  if (process.argv.length !== 3 || process.argv[2] !== '--fixture-sync') {
    throw new Error('Usage: node scripts/reliability-fixture-e2e.cjs --fixture-sync')
  }
  fs.mkdirSync(artifactRoot, { recursive: true })
  buildSync({
    entryPoints: [source], outfile: bundled, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    packages: 'external', external: ['electron']
  })
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electron)) throw new Error('Installed Electron binary is missing.')
  const child = spawnSync(electron, [bundled], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 360_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, EXCELSYNC_PROJECT_ROOT: root, EXCELSYNC_REAL_E2E_ARTIFACT_ROOT: artifactRoot,
      EXCELSYNC_REAL_E2E_REPORT: reportPath, EXCELSYNC_ALLOW_REAL_FIXTURE: '1' }
  })
  let report = null
  if (fs.existsSync(reportPath)) report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  process.stdout.write(`${JSON.stringify({ exitCode: child.status, reportPath, report,
    launchError: child.error ? redact(child.error.message) : null }, null, 2)}\n`)
  if (child.status !== 0 || !report?.ok) process.exitCode = 1
}

try { launch() } catch (error) { process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 1 }
