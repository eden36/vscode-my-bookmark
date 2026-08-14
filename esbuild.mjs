import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  }),
  esbuild.context({
    ...common,
    entryPoints: ['test/integration/index.ts'],
    outfile: 'dist-test/integration.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('正在监听文件变化。');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
