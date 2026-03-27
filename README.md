# Aerodrome Dashboard

Data pipeline and dashboard for [Aerodrome](https://aerodrome.finance) on Base.
Fetches voting, fee, and bribe data for liquidity pools across epochs and
outputs a HTML dashboard with a CSV export.

## Usage

Requires Node.js 22+.

```sh
npm install
npm run fetch [voter_address]
npm run build
```

### `fetch`

Fetches on-chain data and writes `votes.csv`. An optional voter address can be
passed to track a specific account. When omitted, the default address
`0xa79cd47655156b299762dfe92a67980805ce5a31` is used.

### `build`

Reads `votes.csv` and generates `index.html`.

### Environment Variables

| Variable          | Required | Description                               |
|-------------------|----------|-------------------------------------------|
| `BASE_RPC_URL`    | Yes      | Base blockchain RPC endpoint              |
| `ALCHEMY_API_KEY` | No       | Alchemy key for token prices and metadata |

## Outputs

- **`votes.csv`** — Full CSV export (votes, fees, bribes in USD).
- **`index.html`** — HTML dashboard.
- **`prices.csv`** — Cached historical token prices to minimize API calls.

## How It Works

1. Reads pool and voting data from Velodrome Sugar contracts on Base via `viem`
2. Resolves token metadata and fetches historical USD prices from Alchemy
3. Computes per-pool fee and bribe totals per epoch
4. Generates CSV data (`fetch`) and an HTML dashboard (`build`)

The top 30 pools per epoch (by vote count) are included, plus any additional pools the tracked voter voted for.

## Automation

A GitHub Actions workflow (`.github/workflows/update-data.yml`) runs weekly and
on push, commits updated data files, and deploys to GitHub Pages.
