// Full-window backtest: loads ALL THREE dataset parts of the dev window (24h)
// with the same sample filter as the sim, then runs the strategy through the
// local replay port (tools/sim.ts). Also supports window slices and seed sweeps
// for a cheap robustness check before grade-local --stress.
//
//   node tools/backtest.ts <kit dir> ['{...params}'] [--trips] [--part0|--part12|--full]
//   node tools/backtest.ts <kit dir> --sweep   (runs full + part0 + part12 + 5 seeds)

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips] [--part0|--part12|--full] [--sweep]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};

function loadParts(kitDir: string, parts: string[]): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const all: any[] = [];
  for (const part of parts) {
    const raw = gunzipSync(readFileSync(`${kitDir}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
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
  return { sha256: kitJson.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? all[all.length - 1].slot, batches };
}

const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);

function run(label: string, ds: Dataset, seedSuffix: string, params: Params) {
  const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256 + seedSuffix));
  const r = simulate(ds, hello, createStrategy(params));
  const top3 = [...r.perMint.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
  const top3sum = top3.reduce((s, [, v]) => s + v, 0n);
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  console.log(
    `${label}: net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins}  dd ${(r.maxDrawdown * 100).toFixed(1)}%  rejected ${r.rejected}  failed ${r.failed}  ex-top3 ${sol(r.netPnl - top3sum)}`,
  );
  return r;
}

const params = { ...DEFAULT_PARAMS, ...overrides };
const sweep = process.argv.includes('--sweep');
const slice = process.argv.includes('--part0') ? ['part-00000'] : process.argv.includes('--part12') ? ['part-00001', 'part-00002'] : ['part-00000', 'part-00001', 'part-00002'];

if (sweep) {
  const full = loadParts(kit, ['part-00000', 'part-00001', 'part-00002']);
  run('full24h        ', full, '', params);
  run('part0 (~11h)   ', loadParts(kit, ['part-00000']), '', params);
  run('part12 (~13h)  ', loadParts(kit, ['part-00001', 'part-00002']), '', params);
  for (let s = 1; s <= 5; s++) run(`seed${s} full24h  `, full, `s${s}`, params);
  const noFail = simulate(full, makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', full.sha256)), createStrategy(params), { failKey: null });
  console.log(`no-fail-tx full24h: net ${sol(noFail.netPnl)} SOL`);
  const twoX = simulate(full, makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', full.sha256)), createStrategy(params), { feeMultiplier: 2n });
  console.log(`2x-fees full24h:    net ${sol(twoX.netPnl)} SOL`);
} else {
  const ds = loadParts(kit, slice);
  const r = run(slice.join('+'), ds, '', params);
  if (process.argv.includes('--trips')) {
    for (const t of r.trips) console.log(t.mint.slice(0, 8), t.open, t.close - t.open, sol(t.pnl));
  }
}
