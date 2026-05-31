# options-manager

A production-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for real-time quantitative options analytics on Indian equity markets, powered by the [Upstox API](https://upstox.com/developer/api-documentation/) and built on [Bun](https://bun.sh).

## Overview

`options-manager` exposes eight MCP tools that let AI agents analyse live option chains, calculate risk metrics, simulate strategy payoffs, and generate trade recommendations without writing any boilerplate API code.

**What it covers:**

- Live option chain with full Greeks (delta, gamma, theta, vega, IV) and OI/volume
- Put-Call Ratio, Max Pain, and Active OI support/resistance levels
- Implied Volatility profile and IV skew (fear gauge)
- Open Interest dynamics — writing vs covering classification
- Technical indicators: SMA, EMA, RSI, MACD, Bollinger Bands, ATR
- Black-Scholes scenario analysis across a spot price range
- Multi-leg strategy payoff profiles with breakevens and risk-reward

## Prerequisites

- [Bun](https://bun.sh) v1.1 or later
- An [Upstox Developer](https://upstox.com/developer/api-documentation/) account with an active API access token

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure the Upstox API token

**Option A — environment variable:**

```bash
export UPSTOX_TOKEN=your_upstox_access_token
```

**Option B — `.env` file in the project root:**

```
UPSTOX_TOKEN=your_upstox_access_token
```

### 3. Start the server

```bash
bun run index.ts
```

## MCP Client Configuration

Add this block to your MCP client configuration (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "options-manager": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/options-manager/index.ts"],
      "env": {
        "UPSTOX_TOKEN": "your_upstox_access_token"
      }
    }
  }
}
```

## Tools Reference

### `search_underlying`

Search for NSE/BSE indices or equity shares by name or ticker to retrieve their Upstox instrument keys.

| Parameter | Type   | Description                                       |
| --------- | ------ | ------------------------------------------------- |
| `query`   | string | Symbol or index name (e.g. `"Nifty"`, `"INFY"`)  |

---

### `get_active_expiries`

Retrieve all upcoming options contract expiry dates for a given underlying.

| Parameter        | Type   | Description                                    |
| ---------------- | ------ | ---------------------------------------------- |
| `instrument_key` | string | Upstox instrument key (e.g. `"NSE_INDEX|Nifty 50"`) |

---

### `get_options_insight`

Master analytics tool. Fetches the full option chain and returns:

- **Active OI** — highest Call OI strike (resistance) and highest Put OI strike (support)
- **PCR** — Put-Call Ratio with directional bias (`EXTREMELY_BULLISH` → `EXTREMELY_BEARISH`)
- **Max Pain** — strike at which option buyers face maximum collective loss at expiry
- **Recommendation** — structured trade signal with conviction level and rationale

| Parameter        | Type   | Description                          |
| ---------------- | ------ | ------------------------------------ |
| `instrument_key` | string | Underlying instrument key            |
| `expiry_date`    | string | Expiry date in `YYYY-MM-DD` format   |

---

### `get_analyzed_option_chain`

Fetch the option chain filtered to a spot-centred strike window. Returns full Greeks for each strike — delta, gamma, theta, vega, IV — along with LTP, OI, and volume.

| Parameter        | Type   | Default | Description                                   |
| ---------------- | ------ | ------- | --------------------------------------------- |
| `instrument_key` | string | —       | Underlying instrument key                     |
| `expiry_date`    | string | —       | Expiry date in `YYYY-MM-DD` format            |
| `strike_window`  | number | `5`     | Strikes to show above and below spot price    |

---

### `get_oi_dynamics`

Retrieve strike-wise change in Open Interest over an interval and classify writing vs covering dynamics:

| Output trend                | Meaning                                            |
| --------------------------- | -------------------------------------------------- |
| `BULLISH_REVERSION`         | Put OI building, Call OI being covered             |
| `BEARISH_REVERSION`         | Call OI building, Put OI being covered             |
| `BULLISH_MOMENTUM`          | Put change dominates Call change                   |
| `BEARISH_MOMENTUM`          | Call change dominates Put change                   |

| Parameter        | Type   | Default | Description                                   |
| ---------------- | ------ | ------- | --------------------------------------------- |
| `instrument_key` | string | —       | Underlying instrument key                     |
| `expiry_date`    | string | —       | Expiry date in `YYYY-MM-DD` format            |
| `query_date`     | string | —       | Target date in `YYYY-MM-DD` format            |
| `interval`       | number | `1`     | Lookback interval in days                     |

---

### `get_volatility_profile`

Compute the Implied Volatility profile for ATM and OTM strikes, and derive an IV skew fear gauge:

| Skew value | Interpretation                                                     |
| ---------- | ------------------------------------------------------------------ |
| `> 1.5`    | `DOWNSIDE_FEAR` — OTM Puts expensive relative to OTM Calls        |
| `< -1.5`   | `UPSIDE_CHASE` — OTM Calls expensive relative to OTM Puts         |
| else       | `BALANCED_VOLATILITY` — no sharp directional expectation           |

| Parameter        | Type   | Description                          |
| ---------------- | ------ | ------------------------------------ |
| `instrument_key` | string | Underlying instrument key            |
| `expiry_date`    | string | Expiry date in `YYYY-MM-DD` format   |

---

### `get_technical_indicator_candles`

Fetch intraday or historical candles and calculate:

- **Moving Averages:** SMA(20), SMA(50), SMA(200), EMA(9), EMA(20)
- **Momentum:** RSI(14), MACD(12,26,9)
- **Volatility:** Bollinger Bands(20, 2σ), ATR(14)
- **Trend Rating:** `STRONG_BULLISH` / `BULLISH` / `NEUTRAL` / `BEARISH` / `STRONG_BEARISH`

| Parameter        | Type                                           | Description                          |
| ---------------- | ---------------------------------------------- | ------------------------------------ |
| `instrument_key` | string                                         | Instrument key (index or equity)     |
| `interval`       | `1minute` / `30minute` / `day` / `week` / `month` | Candle duration                  |
| `to_date`        | string                                         | End date in `YYYY-MM-DD` format      |
| `from_date`      | string (optional)                              | Start date in `YYYY-MM-DD` format    |

---

### `get_greeks_scenario`

Run Black-Scholes scenario analysis for a specific strike across a spot price range. Shows how option premium, delta, gamma, theta, and vega evolve as the underlying moves. Useful for risk visualisation and position sizing before entering a trade.

The tool fetches the current ATM IV from the live option chain, then uses it for all scenario points. IV is sourced from the requested strike if available, falling back to the average ATM IV.

| Parameter        | Type              | Default | Description                                              |
| ---------------- | ----------------- | ------- | -------------------------------------------------------- |
| `instrument_key` | string            | —       | Underlying instrument key                                |
| `expiry_date`    | string            | —       | Expiry date in `YYYY-MM-DD` format                       |
| `strike`         | number            | —       | Strike price to analyse                                  |
| `option_type`    | `call` / `put`    | —       | Option side to simulate                                  |
| `spot_shift_pct` | number (optional) | `5`     | Range to simulate on either side of spot (e.g. 5 = ±5%) |

**Output includes:** current spot, days to expiry, IV used, current Greeks summary, and a 21-point scenario table.

---

### `get_strategy_payoff`

Calculate the expiry payoff profile for a multi-leg option strategy — bull/bear spreads, iron condor, straddle, strangle, butterfly, and more. Returns breakeven points, max profit/loss, risk-reward ratio, and a 61-point payoff curve spanning ±30% of the current spot price.

Premiums must be provided from live market data — use `get_analyzed_option_chain` to fetch them.

| Parameter    | Type   | Description                        |
| ------------ | ------ | ---------------------------------- |
| `spot_price` | number | Current spot price of the underlying |
| `legs`       | array  | 1–6 strategy legs (see below)      |

**Leg fields:**

| Field     | Type           | Default | Description                             |
| --------- | -------------- | ------- | --------------------------------------- |
| `strike`  | number         | —       | Strike price                            |
| `type`    | `call` / `put` | —       | Option type                             |
| `action`  | `buy` / `sell` | —       | Long or short this leg                  |
| `premium` | number         | —       | Premium paid or received per unit       |
| `qty`     | integer        | `1`     | Number of lots                          |

**Example — Bull Call Spread on Nifty:**

```json
{
  "spot_price": 24500,
  "legs": [
    { "strike": 24500, "type": "call", "action": "buy",  "premium": 200 },
    { "strike": 24700, "type": "call", "action": "sell", "premium": 90  }
  ]
}
```

**Example — Short Strangle:**

```json
{
  "spot_price": 24500,
  "legs": [
    { "strike": 24200, "type": "put",  "action": "sell", "premium": 80  },
    { "strike": 24800, "type": "call", "action": "sell", "premium": 75  }
  ]
}
```

**Output:**

```json
{
  "strategy": {
    "totalNetPremium": 110,
    "breakevens": [24390, 24810],
    "maxProfit": 110,
    "maxLoss": "UNLIMITED",
    "riskRewardRatio": null
  },
  "payoffTable": [...]
}
```

> `maxProfit` / `maxLoss` are reported as `"UNLIMITED"` for strategies with uncapped upside or downside (e.g. naked short calls).

## Development

### Run integration tests

```bash
bun run src/test/integration.ts
```

### Lint and format

```bash
bunx --bun @biomejs/biome check --write .
```

## Architecture

```
src/
├── clients/       # Upstox API HTTP client
├── configs/       # Environment config & token resolution
├── helpers/
│   ├── analysis.ts       # OI analytics, PCR, Max Pain, IV skew, technicals
│   ├── blackscholes.ts   # Pure Black-Scholes pricing & scenario builder
│   ├── logger.ts         # Logging utility
│   └── payoff.ts         # Multi-leg strategy payoff calculator
├── tools/
│   ├── market.ts         # 6 market data & analytics tools
│   ├── scenario.ts       # get_greeks_scenario
│   └── strategy.ts       # get_strategy_payoff
└── test/
    └── integration.ts    # Integration test suite
```

## Constraints

- No third-party runtime dependencies beyond `@modelcontextprotocol/sdk`, `zod`, `technicalindicators`, and `consola`
- Bun-native APIs only (no Node.js compatibility modules)
- Strict TypeScript — no `any` types
- Biome for formatting and linting
