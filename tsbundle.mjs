/* ============================================================================
   EPROSTA — test bundler, with a fallback that needs no network
   ----------------------------------------------------------------------------
   Every harness in this repo boots the app's real modules by bundling them to
   one ESM file. That was done with `npx esbuild`, which fetches esbuild on
   first run — fine on a laptop, impossible on a machine whose npm registry is
   locked down, which is where a lot of this work actually happens. A harness
   that cannot run is a harness nobody runs.

   So three tries, in order: esbuild if it is already installed; then
   rolldown, which vite depends on and which therefore exists on any machine
   that can run the app at all; and failing both, TypeScript's own
   `transpileModule` (typescript is a devDependency too, and the
   app's tsc build is the thing that would catch a type error anyway — the
   bundle only has to EXECUTE). The fallback emits one .mjs per source file,
   mirroring the tree, and rewrites specifiers: `@/x` to a relative path, and
   every extensionless relative import to its emitted `.mjs`.

   Types are erased, not checked. Run `tsc -b --noEmit` for that.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve a specifier the way Vite does here: `@` is `src`, extension optional. */
function resolveSpec(spec, fromFile, srcRoot) {
  let base;
  if (spec.startsWith('@/')) base = join(srcRoot, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  // Harness entry files name modules by absolute path.
  else if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) base = spec;
  else return null; // bare package — left alone, node resolves it
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && !cand.endsWith('/')) {
      try {
        if (readFileSync(cand) !== null && !cand.endsWith('.d.ts')) return cand;
      } catch { /* directory */ }
    }
  }
  return null;
}

const SPEC_RE = /(\bfrom\s*|\bimport\s*|\bexport\s*\*\s*(?:as\s+\w+\s+)?from\s*|\bimport\()(['"])([^'"]+)\2/g;

function emit(file, srcRoot, outRoot, ctx) {
  if (ctx.seen.has(file)) return ctx.seen.get(file);
  const outFile = join(outRoot, `${relative(srcRoot, file).replace(/\.tsx?$/, '')}.mjs`);
  ctx.seen.set(file, outFile);

  const src = ctx.sources.get(file) ?? readFileSync(file, 'utf8');
  const js = ctx.ts.transpileModule(src, {
    compilerOptions: {
      target: ctx.ts.ScriptTarget.ES2022,
      module: ctx.ts.ModuleKind.ESNext,
      jsx: ctx.ts.JsxEmit.Preserve,
    },
    fileName: file,
  }).outputText;

  const rewritten = js.replace(SPEC_RE, (m, kw, q, spec) => {
    const target = resolveSpec(spec, file, srcRoot);
    if (!target) return m;
    const dep = emit(target, srcRoot, outRoot, ctx);
    let rel = relative(dirname(outFile), dep).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${kw}${q}${rel}${q}`;
  });

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rewritten);
  return outFile;
}

/**
 * Bundle `entryFile` (whose imports resolve as if it sat in `srcRoot`) and
 * return a file: URL to import.
 */
export async function bundleForTest({ entryFile, srcRoot, outDir, root }) {
  const out = join(outDir, 'bundle.mjs');
  try {
    execFileSync(
      'npx',
      ['--no-install', 'esbuild', entryFile, '--bundle', '--format=esm', `--outfile=${out}`,
        `--alias:@=${srcRoot}`, '--log-level=error'],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return pathToFileURL(out).href;
  } catch {
    /* No esbuild on hand. Transpile instead — see the header. */
  }

  // Second choice: rolldown, which vite already depends on, so it is sitting
  // in node_modules on any machine that can run the app. A real bundler, and
  // the same one the production build uses.
  try {
    const { rolldown } = await import('rolldown');
    const build = await rolldown({
      input: entryFile,
      resolve: { alias: { '@': srcRoot }, extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'] },
      platform: 'neutral',
    });
    await build.write({ file: out, format: 'esm', inlineDynamicImports: true });
    await build.close();
    return pathToFileURL(out).href;
  } catch {
    /* Not installed either — transpile, see the header. */
  }

  const tsPath = join(root, 'node_modules/typescript/lib/typescript.js');
  if (!existsSync(tsPath)) {
    throw new Error('Neither esbuild nor typescript is installed — run npm install first.');
  }
  const tsMod = await import(pathToFileURL(tsPath).href);
  const ts = tsMod.default || tsMod;

  // The entry is given a notional home inside srcRoot so that `@/x` and the
  // emitted mirror line up. It is never written to the repo — only its
  // contents are, into the temp output tree.
  const entryHome = join(srcRoot, '__test-entry__.ts');
  const ctx = { ts, seen: new Map(), sources: new Map([[entryHome, readFileSync(entryFile, 'utf8')]]) };
  return pathToFileURL(emit(entryHome, srcRoot, outDir, ctx)).href;
}
