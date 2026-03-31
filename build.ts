import { readFileSync, writeFileSync } from "node:fs";

// -- Type --

type EpochRecord = {
  epoch_ts: number;
  epoch_number: number;
  epoch_date: string;
  pool_name: string;
  pool_type: string;
  pool_votes: number;
  pool_votes_total: number;
  pool_vote_pct: number;
  fees_bribes_usd: number;
  fees_usd: number;
  bribes_usd: number;
  bribe_tokens: string[];
  fees_token0_usd: number;
  token0: string;
  fees_token1_usd: number;
  token1: string;
  aero_usd: number;
  pool_address: string;
  voter_address: string;
  actual_votes: number;
  actual_votes_total: number;
  actual_vote_pct: number;
  actual_earnings_usd: number;
  equal_bc3_votes: number;
  equal_bc3_vote_pct: number;
  equal_bc3_earnings_usd: number;
  optimal_bc10_votes: number;
  optimal_bc10_vote_pct: number;
  optimal_bc10_earnings_usd: number;
  optimal10_votes: number;
  optimal10_vote_pct: number;
  optimal10_earnings_usd: number;
};

// -- Helpers --

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const fmt = (n: number, digits: number = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const usdFmt = (n: number, digits: number = 0) => "$" + fmt(n, digits);

const poolTypeLabel: Record<string, string> = {
  bluechip: "blue chip",
  stablecoin: "stable",
  aero: "aero",
  new: "new",
};

// -- Main --

// 1. Parse votes.csv
const text = readFileSync("votes.csv", "utf-8").trimEnd();
const lines = text.split("\n");
const header = lines[0].split(",");
const idx = (name: string) => header.indexOf(name);
const p = (col: string, c: string[]) => parseFloat(c[idx(col)] ?? "0");

const records: EpochRecord[] = [];
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split(",").map((v) => v.replace(/^"(.*)"$/, "$1"));
  const epochDate = c[idx("epoch_date")];
  records.push({
    epoch_ts: Math.floor(new Date(epochDate + "T00:00:00Z").getTime() / 1000),
    epoch_number: parseInt(c[idx("epoch_number")]),
    epoch_date: epochDate,
    pool_name: c[idx("pool_name")],
    pool_type: c[idx("pool_type")],
    pool_votes: p("pool_votes", c),
    pool_votes_total: p("pool_votes_total", c),
    pool_vote_pct: p("pool_vote_pct", c),
    fees_bribes_usd: p("fees_bribes_usd", c),
    fees_usd: p("fees_usd", c),
    bribes_usd: p("bribes_usd", c),
    bribe_tokens: (c[idx("bribe_tokens")] ?? "").split(";").filter(Boolean),
    fees_token0_usd: p("fees_token0_usd", c),
    token0: c[idx("token0")],
    fees_token1_usd: p("fees_token1_usd", c),
    token1: c[idx("token1")],
    aero_usd: p("aero_usd", c),
    pool_address: c[idx("pool_address")],
    voter_address: c[idx("voter_address")],
    actual_votes: p("actual_votes", c),
    actual_votes_total: p("actual_votes_total", c),
    actual_vote_pct: p("actual_vote_pct", c),
    actual_earnings_usd: p("actual_earnings_usd", c),
    equal_bc3_votes: p("equal_bc3_votes", c),
    equal_bc3_vote_pct: p("equal_bc3_vote_pct", c),
    equal_bc3_earnings_usd: p("equal_bc3_earnings_usd", c),
    optimal_bc10_votes: p("optimal_bc10_votes", c),
    optimal_bc10_vote_pct: p("optimal_bc10_vote_pct", c),
    optimal_bc10_earnings_usd: p("optimal_bc10_earnings_usd", c),
    optimal10_votes: p("optimal10_votes", c),
    optimal10_vote_pct: p("optimal10_vote_pct", c),
    optimal10_earnings_usd: p("optimal10_earnings_usd", c),
  });
}

records.sort((a, b) => b.epoch_ts - a.epoch_ts || b.pool_votes - a.pool_votes);

const voterAddress = records[0]?.voter_address ?? "unknown";

// 2. Compute epoch totals
const epochTotals = new Map<number, number>();
const actualVotesByEpoch = new Map<number, number>();
for (const r of records) {
  epochTotals.set(r.epoch_ts, r.pool_votes_total);
  if (!actualVotesByEpoch.has(r.epoch_ts)) {
    actualVotesByEpoch.set(r.epoch_ts, r.actual_votes_total);
  }
}

// 3. Group records by epoch
const byEpoch = new Map<number, EpochRecord[]>();
for (const r of records) {
  let arr = byEpoch.get(r.epoch_ts);
  if (!arr) {
    arr = [];
    byEpoch.set(r.epoch_ts, arr);
  }
  arr.push(r);
}
const sortedEpochs = [...byEpoch.entries()].sort((a, b) => b[0] - a[0]);

// 4. Build HTML sections (one <details> per epoch)
const sections: string[] = [];
for (let i = 0; i < sortedEpochs.length; i++) {
  const [, epochRecords] = sortedEpochs[i];
  epochRecords.sort((a, b) => b.pool_votes - a.pool_votes);
  const first = epochRecords[0];

  const trueVotes = epochTotals.get(first.epoch_ts) ?? 0;
  const trueActualVotes = actualVotesByEpoch.get(first.epoch_ts) ?? 0;

  const sum = (fn: (r: EpochRecord) => number) =>
    epochRecords.reduce((s, r) => s + fn(r), 0);

  const totalActualEarn = sum((r) => r.actual_earnings_usd);
  const totalEqBc3Votes = sum((r) => r.equal_bc3_votes);
  const totalEqBc3Earn = sum((r) => r.equal_bc3_earnings_usd);
  const totalOptBc10Votes = sum((r) => r.optimal_bc10_votes);
  const totalOptBc10Earn = sum((r) => r.optimal_bc10_earnings_usd);
  const totalOpt10Votes = sum((r) => r.optimal10_votes);
  const totalOpt10Earn = sum((r) => r.optimal10_earnings_usd);

  const epochTiming =
    i === 0
      ? `as of ${new Date()
          .toISOString()
          .replace("T", " ")
          .replace(/:\d{2}\.\d+Z$/, " UTC")}`
      : `until ${sortedEpochs[i - 1][1][0].epoch_date} 00:00 UTC`;

  const summaryParts: string[] = [];
  if (trueActualVotes > 0) {
    const aprPct = (earn: number, votes: number) => {
      const voteValueUsd = votes * first.aero_usd;
      if (voteValueUsd === 0) return "APR 0%";
      const apr = (((365 / 7) * earn) / voteValueUsd) * 100;
      return `APR ${apr.toFixed(1)}%`;
    };
    summaryParts.push(
      `Actual ${aprPct(totalActualEarn, trueActualVotes)}`,
      `EqBC3 ${aprPct(totalEqBc3Earn, totalEqBc3Votes)}`,
      `OptBC10 ${aprPct(totalOptBc10Earn, totalOptBc10Votes)}`,
      `Opt10 ${aprPct(totalOpt10Earn, totalOpt10Votes)}`
    );
  }

  const totalRow = `          <tr class="total">
            <td></td>
            <td>TOTAL</td>
            <td></td>
            <td class="right">${fmt(trueVotes)}</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td class="sep right">${fmt(trueActualVotes)}</td>
            <td></td>
            <td class="right">${usdFmt(totalActualEarn)}</td>
            <td class="sep right">${fmt(totalEqBc3Votes)}</td>
            <td></td>
            <td class="right">${usdFmt(totalEqBc3Earn)}</td>
            <td class="sep right">${fmt(totalOptBc10Votes)}</td>
            <td></td>
            <td class="right">${usdFmt(totalOptBc10Earn)}</td>
            <td class="sep right">${fmt(totalOpt10Votes)}</td>
            <td></td>
            <td class="right">${usdFmt(totalOpt10Earn)}</td>
          </tr>`;

  const rows = epochRecords
    .map((r, j) => {
      const cls = poolTypeLabel[r.pool_type] ? r.pool_type : "";
      const pt = cls ? ` class="${cls}"` : "";
      const ptr = cls ? ` class="${cls} right"` : ` class="right"`;
      const bribeTag =
        r.bribe_tokens.length > 0
          ? `<span>${escapeHtml(r.bribe_tokens[0])}${
              r.bribe_tokens.length > 1 ? "\u2026" : ""
            }</span>`
          : "";
      return `        <tr>
            <td${pt}>${j + 1}</td>
            <td${pt}>${escapeHtml(r.pool_name)}</td>
            <td${pt}>${poolTypeLabel[r.pool_type] ?? ""}</td>
            <td${ptr}>${fmt(r.pool_votes)}</td>
            <td${ptr}>${r.pool_vote_pct.toFixed(2)}%</td>
            <td${ptr}>${usdFmt(r.fees_bribes_usd)}</td>
            <td${ptr}>${usdFmt(r.fees_usd)}</td>
            <td${ptr}>${usdFmt(r.bribes_usd)}</td>
            <td${pt}><div class="tags">${bribeTag}</div></td>
            <td class="sep right">${fmt(r.actual_votes)}</td>
            <td class="right">${r.actual_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.actual_earnings_usd)}</td>
            <td class="sep right">${fmt(r.equal_bc3_votes)}</td>
            <td class="right">${r.equal_bc3_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.equal_bc3_earnings_usd)}</td>
            <td class="sep right">${fmt(r.optimal_bc10_votes)}</td>
            <td class="right">${r.optimal_bc10_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.optimal_bc10_earnings_usd)}</td>
            <td class="sep right">${fmt(r.optimal10_votes)}</td>
            <td class="right">${r.optimal10_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.optimal10_earnings_usd)}</td>
          </tr>`;
    })
    .join("\n");

  sections.push(`  <details${i < 2 ? " open" : ""}>
    <summary>Epoch ${first.epoch_number} ${epochTiming} \u2014 AERO ${usdFmt(
    first.aero_usd,
    4
  )} \u2014 Earnings ${usdFmt(totalActualEarn)} \u2014 ${summaryParts.join(
    " \u00b7 "
  )}</summary>
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Pool</th>
            <th>Type</th>
            <th class="right">Pool Votes</th>
            <th class="right">Pool Vote %</th>
            <th class="right">Fees + Bribes</th>
            <th class="right">Fees</th>
            <th class="right">Bribes</th>
            <th>Bribe Tokens</th>
            <th class="sep right">Actual Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
            <th class="sep right">EqBC3 Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
            <th class="sep right">OptBC10 Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
            <th class="sep right">Opt10 Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
          </tr>
        </thead>
        <tbody>
  ${rows}
  ${totalRow}
        </tbody>
      </table>
    </div>
  </details>`);
}

// 5. Write index.html
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aerodrome Votes</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; padding: 1rem; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    details { margin-bottom: .5rem; }
    summary { cursor: pointer; font-weight: 600; font-size: .95rem; padding: .5rem; background: #f0f0f0; border-radius: 4px; font-variant-numeric: tabular-nums; }
    summary:hover { background: #e8e8e8; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .5rem; font-variant-numeric: tabular-nums; }
    th, td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid #e0e0e0; white-space: nowrap; }
    th { background: #f0f0f0; font-weight: 600; position: sticky; top: 0; }
    .voter { font-size: .85rem; margin-bottom: 1rem; color: #555; }
    .scroll { overflow-x: auto; }
    .right { text-align: right; }
    .sep { border-left: 2px solid #bbb; }
    .total { font-weight: 600; background: #f0f0f0; }
    .bluechip { background: #eef4ff; }
    .stablecoin { background: #efefef; }
    .aero { background: #ffedeb; }
    .new { background: #e6f4ea; }
    .tags { display: flex; gap: .2rem; flex-wrap: wrap; }
    .tags span { background: #e8e8e8; padding: .1rem .3rem; border-radius: 3px; font-size: .75rem; }
  </style>
</head>
<body>
  <h1>Aerodrome Votes \u2192 <a href="votes.csv">votes.csv</a></h1>
  <p class="voter">Voter: <code>${escapeHtml(voterAddress)}</code></p>
${sections.join("\n")}
</body>
</html>`;

writeFileSync("index.html", html);
console.log(
  `Built index.html from votes.csv (${records.length} records, ${sortedEpochs.length} epochs)`
);
