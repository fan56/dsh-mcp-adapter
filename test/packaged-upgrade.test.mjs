// Regression for the npm upgrade path: pnpm 11 (strictDepBuilds) refuses an
// install whose dependency carries an unapproved preinstall/install/postinstall
// script, so the dsh host plugin manager rolls the plugin update back with
// ERR_PNPM_IGNORED_BUILDS. This repo's dev closure linking rides the
// `prepare` hook instead — npm and pnpm never run `prepare` for registry
// dependencies — so the published package carries no install hook at all.
// This test reproduces the upgrade path: install the published 0.8.1
// baseline, upgrade it to the locally packed tarball, and assert the new
// package has no install hook, still ships its bundle patch and entry, and
// still leaves the consumer tree alone.
// Run: node test/packaged-upgrade.test.mjs  (after `npm run build`; needs
// network access to registry.npmjs.org for the 0.8.1 baseline)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
// Windows needs cmd.exe to launch npm's .cmd shim; keep paths as separate arguments.
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []
const registry = 'https://registry.npmjs.org'
const installHooks = ['preinstall', 'install', 'postinstall']

const own = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const pkgName = '@aiwayds/dsh-mcp-adapter'
// The published release the upgrade path starts from — the fix release that
// moved the install lifecycle hook to `prepare`.
const baselineVersion = '0.8.1'
const entry = 'lib/index.js'
const patchFile = 'cordis.patch.yml'

if (!existsSync(join(repoRoot, entry))) {
  throw new Error(`${entry} missing — run \`npm run build\` before the test chain`)
}

const scratch = mkdtempSync(join(tmpdir(), 'registry-packaged-upgrade-'))
try {
  const consumer = join(scratch, 'consumer')
  const installedDir = join(consumer, 'node_modules', ...pkgName.split('/'))
  const installedManifest = () => JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  // A failed guard must reach realpathSync and fail, even on machines without dsh.
  const env = { ...process.env, DSH_CLOSURE_DIR: join(scratch, 'missing-closure') }

  // 1. Baseline: the published 0.8.1, the release the upgrade path
  //    starts from. Pinned to the official registry so a dev mirror does not
  //    decide the fixture.
  const baseline = spawnSync(
    npm,
    [
      ...npmArgs,
      'install',
      `${pkgName}@${baselineVersion}`,
      '--prefix',
      consumer,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `--registry=${registry}`,
    ],
    { cwd: scratch, encoding: 'utf8', env },
  )
  assert.equal(baseline.status, 0, `baseline ${baselineVersion} install failed:\n${baseline.stdout}\n${baseline.stderr}`)
  assert.equal(installedManifest().version, baselineVersion, `baseline fixture is ${baselineVersion}`)

  // 2. Pack the repo the way CI's release job does. The tarball name comes
  //    from the filesystem, not stdout: npm still runs the root `prepare`
  //    hook during `npm pack`, so its log line corrupts `--json` output.
  //    A dedicated empty directory keeps the result unambiguous.
  const packDir = join(scratch, 'pack')
  mkdirSync(packDir)
  execFileSync(npm, [...npmArgs, 'pack', '--pack-destination', packDir], { cwd: repoRoot, encoding: 'utf8' })
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `pack emitted exactly one tarball, got ${tarballs.join(', ') || 'none'}`)
  const tarball = join(packDir, tarballs[0])

  // 3. Tarball manifest: the install-hook gate set is empty. `prepare` is
  //    carried in package.json but npm/pnpm never run it for registry
  //    dependencies — the published package has no lifecycle step to gate.
  const tarManifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  for (const key of installHooks) {
    assert.ok(!Object.hasOwn(tarManifest.scripts ?? {}, key), `tarball manifest carries no ${key} script (#10)`)
  }
  assert.equal(tarManifest.version, own.version, 'packed version matches the repo version')
  assert.equal(tarManifest.dsh?.bundle?.patch, own.dsh?.bundle?.patch, 'bundle patch still declared')

  // 4. Upgrade in place: the plugin manager's exact step. Must exit 0 and
  //    must not produce a pnpm-11 unapproved-build report (the regression
  //    class this test pins).
  const upgrade = spawnSync(
    npm,
    [...npmArgs, 'install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: scratch, encoding: 'utf8', env },
  )
  const output = `${upgrade.stdout ?? ''}\n${upgrade.stderr ?? ''}`
  assert.equal(upgrade.status, 0, `upgrade to the packed ${own.version} failed:\n${output}`)
  assert.ok(
    !/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output),
    `upgrade output carries a pnpm-11 unapproved-build report:\n${output}`,
  )

  const upgraded = installedManifest()
  assert.equal(upgraded.version, own.version, `upgrade landed ${own.version}`)
  for (const key of installHooks) {
    assert.ok(!Object.hasOwn(upgraded.scripts ?? {}, key), `installed manifest carries no ${key} script (#10)`)
  }
  // The upgrade really replaced the registry copy: npm records the local
  // tarball as a file: dependency, not a registry resolution.
  const consumerManifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'))
  assert.ok(
    String(consumerManifest.dependencies?.[pkgName] ?? '').startsWith('file:'),
    'the consumer now depends on the local tarball, not the registry copy',
  )
  assert.ok(existsSync(join(installedDir, patchFile)), 'bundle patch ships')
  assert.ok(existsSync(join(installedDir, entry)), 'plugin entry ships')

  // 5. Consumer safety unchanged: the linker did not touch the consumer tree,
  //    and no optional host SDK peer materialized a second copy.
  assert.ok(
    !existsSync(join(installedDir, 'node_modules', '@deepseek-ai')),
    'linker did not touch the consumer tree (guard markers held)',
  )
  assert.ok(
    !existsSync(join(consumer, 'node_modules', '@deepseek-ai')),
    'optional host SDK peers did not install a consumer-side copy',
  )
  console.log(`packaged-upgrade: ${baselineVersion} → packed ${own.version} upgrades cleanly with no install hook`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
