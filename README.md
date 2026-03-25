# Aerodrome Dashboard

Data pipeline and dashboard for [Aerodrome](https://aerodrome.finance) on Base.
Fetches voting, fee, and bribe data for liquidity pools across epochs and
outputs a HTML dashboard with a CSV export.

## Usage

Requires Node.js 22+.

```sh
npm install
npm run fetch
```

To include per-address voting history (which pools the address voted for and by
how many votes), pass `--address`:

```sh
npm run fetch -- --address 0xa79cd47655156b299762DFE92A67980805ce5a31
```

This adds an `address_votes` column to the CSV and HTML output showing the
number of votes cast by the address for each pool in each epoch. Pools the
address voted for outside the top 30 are included automatically.

### Environment Variables

| Variable          | Required | Description                               |
|-------------------|----------|-------------------------------------------|
| `BASE_RPC_URL`    | Yes      | Base blockchain RPC endpoint              |
| `ALCHEMY_API_KEY` | No       | Alchemy key for token prices and metadata |

## Outputs

- **`index.html`** — HTML dashboard.
- **`votes.csv`** — Full CSV export (votes, fees, bribes in USD).
- **`prices.csv`** — Cached historical token prices to minimize API calls.

## How It Works

1. Reads pool and voting data from Velodrome Sugar contracts on Base via `viem`
2. Resolves token metadata and fetches historical USD prices from Alchemy
3. Computes per-pool fee and bribe totals per epoch
4. Generates HTML and CSV output

The top 30 pools per epoch (by vote count) are included.

## Automation

A GitHub Actions workflow (`.github/workflows/update-data.yml`) runs weekly and
on push, commits updated data files, and deploys to GitHub Pages.
