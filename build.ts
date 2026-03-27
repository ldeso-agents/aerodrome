import { readFileSync, writeFileSync } from "node:fs";

// -- Type --

type EpochRecord = {
  epoch_ts: number;
  epoch_number: number;
  epoch_date: string;
  pool_name: string;
  pool_type: string;
  total_votes: number;
  pool_votes: number;
  pool_vote_pct: number;
  voter_votes: number;
  voter_vote_pct: number;
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
const tagSpans = (arr: string[]) =>
  arr.map((s) => `<span>${escapeHtml(s)}</span>`).join("");

const poolTypeLabel: Record<string, string> = {
  bluechip: "blue chip",
  stablecoin: "stable",
  aero: "aero",
  new: "new",
};
const poolTypeBg: Record<string, string> = {
  bluechip: "#eef4ff",
  stablecoin: "#efefef",
  aero: "#ffedeb",
  new: "#e6f4ea",
};

// -- Main --

// 1. Parse votes.csv
const text = readFileSync("votes.csv", "utf-8").trimEnd();
const lines = text.split("\n");
const header = lines[0].split(",");
const idx = (name: string) => header.indexOf(name);

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
    total_votes: parseFloat(c[idx("total_votes")]),
    pool_votes: parseFloat(c[idx("pool_votes")]),
    pool_vote_pct: parseFloat(c[idx("pool_vote_pct")]),
    voter_votes: parseFloat(c[idx("voter_votes")]),
    voter_vote_pct: parseFloat(c[idx("voter_vote_pct")]),
    fees_bribes_usd: parseFloat(c[idx("fees_bribes_usd")]),
    fees_usd: parseFloat(c[idx("fees_usd")]),
    bribes_usd: parseFloat(c[idx("bribes_usd")]),
    bribe_tokens: (c[idx("bribe_tokens")] ?? "").split(";").filter(Boolean),
    fees_token0_usd: parseFloat(c[idx("fees_token0_usd")]),
    token0: c[idx("token0")],
    fees_token1_usd: parseFloat(c[idx("fees_token1_usd")]),
    token1: c[idx("token1")],
    aero_usd: parseFloat(c[idx("aero_usd")]),
    pool_address: c[idx("pool_address")],
    voter_address: c[idx("voter_address")],
  });
}

records.sort((a, b) => b.epoch_ts - a.epoch_ts || b.pool_votes - a.pool_votes);

const voterAddress = records[0]?.voter_address ?? "unknown";

// 2. Compute epoch totals and voter totals
const epochTotals = new Map<number, number>();
const voterVotesByEpoch = new Map<number, number>();
for (const r of records) {
  epochTotals.set(r.epoch_ts, r.total_votes);
  voterVotesByEpoch.set(
    r.epoch_ts,
    (voterVotesByEpoch.get(r.epoch_ts) ?? 0) + r.voter_votes
  );
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
  const trueVoterVotes = voterVotesByEpoch.get(first.epoch_ts) ?? 0;

  const totalRow = `          <tr style="font-weight:600;background:#f0f0f0">
            <td></td>
            <td>TOTAL</td>
            <td></td>
            <td class="right">${fmt(trueVotes)}</td>
            <td></td>
            <td class="right">${fmt(trueVoterVotes)}</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>`;

  const rows = epochRecords
    .map((r, j) => {
      const background = poolTypeBg[r.pool_type]
        ? ` style="background:${poolTypeBg[r.pool_type]}"`
        : "";
      return `        <tr>
            <td>${j + 1}</td>
            <td${background}>${escapeHtml(r.pool_name)}</td>
            <td${background}>${
        poolTypeLabel[r.pool_type] ? poolTypeLabel[r.pool_type] : ""
      }</td>
            <td${background} class="right">${fmt(r.pool_votes)}</td>
            <td${background} class="right">${r.pool_vote_pct.toFixed(2)}%</td>
            <td${background} class="right">${fmt(r.voter_votes)}</td>
            <td${background} class="right">${r.voter_vote_pct.toFixed(2)}%</td>
            <td${background} class="right">${usdFmt(r.fees_bribes_usd)}</td>
            <td${background} class="right">${usdFmt(r.fees_usd)}</td>
            <td${background} class="right">${usdFmt(r.bribes_usd)}</td>
            <td><div class="tags">${tagSpans(r.bribe_tokens)}</div></td>
            <td class="right">${usdFmt(r.fees_token0_usd)}</td>
            <td>${escapeHtml(r.token0)}</td>
            <td class="right">${usdFmt(r.fees_token1_usd)}</td>
            <td>${escapeHtml(r.token1)}</td>
            <td class="right">${usdFmt(r.aero_usd, 4)}</td>
          </tr>`;
    })
    .join("\n");

  sections.push(`  <details${i < 2 ? " open" : ""}>
    <summary>Epoch ${first.epoch_number} \u2013 ${first.epoch_date}${
    i === 0
      ? ` (current epoch as of ${new Date()
          .toISOString()
          .replace("T", " ")
          .replace(/:\d{2}\.\d+Z$/, " UTC")})`
      : ""
  }</summary>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Pool</th>
            <th>Type</th>
            <th class="right">Pool Votes</th>
            <th class="right">Pool Vote %</th>
            <th class="right">Voter Votes</th>
            <th class="right">Voter Vote %</th>
            <th class="right">Fees + Bribes (USD)</th>
            <th class="right">Fees (USD)</th>
            <th class="right">Bribes (USD)</th>
            <th>Bribe Tokens</th>
            <th class="right">Fees Token0 (USD)</th>
            <th>Token0</th>
            <th class="right">Fees Token1 (USD)</th>
            <th>Token1</th>
            <th class="right">AERO (USD)</th>
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
    summary { cursor: pointer; font-weight: 600; font-size: .95rem; padding: .5rem; background: #f0f0f0; border-radius: 4px; }
    summary:hover { background: #e8e8e8; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-top: .5rem; }
    th, td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid #e0e0e0; white-space: nowrap; }
    th { background: #f0f0f0; font-weight: 600; position: sticky; top: 0; }
    .right { text-align: right; }
    .tags { display: flex; gap: .2rem; flex-wrap: wrap; }
    .tags span { background: #e8e8e8; padding: .1rem .3rem; border-radius: 3px; font-size: .75rem; }
  </style>
</head>
<body>
  <h1>Aerodrome Votes \u2192 <a href="votes.csv">votes.csv</a></h1>
  <p style="font-size:.85rem;margin-bottom:1rem;color:#555">Voter: <code>${escapeHtml(
    voterAddress
  )}</code></p>
${sections.join("\n")}
</body>
</html>`;

writeFileSync("index.html", html);
console.log(
  `Built index.html from votes.csv (${records.length} records, ${sortedEpochs.length} epochs)`
);
