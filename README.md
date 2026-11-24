# pump-replay-repo

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chanjume/pump-replay-repo/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chanjume/pump-replay-repo/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Deep-dip mean-reversion lost on this data, so this bot snipes launches instead: it buys a coin only in its first few slots, only if the launch looks honest (creator pre-buy at most 0.5 SOL, 1–4 other buyers, creator hasn't sold, no big dump yet) and the price has already ticked up 10–20% from creation. It stakes a small fixed 0.10 SOL per coin (capped at 1% of the curve's real reserve) and exits fast — take profit at +25%, tight −6% stop, 20-slot max hold, instant exit if the creator sells — with a trailing stop (+12% arm, 4% drop) that lets a gap-up run. One buy per coin, one sell: few trades, high conviction per coin, across many coins.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2ms6gy71&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
