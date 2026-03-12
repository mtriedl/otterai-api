import esbuild from 'esbuild'

const production = process.argv.includes('production')
const watch = process.argv.includes('--watch')

const ctx = await esbuild.context({
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

if (watch) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
