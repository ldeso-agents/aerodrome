# Aerodrome Dashboard

Data pipeline and dashboard for [Aerodrome](https://aerodrome.finance) on Base.
Fetches voting, fee, and bribe data for liquidity pools across epochs, analyses
voting strategies, and outputs a HTML dashboard with a CSV export.

## Usage

Requires Node.js 22+.

```sh
npm install
npm run fetch [voter_address]
npm run analyse
npm run build
```

### `fetch`

Fetches on-chain data and writes `votes.csv`. An optional voter address can be
passed to track a specific account. When omitted, the default address
`0xa79cd47655156b299762dfe92a67980805ce5a31` is used.

### `analyse`

Reads `votes.csv` and computes hypothetical voting strategies for each epoch:

- **Actual** — the voter's real earnings based on their votes.
- **EqBC3** — proportional votes across the top 3 blue-chip pools (weighted by fees + bribes).
- **Opt10BC** — optimal votes across 10 blue-chip pools.
- **Opt10** — optimal votes across any 10 pools.

Optimal votes are computed via water-filling (min-max Lagrangian optimization)
to maximize the voter's share of fees and bribes. The results are written back
to `votes.csv` as additional columns.

### `build`

Reads `votes.csv` and generates `index.html`.

### Environment Variables

| Variable          | Required | Description                               |
|-------------------|----------|-------------------------------------------|
| `BASE_RPC_URL`    | Yes      | Base blockchain RPC endpoint              |
| `ALCHEMY_API_KEY` | No       | Alchemy key for token prices and metadata |

## Outputs

- **`index.html`** — HTML dashboard.
- **`votes.csv`** — Full CSV export (votes, fees, bribes, earnings in USD).
- **`prices.csv`** — Cached historical token prices to minimize API calls.
- **`tokens.csv`** — Cached token symbols and decimals to minimize API calls.

## How It Works

1. Reads pool and voting data from Velodrome Sugar contracts on Base via `viem`
2. Resolves token metadata and fetches historical USD prices from Alchemy
3. Computes per-pool fee and bribe totals per epoch
4. Generates CSV data, voting strategy analysis and an HTML dashboard

The top 30 pools per epoch (by vote count) are included, plus any additional
pools the tracked voter voted for.

## Automation

A GitHub Actions workflow (`.github/workflows/update-data.yml`) runs daily and
on push, commits updated data, and deploys to GitHub Pages.
