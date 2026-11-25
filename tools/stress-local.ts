// Local block-bootstrap stress proxy: mirrors grade-local --stress, which rebuilds
// copies of the dev window from blocks of trades the window itself shows.
// Each copy draws the universe's coin-blocks with replacement (a coin drawn twice
// replays as a second, distinct coin), merges them in slot order and runs the sim.
//
//   node tools/stress-local.ts <kit dir> ['{...params}'] [copies=20]

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { makeHello, phaseSeed, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/stress-local.ts <kit dir> [params json] [copies]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const copiesArg = process.argv[4] ?? (process.argv[3] !== undefined && !process.argv[3].startsWith('{') ? process.argv[3] : '20');
const copies = Number(copiesArg) || 20;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
const all: any[] = [];
for (const part of ['part-00000', 'part-00001', 'part-00002']) {
  const raw = gunzipSync(readFileSync(`${kit}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
  for (const l of raw.split('\n')) if (l.length > 0) all.push(JSON.parse(l));
}
const { modulus, residue } = manifest.universe.sample;
const excluded = new Set<string>(manifest.excluded_mints ?? []);
const members = new Set<string>();
const blocks = new Map<string, any[]>();
for (const e of all) {
  if (e.event === 'CreateEvent' && !members.has(e.mint)) {
    const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
    if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
      members.add(e.mint);
    }
  }
  if (members.has(e.mint)) {
    const b = blocks.get(e.mint) ?? [];
    b.push(e);
    blocks.set(e.mint, b);
  }
}
const mints = [...blocks.keys()];
const N = mints.length;
console.log(`universe coins: ${N}`);

const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);
const params = { ...DEFAULT_PARAMS, ...overrides };

function runCopy(k: number): bigint {
  const rng = mulberry32(0x9e3779b9 ^ (k * 2654435761));
  const seen = new Map<string, number>();
  const events: any[] = [];
  for (let i = 0; i < N; i++) {
    const mint = mints[Math.floor(rng() * N)]!;
    const n = (seen.get(mint) ?? 0) + 1;
    seen.set(mint, n);
    // A duplicate draw replays as a distinct coin: swap its last base58 char
    // for a different one (never the original, never colliding in practice).
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let rename = mint;
    if (n > 1) {
      let ch = B58[(n - 1) % 58]!;
      if (ch === mint[mint.length - 1]) ch = B58[n % 58]!;
      rename = mint.slice(0, -1) + ch;
    }
    for (const e of blocks.get(mint)!) {
      events.push(rename === mint ? e : { ...e, mint: rename });
    }
  }
  events.sort((a, b) => a.slot - b.slot);
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const ds: Dataset = { sha256: kitJson.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? 0, batches };
  const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256 + `copy${k}`));
  return simulate(ds, hello, createStrategy(params)).netPnl;
}

const results: number[] = [];
for (let k = 0; k < copies; k++) {
  const pnl = Number(runCopy(k)) / 1e9;
  results.push(pnl);
  console.log(`copy ${k + 1}/${copies}: ${pnl.toFixed(4)} SOL`);
}
results.sort((a, b) => a - b);
const q = (p: number) => results[Math.min(results.length - 1, Math.floor(p * results.length))];
const median = results.length % 2 === 0 ? (results[results.length / 2 - 1]! + results[results.length / 2]!) / 2 : results[Math.floor(results.length / 2)]!;
const losing = results.filter((x) => x < 0).length;
console.log(`\nmedian ${median.toFixed(4)}  p10 ${q(0.1).toFixed(4)}  p90 ${q(0.9).toFixed(4)}  losing ${losing}/${copies}  min ${results[0]!.toFixed(4)}  max ${results[results.length - 1]!.toFixed(4)}`);
