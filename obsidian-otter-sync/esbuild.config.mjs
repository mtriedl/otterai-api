import esbuild from 'esbuild'

const production = process.argv.includes('production')

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: production ? false : 'inline',
  minify: production,
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view'],
})
