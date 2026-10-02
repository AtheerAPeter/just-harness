import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Dependencies are bundled in, not loaded from node_modules at runtime: one
    // file starts faster than hundreds of small ones read out of the asar.
    build: { externalizeDeps: false, minify: true },
    resolve: {
      alias: {
        // Playwright's in-page runtime, bundled into the main process. Its package
        // does not export this file, so it is resolved by path (the version is pinned).
        'playwright-injected-script': resolve(
          'node_modules/playwright-core/lib/generated/injectedScriptSource.js'
        )
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Imports nothing but `electron`, so it builds to one file: a sandboxed
          // preload cannot load other files.
          page: resolve('src/preload/page.ts')
        },
        // Browser pages are sandboxed, and a sandboxed preload must be a plain
        // CommonJS script. `.cjs` because package.json declares "type": "module".
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // electron-vite leaves output unminified by default; the renderer loads faster minified.
    build: { minify: true }
  }
})
