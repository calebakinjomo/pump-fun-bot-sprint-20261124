# Pump.fun Bot Sprint — Robust Runner-Crossing Scalper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/calebakinjomo/pump-fun-bot-sprint-20261124/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/calebakinjomo/pump-fun-bot-sprint-20261124/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Referral code: `hdavhdvz`

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve chain data, ranked on net PnL.

## Strategy

Built for robustness across windows, not one fitted window. One entry trigger,
loose exits, no pyramiding:

- **Entry — runner crossing:** real SOL first crosses 30 SOL from below, at
  least 20 slots after creation (instant crossings are bundled launches that
  dump), with fresh flow (net +1.0 SOL, 3+ buys, 3+ distinct buyers over the
  last 15 slots, last trade a buy), creator not sold, dev buy ≤ 10 SOL. One
  entry per coin, 0.30 SOL stake. (A 50 SOL second-chance crossing and a
  pullback "second wind" entry were both tested and removed — each halved the
  full-window PnL.)
- **Exits — loose on price, tight on time:** −12.5% stop, +50% take-profit on
  a third, +190% full exit, 200-slot max hold, no trailing stop, no flow/dev
  exits. Eager price exits cut the runners that pay for everything, but a
  long hold is fragile: the stress copies rebuild each coin's flow from blocks
  of other coins' trades (mean block 8 trades), so multi-block persistence is
  broken — a 1500-slot hold scored +1.29 on dev but a −0.22 SOL stress median.
- **Risk limits:** max 5 open positions, max 2.0 SOL at cost.
- **Guardrail probe:** if coins traded lag a 30-coin pace over 6h of block
  time, 0.01 SOL probe round trips (max 8) keep the run above the 20-coin
  minimum.

Measured on the full 24h dev window (local replay port of the kit harness):
+0.40 SOL net, ex-top-3 −0.50 SOL, max drawdown ~3.8%, positive on every
fail-tx seed (+0.30…+0.41 SOL) and at 2x fees (+0.20 SOL); first ~11h −0.03
SOL, last ~13h +0.38 SOL. On 7 saved official stress copies the median is
+0.01 SOL (3/7 losing). A pullback "second wind" entry was tested and
removed — it lost on its own and dragged the combined bot down.

Deterministic: no clock, no randomness, no I/O — the two graded executions
produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint (runs `node /bot/main.ts` under Node 22)
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte
- `tools/` — offline backtest harness (dev use only, not run by the grader)

## License

MIT — see [LICENSE](LICENSE).
