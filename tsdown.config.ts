import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

const CSS_PREFIX = '\0observatory-css:'
const CSS_SUFFIX = '.mjs'

type BuildPlugin = NonNullable<UserConfig['plugins']>

function cssPlugin(): BuildPlugin {
  return {
    name: 'observatory-css-inline',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.css')) return null
      const path = source.startsWith('.') && importer !== undefined
        ? resolve(dirname(importer), source)
        : source
      return `${CSS_PREFIX}${path}${CSS_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(path)
      const source = await readFile(path)
      const result = transform({
        filename: path,
        code: source,
        minify: true,
        cssModules: path.endsWith('.module.css') ? { pattern: 'obs_[hash]_[local]' } : undefined,
      })
      const classes: Record<string, string> = {}
      for (const [name, value] of Object.entries(result.exports ?? {})) classes[name] = value.name
      const tagId = `dsh-observatory/${basename(path)}`
      return [
        `const cssText = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        "  tag.dataset.plugin = 'dsh-observatory';",
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = cssText;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
    plugins: [cssPlugin()],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: "window.__ModuleLoader__.load({ id: 'dsh-observatory', factory: (require) => {",
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
] satisfies UserConfig[]
