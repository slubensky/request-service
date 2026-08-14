// Production build for the no-bundler SSR app.
//
// This transpiles each TypeScript source file to JavaScript independently
// (via esbuild's per-file transform API) and copies static assets. It does
// NOT bundle: no module graph is merged into a single output file, and no
// dead-code elimination across files occurs -- each source file maps 1:1 to
// an output file, exactly like `tsc`'s emit, just faster and without running
// the type checker. Editors/CI rely on `tsconfig.json` for type awareness;
// this build intentionally stays fast and safe to run anywhere.
import { readdir, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

async function collectTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(fullPath)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function buildFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
    sourcefile: filePath,
  });
  const relativePath = path.relative(srcDir, filePath);
  const outPath = path.join(distDir, relativePath).replace(/\.ts$/, '.js');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, code, 'utf8');
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const tsFiles = await collectTsFiles(srcDir);
  await Promise.all(tsFiles.map(buildFile));

  await cp(path.join(rootDir, 'public'), path.join(distDir, 'public'), { recursive: true });

  // eslint-disable-next-line no-console -- build script summary output is expected.
  console.log(`Built ${tsFiles.length} source files and copied public assets to ${distDir}`);
}

await main();
