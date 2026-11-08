// Local cold-module CPU comparison; no provider calls or application data access.
// Run: node --experimental-strip-types scripts/server-cpu-benchmark.mjs [baseline-ref]
import { execFileSync, spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const target = new URL('../lib/googleSheets.ts', import.meta.url).href;
const childMode = process.argv[2];
if (childMode === '--child') {
  const original = process.argv[3] === 'baseline'
    ? execFileSync('git', ['show', `${process.argv[4] ?? 'HEAD'}:lib/googleSheets.ts`], { encoding: 'utf8' }) : null;
  let sdkLoaded = false;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('googleapis/')) {
        sdkLoaded = true;
        if (specifier === 'googleapis/build/src/apis/sheets') return nextResolve(`${specifier}/index.js`, context);
      }
      if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith(new URL('../lib/', import.meta.url).href) && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (original && url === target) return { format: 'module-typescript', source: original, shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  const cpu = process.cpuUsage();
  const started = performance.now();
  await import(original ? target : new URL('../lib/sheetRosterSnapshot.ts', import.meta.url).href);
  const elapsed = performance.now() - started;
  const used = process.cpuUsage(cpu);
  hooks.deregister();
  console.log(JSON.stringify({ cpuMs: (used.user + used.system) / 1000, elapsedMs: elapsed, sdkLoaded }));
} else {
  const samples = {};
  // Alternate order to reduce filesystem cache/order bias.
  for (let run = 0; run < 5; run++) for (const mode of run % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url), '--child', mode, process.argv[2] ?? 'HEAD'], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    (samples[mode] ??= []).push(JSON.parse(child.stdout));
  }
  const mean = (values, key) => values.reduce((sum, value) => sum + value[key], 0) / values.length;
  console.log(JSON.stringify(Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, {
    meanCpuMs: mean(values, 'cpuMs'), meanElapsedMs: mean(values, 'elapsedMs'),
    sdkLoaded: values.some(value => value.sdkLoaded), samples: values,
  }])), null, 2));
}
