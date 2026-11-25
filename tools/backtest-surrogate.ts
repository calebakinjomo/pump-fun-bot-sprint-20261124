// Backtest the strategy on the OFFICIAL grade-local stress copies (blockDataset
// surrogates) that grade-local builds under /tmp/makefun-grade-*/work/stress-*/.
// Each blocks-NN dir holds a surrogate dataset (manifest.json + events/).
// This is the ground truth for the stress median — use it to iterate, not the
// coin-bootstrap proxy in tools/stress-local.ts (which resamples the wrong thing).
//
//   node tools/backtest-surrogate.ts <blocks-parent-glob...> ['{...params}']
//   e.g. node tools/backtest-surrogate.ts '/tmp/makefun-grade-*/work/stress-*/blocks-*'

import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const args = process.argv.slice(2);
const overrides = args.find((a) => a.startsWith('{')) !== undefined ? (JSON.parse(args.find((a) => a.startsWith('{'))!) as Partial<Params>) : {};
const patterns = args.filter((a) => !a.startsWith('{'));

// Expand globs the shell did not (patterns may contain *).
import { globSync } from 'node:fs';
const dirs: string[] = [];
for (const p of patterns) {
  const hits = globSync(p).filter((d) => {
    try { return readdirSync(d).includes('manifest.json'); } catch { return false; }
  });
  dirs.push(...hits);
}
dirs.sort();
if (dirs.length === 0) {
  console.error('no surrogate dirs found; pass e.g. /tmp/makefun-grade-*/work/stress-*/blocks-*');
  process.exit(2);
}

const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);
const params = { ...DEFAULT_PARAMS, ...overrides };

function loadSurrogate(dir: string): Dataset {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const all: any[] = [];
  for (const f of readdirSync(`${dir}/events`).sort()) {
    const raw = gunzipSync(readFileSync(`${dir}/events/${f}`)).toString('utf8');
    for (const l of raw.split('\n')) if (l.length > 0) all.push(JSON.parse(l));
  }
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  for (const e of all) {
    if (e.event === 'CreateEvent' && !members.has(e.mint)) {
      const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
      if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
        members.add(e.mint);
      }
    }
    if (members.has(e.mint)) events.push(e);
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { sha256: manifest.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? 0, batches };
}

const results: number[] = [];
for (const dir of dirs) {
  const ds = loadSurrogate(dir);
  const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
  const r = simulate(ds, hello, createStrategy(params));
  const pnl = Number(r.netPnl) / 1e9;
  results.push(pnl);
  console.log(`${dir.split('/').slice(-1)[0]}: net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${r.trips.filter((t) => t.pnl > 0n).length}  dd ${(r.maxDrawdown * 100).toFixed(1)}%`);
}
results.sort((a, b) => a - b);
const q = (p: number) => results[Math.min(results.length - 1, Math.floor(p * results.length))];
const median = results.length % 2 === 0 ? (results[results.length / 2 - 1]! + results[results.length / 2]!) / 2 : results[Math.floor(results.length / 2)]!;
console.log(`\nn=${results.length} median ${median.toFixed(4)}  p10 ${q(0.1).toFixed(4)}  p90 ${q(0.9).toFixed(4)}  losing ${results.filter((x) => x < 0).length}/${results.length}`);
