import { readFileSync, writeFileSync } from "node:fs";

// -- Types --

type PoolRecord = {
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
  bribe_tokens: string;
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
};

type Strategy = {
  votes: number;
  earnings: number;
};

// -- CSV helpers --

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.trimEnd().split("\n");
  const header = lines[0].split(",");
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(lines[i].split(",").map((v) => v.replace(/^"(.*)"$/, "$1")));
  }
  return { header, rows };
}

function parseRecords(header: string[], rows: string[][]): PoolRecord[] {
  const idx = (name: string) => header.indexOf(name);
  return rows.map((c) => ({
    epoch_number: parseInt(c[idx("epoch_number")]),
    epoch_date: c[idx("epoch_date")],
    pool_name: c[idx("pool_name")],
    pool_type: c[idx("pool_type")],
    pool_votes: parseFloat(c[idx("pool_votes")]),
    pool_votes_total: parseFloat(c[idx("pool_votes_total")]),
    pool_vote_pct: parseFloat(c[idx("pool_vote_pct")]),
    fees_bribes_usd: parseFloat(c[idx("fees_bribes_usd")]),
    fees_usd: parseFloat(c[idx("fees_usd")]),
    bribes_usd: parseFloat(c[idx("bribes_usd")]),
    bribe_tokens: c[idx("bribe_tokens")] ?? "",
    fees_token0_usd: parseFloat(c[idx("fees_token0_usd")]),
    token0: c[idx("token0")],
    fees_token1_usd: parseFloat(c[idx("fees_token1_usd")]),
    token1: c[idx("token1")],
    aero_usd: parseFloat(c[idx("aero_usd")]),
    pool_address: c[idx("pool_address")],
    voter_address: c[idx("voter_address")],
    actual_votes: parseFloat(c[idx("actual_votes")]),
    actual_votes_total: parseFloat(c[idx("actual_votes_total")]),
    actual_vote_pct: parseFloat(c[idx("actual_vote_pct")]),
  }));
}

// -- Water-filling optimizer --
//
// Maximize  sum_i  R_i * v_i / (O_i + v_i)
// subject to  sum_i v_i = V,  v_i >= 0,  |{i : v_i > 0}| <= K
//
// KKT condition for active pools:  R_i * O_i / (O_i + v_i)^2 = lambda
//   => v_i = sqrt(R_i * O_i / lambda) - O_i
//
// Binary search on lambda to satisfy the vote budget.

type Pool = { reward: number; otherVotes: number };

function waterFill(
  pools: Pool[],
  totalVotes: number,
  maxPools: number
): number[] {
  if (totalVotes <= 0) return pools.map(() => 0);

  const indexed = pools
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.reward > 0 && p.otherVotes > 0)
    .sort((a, b) => b.reward / b.otherVotes - a.reward / a.otherVotes)
    .slice(0, maxPools);

  if (indexed.length === 0) return pools.map(() => 0);

  const computeVotes = (lambda: number): { votes: number[]; total: number } => {
    const votes = new Array(indexed.length).fill(0);
    let total = 0;
    for (let j = 0; j < indexed.length; j++) {
      const { reward, otherVotes } = indexed[j];
      const v = Math.sqrt((reward * otherVotes) / lambda) - otherVotes;
      votes[j] = Math.max(0, v);
      total += votes[j];
    }
    return { votes, total };
  };

  let lo = 1e-30;
  let hi = 1e10;
  while (computeVotes(hi).total > totalVotes) hi *= 10;
  while (computeVotes(lo).total < totalVotes) lo /= 10;

  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const { total } = computeVotes(mid);
    if (Math.abs(total - totalVotes) / (totalVotes + 1) < 1e-12) break;
    if (total > totalVotes) lo = mid;
    else hi = mid;
  }

  const { votes: optVotes } = computeVotes((lo + hi) / 2);
  const result = pools.map(() => 0);
  for (let j = 0; j < indexed.length; j++) {
    result[indexed[j].i] = optVotes[j];
  }
  return result;
}

function computeEarnings(pools: Pool[], votes: number[]): number[] {
  return pools.map((p, i) => {
    const v = votes[i];
    if (v <= 0) return 0;
    const denom = p.otherVotes + v;
    return denom > 0 ? (p.reward * v) / denom : 0;
  });
}

function votePct(votes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((votes / total) * 100 * 10000) / 10000;
}

function round(n: number, d: number = 2): string {
  return n.toFixed(d);
}

// -- Main --

const text = readFileSync("votes.csv", "utf-8");
const { header, rows } = parseCsv(text);
const records = parseRecords(header, rows);

// Group by epoch
const byEpoch = new Map<number, { record: PoolRecord; rowIdx: number }[]>();
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  let arr = byEpoch.get(r.epoch_number);
  if (!arr) {
    arr = [];
    byEpoch.set(r.epoch_number, arr);
  }
  arr.push({ record: r, rowIdx: i });
}

// Compute voter's total votes per epoch
const voterTotalByEpoch = new Map<number, number>();
for (const r of records) {
  voterTotalByEpoch.set(
    r.epoch_number,
    (voterTotalByEpoch.get(r.epoch_number) ?? 0) + r.actual_votes
  );
}

// Strategy results per row: [actual, propBC5, opt10BC, opt10]
const strategies: Strategy[][] = records.map(() => [
  { votes: 0, earnings: 0 },
  { votes: 0, earnings: 0 },
  { votes: 0, earnings: 0 },
  { votes: 0, earnings: 0 },
]);

for (const [epochNum, entries] of byEpoch) {
  const voterTotal = voterTotalByEpoch.get(epochNum) ?? 0;

  const pools: Pool[] = entries.map(({ record: r }) => ({
    reward: r.fees_bribes_usd,
    otherVotes: r.pool_votes - r.actual_votes,
  }));

  // 1. Actual strategy
  const actualVotes = entries.map(({ record: r }) => r.actual_votes);
  const actualEarnings = computeEarnings(pools, actualVotes);

  // 2. Proportional split across top 5 bluechip + stable pools (by fees+bribes)
  const propBc5Top = entries
    .map(({ record: r }, j) => ({
      j,
      reward: r.fees_bribes_usd,
      type: r.pool_type,
    }))
    .filter((x) => x.type === "bluechip" || x.type === "stablecoin")
    .sort((a, b) => b.reward - a.reward)
    .slice(0, 5);

  const propBc5Votes = pools.map(() => 0);
  if (propBc5Top.length > 0 && voterTotal > 0) {
    const totalReward = propBc5Top.reduce((s, x) => s + x.reward, 0);
    if (totalReward > 0) {
      for (const { j, reward } of propBc5Top) {
        propBc5Votes[j] = (voterTotal * reward) / totalReward;
      }
    } else {
      const perPool = voterTotal / propBc5Top.length;
      for (const { j } of propBc5Top) propBc5Votes[j] = perPool;
    }
  }
  const propBc5Earnings = computeEarnings(pools, propBc5Votes);

  // 3. Optimal bluechip (up to 10 pools)
  const allBluechipIndices = entries
    .map(({ record: r }, j) => ({ j, type: r.pool_type }))
    .filter((x) => x.type === "bluechip")
    .map((x) => x.j);

  const bcPools: Pool[] = allBluechipIndices.map((j) => pools[j]);
  const bcOpt = waterFill(bcPools, voterTotal, 10);
  const opt10BcVotes = pools.map(() => 0);
  for (let k = 0; k < allBluechipIndices.length; k++) {
    opt10BcVotes[allBluechipIndices[k]] = bcOpt[k];
  }
  const opt10BcEarnings = computeEarnings(pools, opt10BcVotes);

  // 4. Optimal any (up to 10 pools)
  const opt10Votes = waterFill(pools, voterTotal, 10);
  const opt10Earnings = computeEarnings(pools, opt10Votes);

  for (let j = 0; j < entries.length; j++) {
    const idx = entries[j].rowIdx;
    strategies[idx] = [
      { votes: actualVotes[j], earnings: actualEarnings[j] },
      { votes: propBc5Votes[j], earnings: propBc5Earnings[j] },
      { votes: opt10BcVotes[j], earnings: opt10BcEarnings[j] },
      { votes: opt10Votes[j], earnings: opt10Earnings[j] },
    ];
  }
}

// -- Write updated votes.csv --

const analysisFields = [
  "actual_votes",
  "actual_vote_pct",
  "actual_earnings_usd",
  "prop_bc5_votes",
  "prop_bc5_vote_pct",
  "prop_bc5_earnings_usd",
  "opt_10bc_votes",
  "opt_10bc_vote_pct",
  "opt_10bc_earnings_usd",
  "opt_10_votes",
  "opt_10_vote_pct",
  "opt_10_earnings_usd",
];

const analysisSet = new Set(analysisFields);
const cleanHeader = header.filter((h) => !analysisSet.has(h));
const outHeader = [...cleanHeader, ...analysisFields];

const stringFields = new Set([
  "epoch_date",
  "pool_name",
  "pool_type",
  "token0",
  "token1",
  "pool_address",
  "voter_address",
]);

const outLines = [outHeader.join(",")];
for (let i = 0; i < rows.length; i++) {
  const cleanIndices = header
    .map((h, j) => (analysisSet.has(h) ? -1 : j))
    .filter((j) => j >= 0);
  const baseValues = cleanIndices.map((j) => {
    const v = rows[i][j];
    return stringFields.has(header[j]) ? `"${v}"` : v;
  });

  const r = records[i];
  const voterTotal = voterTotalByEpoch.get(r.epoch_number) ?? 0;
  const [actual, propBc5, opt10Bc, opt10] = strategies[i];
  const analysisValues = [
    round(actual.votes),
    round(votePct(actual.votes, voterTotal), 4),
    round(actual.earnings),
    round(propBc5.votes),
    round(votePct(propBc5.votes, voterTotal), 4),
    round(propBc5.earnings),
    round(opt10Bc.votes),
    round(votePct(opt10Bc.votes, voterTotal), 4),
    round(opt10Bc.earnings),
    round(opt10.votes),
    round(votePct(opt10.votes, voterTotal), 4),
    round(opt10.earnings),
  ];

  outLines.push([...baseValues, ...analysisValues].join(","));
}

writeFileSync("votes.csv", outLines.join("\n") + "\n");

// -- Summary --

let totalActual = 0;
let totalPropBc5 = 0;
let totalOpt10Bc = 0;
let totalOpt10 = 0;
for (const [actual, propBc5, o10bc, o10] of strategies) {
  totalActual += actual.earnings;
  totalPropBc5 += propBc5.earnings;
  totalOpt10Bc += o10bc.earnings;
  totalOpt10 += o10.earnings;
}

console.log("Voting analysis complete:");
console.log(`  Actual earnings:        $${round(totalActual)}`);
console.log(`  Proportional BC+S top-5: $${round(totalPropBc5)}`);
console.log(`  Optimal BC (10 pools):  $${round(totalOpt10Bc)}`);
console.log(`  Optimal (10 pools):     $${round(totalOpt10)}`);
