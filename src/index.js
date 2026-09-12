// ata-vite: the Vite entry of @ata-project/unplugin under its original name.
//
// Since 0.5.0 the schema loading, compilation and file emission live in
// @ata-project/unplugin, which serves Vite, Webpack, Rollup, Rolldown, esbuild and
// Rspack from one implementation. This module keeps the ata-vite API: the
// default export is the Vite plugin factory, `compile` runs once outside
// Vite, and `__internal` is what the tests reach into.

import unplugin, { compile, __internal } from '@ata-project/unplugin'

export default function ataVite(userOptions = {}) {
  return unplugin.vite(userOptions)
}

export { compile, __internal }
