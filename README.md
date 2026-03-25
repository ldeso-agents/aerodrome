# Aerodrome Dashboard

Data pipeline and dashboard for [Aerodrome Protocol](https://aerodrome.finance) on Base. Fetches voting, fee, and bribe data for liquidity pools across epochs and outputs an interactive HTML dashboard and CSV exports.

## Usage

Requires Node.js 22+.

```sh
npm install
npm run fetch
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BASE_RPC_URL` | Yes | Base blockchain RPC endpoint |
| `ALCHEMY_API_KEY` | No | Alchemy key for token metadata and historical prices |

## Outputs

- **`index.html`** — Interactive dashboard with collapsible epoch tables, sorted by votes. Open in a browser or deploy to GitHub Pages.
- **`votes.csv`** — Full export of per-pool epoch data (votes, fees, bribes in USD).
- **`prices.csv`** — Cached historical token prices to minimize API calls across runs.

## How It Works

1. Reads pool and voting data from Velodrome Sugar contracts on Base via `viem`
2. Resolves token metadata and fetches historical USD prices from Alchemy
3. Computes per-pool fee and bribe totals per epoch
4. Generates HTML and CSV output

Top 30 pools per epoch (by vote count) are included.

## Automation

A GitHub Actions workflow (`.github/workflows/update-data.yml`) runs weekly and on push, commits updated data files, and deploys to GitHub Pages.
