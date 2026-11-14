import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  minify: !process.argv.includes('--dev'),
  external: ['electron'],
  logLevel: 'info'
};

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.js',
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  }
});

await build({
  ...common,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload/preload.cjs',
  format: 'cjs'
});

await build({
  ...common,
  sourcemap: false,
  entryPoints: ['src/mcp/server.ts'],
  outfile: 'dist/mcp/mr-mail-mcp.cjs',
  format: 'cjs'
});

if (watch) console.log('Klart.');
