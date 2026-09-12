// ata-vite: the Vite entry of unplugin-ata under its original name.
//
// Since 0.5.0 the schema loading, compilation and file emission live in
// unplugin-ata, which serves Vite, Webpack, Rollup, Rolldown, esbuild and
// Rspack from one implementation. This module keeps the ata-vite API: the
// default export is the Vite plugin factory, `compile` runs once outside
// Vite, and `__internal` is what the tests reach into.

import unplugin, { compile, __internal } from 'unplugin-ata'

export default function ataVite(userOptions = {}) {
  return unplugin.vite(userOptions)
}

export { compile, __internal }
