import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const output = await build({ entryPoints: ['src/action.ts'], bundle: true, platform: 'node', target: 'node24',
  format: 'cjs', outfile: 'dist/index.js', write: false, legalComments: 'eof', charset: 'utf8', metafile: true });
const validator = await build({ entryPoints: ['examples/validate.mjs'], bundle: true, platform: 'node', target: 'node24',
  format: 'cjs', outfile: 'dist/validate.cjs', write: false, legalComments: 'eof', charset: 'utf8', metafile: true });
const packages = new Set();
const analyzer = await build({ entryPoints: ['scripts/analyze-shadow.mjs'], bundle: true, platform: 'node', target: 'node24',
  format: 'esm', outfile: 'dist/analyze-shadow.mjs', write: false, legalComments: 'eof', charset: 'utf8', metafile: true });
for (const input of [...Object.keys(output.metafile.inputs), ...Object.keys(validator.metafile.inputs), ...Object.keys(analyzer.metafile.inputs)]) {
  if (!input.startsWith('node_modules/')) continue;
  const segments = input.split('/');
  packages.add(segments.slice(0, segments[1].startsWith('@') ? 3 : 2).join('/'));
}
const licenses = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory)).filter(file => /^(licen[sc]e|notice|copyright)(\.|$)/i.test(file)).sort();
  if (!files.length) throw new Error(`No license file found for ${pkg.name}`);
  licenses.push(`${pkg.name}@${pkg.version}\n${(await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n')}`);
}
const artifacts = { 'dist/index.js': Buffer.from(output.outputFiles[0].contents),
  'dist/validate.cjs': Buffer.from(validator.outputFiles[0].contents),
  'dist/analyze-shadow.mjs': Buffer.from(analyzer.outputFiles[0].contents),
  'dist/licenses.txt': Buffer.from(licenses.join('\n\n---\n\n') + '\n') };
if (process.argv.includes('--check')) {
  for (const [path, bytes] of Object.entries(artifacts)) {
    if (!(await readFile(path)).equals(bytes)) throw new Error(`${path} is stale; run npm run build`);
  }
  console.log('dist/ matches source and locked dependencies');
} else {
  for (const [path, bytes] of Object.entries(artifacts)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}
