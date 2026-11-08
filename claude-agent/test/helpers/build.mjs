// Builds a TypeScript module for a test. Output goes under node_modules/.cache so bare imports (zod, the SDKs)
// resolve to this project's node_modules: one zod instance, shared with the real SDK, as in the production bundle.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = path.join(ROOT, 'node_modules', '.cache', 'claude-agent-tests');

/**
 * ESM build of src modules with their npm dependencies left external; returns the imported modules in order.
 * Built together with code splitting, so modules they share (and classes like RemoteFilesystemError) exist once,
 * as in the production bundle.
 */
export async function loadModules(...entries) {
  const outdir = path.join(CACHE, createHash('sha1').update(entries.join('|')).digest('hex').slice(0, 8));
  await build({
    entryPoints: entries.map(e => path.join(ROOT, e)), bundle: true, splitting: true, format: 'esm', platform: 'node',
    outdir, outbase: path.join(ROOT, 'src'), packages: 'external', logLevel: 'silent',
  });
  return Promise.all(entries.map(e => import(pathToFileURL(path.join(outdir, path.relative('src', e).replace(/\.ts$/, '.js'))).href)));
}

/** The production bundle of the extension (same settings as esbuild.mjs, SDK included), written to the cache. */
export async function buildExtension() {
  const outfile = path.join(CACHE, 'extension.cjs');
  // Test files run in parallel processes that all build this bundle: write elsewhere, then rename (atomic), so no
  // process ever loads a half-written file.
  const tmp = path.join(CACHE, `extension.${process.pid}.tmp.cjs`);
  await build({
    entryPoints: [path.join(ROOT, 'src/extension.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: tmp,
    external: ['vscode'], define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl=require('url').pathToFileURL(__filename).href;" }, logLevel: 'silent',
  });
  fs.renameSync(tmp, outfile);
  return outfile;
}
