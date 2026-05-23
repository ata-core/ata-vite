import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ataVite, { compile, __internal } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesRoot = path.join(here, 'fixtures')

async function cleanup() {
  const dir = path.join(fixturesRoot, 'schemas')
  const entries = await fs.readdir(dir)
  await Promise.all(
    entries
      .filter((e) => e.endsWith('.validator.mjs') || e.endsWith('.validator.cjs') || e.endsWith('.d.mts') || e.endsWith('.d.cts'))
      .map((e) => fs.unlink(path.join(dir, e))),
  )
  const outDir = path.join(fixturesRoot, 'generated')
  await fs.rm(outDir, { recursive: true, force: true })
}

describe('ata-vite', () => {
  before(cleanup)
  after(cleanup)

  it('programmatic compile writes validator + types', async () => {
    const result = await compile({
      schemas: 'schemas/*.json',
      root: fixturesRoot,
    })
    assert.equal(result.files.length, 2)
    assert(result.files.every((f) => f.endsWith('.json')))

    for (const file of result.files) {
      const base = path.basename(file, '.json')
      const dir = path.dirname(file)
      const mjs = await fs.readFile(path.join(dir, `${base}.validator.mjs`), 'utf8')
      const dts = await fs.readFile(path.join(dir, `${base}.validator.d.mts`), 'utf8')
      assert.match(mjs, /export \{ validate, isValid \}/)
      assert.match(dts, /export declare function isValid/)
    }
  })

  it('compiled validator accepts valid data and rejects invalid', async () => {
    await compile({ schemas: 'schemas/*.json', root: fixturesRoot })
    const mod = await import(path.join(fixturesRoot, 'schemas/user.validator.mjs'))
    assert.equal(mod.isValid({ id: 1, name: 'alice' }), true)
    assert.equal(mod.isValid({ id: -1, name: 'alice' }), false)
    assert.equal(mod.isValid({ name: 'alice' }), false)

    const r = mod.validate({ id: 1, name: 'alice', role: 'admin' })
    assert.equal(r.valid, true)
  })

  it('compiles a .js schema (default export) into a working validator', async () => {
    const result = await compile({ schemas: 'schemas/*.js', root: fixturesRoot })
    assert.equal(result.files.length, 1)
    assert(result.files[0].endsWith('product.js'))

    const mod = await import(path.join(fixturesRoot, 'schemas/product.validator.mjs'))
    assert.equal(mod.isValid({ sku: 'abc', price: 10 }), true)
    assert.equal(mod.isValid({ sku: '', price: 10 }), false, 'minLength must be enforced')
    assert.equal(mod.isValid({ sku: 'abc' }), false, 'required must be enforced')

    const dts = await fs.readFile(path.join(fixturesRoot, 'schemas/product.validator.d.mts'), 'utf8')
    assert.match(dts, /export declare function isValid/)
  })

  it('compiles a .ts schema via jiti into a working validator', async () => {
    const result = await compile({ schemas: 'schemas/account.ts', root: fixturesRoot })
    assert.equal(result.files.length, 1)
    assert(result.files[0].endsWith('account.ts'))

    const mod = await import(path.join(fixturesRoot, 'schemas/account.validator.mjs'))
    assert.equal(mod.isValid({ id: 1, email: 'a@b' }), true)
    assert.equal(mod.isValid({ id: 0, email: 'a@b' }), false, 'minimum must be enforced')
    assert.equal(mod.isValid({ email: 'a@b' }), false, 'required must be enforced')
  })

  it('resolves tsconfig path aliases in a .ts schema', async () => {
    const result = await compile({ schemas: 'schemas/aliased.ts', root: fixturesRoot })
    assert.equal(result.files.length, 1)

    const mod = await import(path.join(fixturesRoot, 'schemas/aliased.validator.mjs'))
    assert.equal(mod.isValid({ id: 1 }), true)
    assert.equal(mod.isValid({ id: 0 }), false, 'minimum from the aliased fragment must apply')
    assert.equal(mod.isValid({}), false, 'required must be enforced')
  })

  it('resolves Vite resolve.alias in a .ts schema', async () => {
    const plugin = ataVite({ schemas: 'schemas/vite-aliased.ts' })
    plugin.configResolved({
      root: fixturesRoot,
      logger: { info() {}, warn() {} },
      resolve: {
        alias: [{ find: '@fields', replacement: path.join(fixturesRoot, 'shared/fields.ts') }],
      },
    })
    await plugin.buildStart()

    const mod = await import(path.join(fixturesRoot, 'schemas/vite-aliased.validator.mjs'))
    assert.equal(mod.isValid({ id: 1 }), true)
    assert.equal(mod.isValid({ id: 0 }), false, 'minimum from the aliased fragment must apply')
  })

  it('outDir relocates generated files outside the source tree', async () => {
    const outRel = 'generated'
    const result = await compile({
      schemas: 'schemas/*.json',
      outDir: outRel,
      root: fixturesRoot,
    })
    assert.equal(result.files.length, 2)
    const outAbs = path.join(fixturesRoot, outRel)
    const entries = await fs.readdir(path.join(outAbs, 'schemas'))
    assert(entries.includes('user.validator.mjs'))
    assert(entries.includes('user.validator.d.mts'))
    assert(entries.includes('order.validator.mjs'))
  })

  it('abortEarly shrinks the output', async () => {
    await compile({ schemas: 'schemas/*.json', root: fixturesRoot })
    const standard = await fs.stat(path.join(fixturesRoot, 'schemas/user.validator.mjs'))
    await compile({ schemas: 'schemas/*.json', root: fixturesRoot, abortEarly: true })
    const tiny = await fs.stat(path.join(fixturesRoot, 'schemas/user.validator.mjs'))
    assert(tiny.size < standard.size, `abort-early should be smaller (${tiny.size} vs ${standard.size})`)
  })

  it('writeIfChanged skips rewriting identical output', async () => {
    const run1 = await compile({ schemas: 'schemas/*.json', root: fixturesRoot })
    const first = run1.results.filter((r) => r.changed).length
    const run2 = await compile({ schemas: 'schemas/*.json', root: fixturesRoot })
    const second = run2.results.filter((r) => r.changed).length
    assert(first > 0, 'first run should write files')
    assert.equal(second, 0, 'second run should be idempotent')
  })

  it('plugin has the Vite hook surface', () => {
    const plugin = ataVite({ schemas: 'schemas/*.json' })
    assert.equal(plugin.name, 'ata-vite')
    assert.equal(typeof plugin.buildStart, 'function')
    assert.equal(typeof plugin.handleHotUpdate, 'function')
    assert.equal(typeof plugin.watchChange, 'function')
    assert.equal(typeof plugin.configResolved, 'function')
  })

  it('globToRegExp: `**/` matches zero or more path segments', () => {
    const re = __internal.globToRegExp('schemas/**/*.json')
    assert.equal(re.test('schemas/user.json'), true, 'root-level file must match')
    assert.equal(re.test('schemas/sub/user.json'), true, 'one-level nested must match')
    assert.equal(re.test('schemas/a/b/c/user.json'), true, 'deep nested must match')
    assert.equal(re.test('schemas/user.txt'), false, 'non-json must not match')
    assert.equal(re.test('other/user.json'), false, 'outside base must not match')
  })
})
