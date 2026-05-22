// ata-vite: Vite plugin for build-time JSON Schema compilation.
//
// For each JSON schema matched by `schemas`, emit:
//   - <base>.validator.mjs      (self-contained validator)
//   - <base>.validator.d.mts    (TypeScript declarations, opt-in)
//
// Runs on `buildStart` and on file changes in dev mode. Output is written
// to disk so TypeScript and downstream imports see real files.

import fs from 'node:fs/promises'
import path from 'node:path'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { tsconfigPaths: true })

const DEFAULT_OPTIONS = {
  schemas: 'schemas/**/*.json',
  outDir: null, // default: alongside each input
  format: 'esm',
  abortEarly: false,
  types: true,
  nameFromFile: (file) => {
    const base = path.basename(file, path.extname(file))
    const cleaned = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]/, '_$&')
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  },
}

async function loadAta() {
  // Resolve ata-validator at runtime so peer-dep works cleanly across package managers.
  const mod = await import('ata-validator')
  const api = mod.default ?? mod
  if (!api.Validator || !api.toTypeScript) {
    throw new Error(
      'ata-vite requires ata-validator >= 0.11.1 with a public toTypeScript export.',
    )
  }
  return api
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [value]
}

async function resolveSchemaFiles(patterns, root) {
  // Node 22+ ships fs.glob. Fall back to a recursive walk for older runtimes.
  if (typeof fs.glob === 'function') {
    const found = []
    for (const pattern of ensureArray(patterns)) {
      for await (const hit of fs.glob(pattern, { cwd: root })) {
        found.push(path.resolve(root, hit))
      }
    }
    return [...new Set(found)]
  }

  const matched = new Set()
  for (const pattern of ensureArray(patterns)) {
    const anchor = path.resolve(root, pattern.split('*')[0] || '.')
    let stack
    try {
      const stat = await fs.stat(anchor)
      stack = stat.isDirectory() ? [anchor] : [path.dirname(anchor)]
    } catch {
      continue
    }
    const re = globToRegExp(pattern)
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        const rel = path.relative(root, abs).split(path.sep).join('/')
        if (e.isDirectory()) stack.push(abs)
        else if (re.test(rel)) matched.add(abs)
      }
    }
  }
  return [...matched]
}

function globToRegExp(pattern) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    // `**/` matches zero or more path segments, so schemas/**/*.json
    // also picks up files that live directly in schemas/.
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

function outputPaths(schemaFile, options, root) {
  const dir = options.outDir
    ? path.resolve(root, options.outDir, path.dirname(path.relative(root, schemaFile)))
    : path.dirname(schemaFile)
  const base = path.basename(schemaFile, path.extname(schemaFile))
  const mjs = path.join(dir, `${base}.validator.${options.format === 'cjs' ? 'cjs' : 'mjs'}`)
  const dts = path.join(dir, `${base}.validator.${options.format === 'cjs' ? 'd.cts' : 'd.mts'}`)
  return { dir, mjs, dts }
}

async function writeIfChanged(file, contents) {
  try {
    const existing = await fs.readFile(file, 'utf8')
    if (existing === contents) return false
  } catch { /* file missing, write fresh */ }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  return true
}

async function compileOne(schemaFile, options, root, api, logger) {
  let schema
  try {
    schema = await jiti.import(schemaFile, { default: true })
  } catch (err) {
    logger?.warn?.(`[ata-vite] cannot parse ${path.relative(root, schemaFile)}: ${err.message}`)
    return { changed: false, typeName: null, paths: null }
  }

  const v = new api.Validator(schema)
  const validatorSrc = v.toStandaloneModule({ format: options.format, abortEarly: options.abortEarly })
  if (!validatorSrc) {
    logger?.warn?.(`[ata-vite] schema ${path.relative(root, schemaFile)} is too complex for standalone compilation`)
    return { changed: false, typeName: null, paths: null }
  }

  const typeName = options.nameFromFile(schemaFile)
  const paths = outputPaths(schemaFile, options, root)
  const mjsChanged = await writeIfChanged(paths.mjs, validatorSrc)

  let dtsChanged = false
  if (options.types) {
    const dtsSrc = api.toTypeScript(schema, { name: typeName })
    dtsChanged = await writeIfChanged(paths.dts, dtsSrc)
  }

  return { changed: mjsChanged || dtsChanged, typeName, paths }
}

export default function ataVite(userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions }
  let apiPromise = null
  let root = process.cwd()
  let logger = null

  async function compileAll() {
    const api = await (apiPromise ??= loadAta())
    const files = await resolveSchemaFiles(options.schemas, root)
    const results = []
    for (const file of files) {
      results.push(await compileOne(file, options, root, api, logger))
    }
    return { files, results }
  }

  async function compileIfMatching(file) {
    if (!file) return null
    const api = await (apiPromise ??= loadAta())
    const files = await resolveSchemaFiles(options.schemas, root)
    if (!files.some((f) => path.resolve(f) === path.resolve(file))) return null
    return compileOne(file, options, root, api, logger)
  }

  return {
    name: 'ata-vite',
    enforce: 'pre',

    configResolved(config) {
      root = config.root || process.cwd()
      logger = config.logger
    },

    async buildStart() {
      const { files, results } = await compileAll()
      const changed = results.filter((r) => r.changed).length
      logger?.info?.(`[ata-vite] compiled ${files.length} schema(s), ${changed} file(s) written`)
    },

    async handleHotUpdate(ctx) {
      const result = await compileIfMatching(ctx.file)
      if (result && result.changed) {
        logger?.info?.(`[ata-vite] recompiled ${path.relative(root, ctx.file)}`)
      }
      return undefined
    },

    async watchChange(id) {
      // Generic rollup hook, used outside dev server contexts.
      await compileIfMatching(id)
    },
  }
}

// Programmatic entry for custom build scripts.
export async function compile(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const root = options.root ?? process.cwd()
  const api = await loadAta()
  const files = await resolveSchemaFiles(opts.schemas, root)
  const results = []
  for (const file of files) {
    results.push(await compileOne(file, opts, root, api, null))
  }
  return { files, results }
}

export const __internal = { loadAta, resolveSchemaFiles, compileOne, outputPaths, globToRegExp }
