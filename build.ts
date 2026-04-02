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
  eq_bc3_votes: number;
  eq_bc3_vote_pct: number;
  eq_bc3_earnings_usd: number;
  opt_10bc_votes: number;
  opt_10bc_vote_pct: number;
  opt_10bc_earnings_usd: number;
  opt_10_votes: number;
  opt_10_vote_pct: number;
  opt_10_earnings_usd: number;
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

const apr = (earn: number, votes: number, aeroUsd: number) => {
  const val = votes * aeroUsd;
  return val > 0 ? (((365 / 7) * earn) / val) * 100 : 0;
};

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
    eq_bc3_votes: p("eq_bc3_votes", c),
    eq_bc3_vote_pct: p("eq_bc3_vote_pct", c),
    eq_bc3_earnings_usd: p("eq_bc3_earnings_usd", c),
    opt_10bc_votes: p("opt_10bc_votes", c),
    opt_10bc_vote_pct: p("opt_10bc_vote_pct", c),
    opt_10bc_earnings_usd: p("opt_10bc_earnings_usd", c),
    opt_10_votes: p("opt_10_votes", c),
    opt_10_vote_pct: p("opt_10_vote_pct", c),
    opt_10_earnings_usd: p("opt_10_earnings_usd", c),
  });
}

records.sort((a, b) => b.epoch_ts - a.epoch_ts || b.pool_votes - a.pool_votes);

const voterAddress = records[0]?.voter_address ?? "unknown";

// 2. Compute epoch totals
const epochTotals = new Map<number, number>();
const actualVotesByEpoch = new Map<number, number>();
for (const r of records) {
  epochTotals.set(r.epoch_ts, r.pool_votes_total);
  actualVotesByEpoch.set(
    r.epoch_ts,
    (actualVotesByEpoch.get(r.epoch_ts) ?? 0) + r.actual_votes
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

// 4. Compute per-epoch summary for charts
type EpochSummary = {
  date: string;
  epochNum: number;
  aeroUsd: number;
  actualEarn: number;
  eqBc3Earn: number;
  opt10BcEarn: number;
  opt10Earn: number;
  actualApr: number;
  eqBc3Apr: number;
  opt10BcApr: number;
  opt10Apr: number;
};

const epochSummaries: EpochSummary[] = [];
for (const [ts, epochRecords] of byEpoch) {
  const first = epochRecords[0];
  const trueActualVotes = actualVotesByEpoch.get(ts) ?? 0;
  const sum = (fn: (r: EpochRecord) => number) =>
    epochRecords.reduce((s, r) => s + fn(r), 0);
  const actualEarn = sum((r) => r.actual_earnings_usd);
  const eqBc3Earn = sum((r) => r.eq_bc3_earnings_usd);
  const opt10BcEarn = sum((r) => r.opt_10bc_earnings_usd);
  const opt10Earn = sum((r) => r.opt_10_earnings_usd);
  const eqBc3Votes = sum((r) => r.eq_bc3_votes);
  const opt10BcVotes = sum((r) => r.opt_10bc_votes);
  const opt10Votes = sum((r) => r.opt_10_votes);

  epochSummaries.push({
    date: first.epoch_date,
    epochNum: first.epoch_number,
    aeroUsd: first.aero_usd,
    actualEarn,
    eqBc3Earn,
    opt10BcEarn,
    opt10Earn,
    actualApr: apr(actualEarn, trueActualVotes, first.aero_usd),
    eqBc3Apr: apr(eqBc3Earn, eqBc3Votes, first.aero_usd),
    opt10BcApr: apr(opt10BcEarn, opt10BcVotes, first.aero_usd),
    opt10Apr: apr(opt10Earn, opt10Votes, first.aero_usd),
  });
}
epochSummaries.sort(
  (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
);

// Compute shared y-axis scale from 1-year data
const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norms = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const n = v / mag;
  for (const s of norms) if (s >= n) return s * mag;
  return 10 * mag;
};

// SVG chart generator
function buildSvg(data: EpochSummary[], id: string): string {
  if (data.length === 0) return "";

  // Scales — unified: $100k earnings ≡ 100% APR (ratio: $1k per 1%)
  const maxEarn = Math.max(
    ...data.map((d) => Math.max(d.actualEarn, d.eqBc3Earn, d.opt10BcEarn))
  );
  const maxApr = Math.max(
    ...data.map((d) => Math.max(d.actualApr, d.eqBc3Apr, d.opt10BcApr))
  );
  const yMax = niceMax(Math.max(maxEarn, maxApr * 1000));

  // AERO price scale
  const maxAero = Math.max(...data.map((d) => d.aeroUsd));
  const yMaxAero = niceMax(maxAero);

  const W = 1000,
    H = 420;
  const ml = 96,
    mr = 58,
    mt = 56,
    mb = 52;
  const pw = W - ml - mr,
    ph = H - mt - mb;

  const x = (i: number) =>
    ml + (data.length > 1 ? i / (data.length - 1) : 0.5) * pw;
  const yE = (v: number) => mt + ph - (v / yMax) * ph;
  // APR shares the same pixel mapping: aprValue * 1000 → same scale as earnings
  const yA = (v: number) => mt + ph - ((v * 1000) / yMax) * ph;
  const yP = (v: number) => mt + ph - (v / yMaxAero) * ph;

  // Polyline builders
  const polyE = (fn: (d: EpochSummary) => number) =>
    data.map((d, i) => `${x(i).toFixed(1)},${yE(fn(d)).toFixed(1)}`).join(" ");
  const polyA = (fn: (d: EpochSummary) => number) =>
    data.map((d, i) => `${x(i).toFixed(1)},${yA(fn(d)).toFixed(1)}`).join(" ");
  const polyP = data
    .map((d, i) => `${x(i).toFixed(1)},${yP(d.aeroUsd).toFixed(1)}`)
    .join(" ");

  const colors = {
    actual: "#666",
    eqBc3: "#3b82f6",
    opt10Bc: "#22a34a",
    opt10: "#ca8a04",
    aero: "#dc2626",
  };

  // Y-axis ticks (unified scale, 5 ticks)
  const ticks = Array.from({ length: 6 }, (_, i) => (i * yMax) / 5);

  // X-axis ticks at round epoch numbers (multiples of 5 or 10)
  const epochMin = data[0].epochNum;
  const epochMax = data[data.length - 1].epochNum;
  const epochRange = epochMax - epochMin;
  const epochStep =
    epochRange <= 8 ? 1 : epochRange <= 30 ? 5 : epochRange <= 60 ? 10 : 20;
  const firstTick = Math.ceil(epochMin / epochStep) * epochStep;
  const epochByNum = new Map(data.map((d, i) => [d.epochNum, i]));
  const xIndices: number[] = [];
  for (let e = firstTick; e <= epochMax; e += epochStep) {
    const idx = epochByNum.get(e);
    if (idx !== undefined) xIndices.push(idx);
  }

  // Grid lines
  const gridLines = ticks
    .map(
      (v) =>
        `<line x1="${ml}" x2="${W - mr}" y1="${yE(v).toFixed(1)}" y2="${yE(
          v
        ).toFixed(1)}" stroke="#d1d5db" stroke-width="0.6"/>`
    )
    .join("");

  // Left y-axis labels (k$ / %)
  const yLabels = ticks
    .map((v) => {
      const kVal = v / 1000;
      const kStr = kVal % 1 === 0 ? kVal.toFixed(0) : kVal.toFixed(1);
      const label =
        v === 0
          ? "0"
          : `<tspan class="earn-lines">${kStr}k</tspan><tspan opacity="0.3"> / </tspan><tspan class="apr-lines">${kStr}%</tspan>`;
      return `<text x="${ml - 6}" y="${yE(v).toFixed(
        1
      )}" text-anchor="end" dominant-baseline="middle" fill="#555" font-size="14">${label}</text>`;
    })
    .join("");

  // X-axis labels
  const xLabels = xIndices
    .map((i) => {
      const d = data[i];
      const endDate = new Date(d.date + "T00:00:00Z");
      endDate.setUTCDate(endDate.getUTCDate() + 7);
      const end = endDate.toISOString().slice(0, 10); // YYYY-MM-DD
      return `<g transform="translate(${x(i).toFixed(1)},${mt + ph + 6})">
        <text text-anchor="middle" dominant-baseline="hanging" fill="#555" font-size="13">Epoch ${
          d.epochNum
        }</text>
        <text text-anchor="middle" y="17" dominant-baseline="hanging" fill="#888" font-size="13">${end}</text>
      </g>`;
    })
    .join("");

  // Legend (grid: rows = Earnings/APR, columns = strategies)
  const strategies = [
    { label: "Actual", earn: colors.actual },
    { label: "EqBC3", earn: colors.eqBc3 },
    { label: "Opt10BC", earn: colors.opt10Bc },
    { label: "Opt10", earn: colors.opt10 },
  ];
  const colW = 105;
  const rowH = 16;
  const labelColW = 65;
  const aeroLegendW = 80;
  const gap = 20;
  const totalLegendW = labelColW + strategies.length * colW + gap + aeroLegendW;
  const legendX = (W - totalLegendW) / 2;
  const legendY = 6;
  const aeroX = labelColW + strategies.length * colW + gap;
  const ll = (cx: number, cy: number, color: string, extra = "") =>
    `<line x1="${cx - 14}" y1="${cy}" x2="${
      cx + 14
    }" y2="${cy}" stroke="${color}" ${extra}/>`;
  // Use the exact same stroke styles as the data polylines
  const earnStyle = `stroke-width="1.8"`;
  const aprStyle = `stroke-width="1.5"`;
  const aeroStyle = `stroke-width="1.5" stroke-dasharray="6,4"`;
  const legend =
    `<g transform="translate(${legendX},${legendY})">` +
    // Header row: strategy names
    strategies
      .map(
        (s, i) =>
          `<text x="${
            labelColW + i * colW + colW / 2
          }" y="0" text-anchor="middle" fill="#333" font-size="14" font-weight="600" dominant-baseline="hanging">${
            s.label
          }</text>`
      )
      .join("") +
    // Earnings row
    `<g class="earn-lines">` +
    `<text x="0" y="${rowH}" fill="#555" font-size="13" dominant-baseline="hanging">Earnings</text>` +
    strategies
      .map((s, i) =>
        ll(labelColW + i * colW + colW / 2, rowH + 6, s.earn, earnStyle)
      )
      .join("") +
    `</g>` +
    // APR row
    `<g class="apr-lines">` +
    `<text x="0" y="${
      rowH * 2
    }" fill="#555" font-size="13" dominant-baseline="hanging">APR</text>` +
    strategies
      .map((s, i) =>
        ll(labelColW + i * colW + colW / 2, rowH * 2 + 6, s.earn, aprStyle)
      )
      .join("") +
    `</g>` +
    // AERO price (right of grid, vertically centered)
    `<text x="${
      aeroX + aeroLegendW / 2
    }" y="0" text-anchor="middle" fill="#333" font-size="14" font-weight="600" dominant-baseline="hanging">AERO</text>` +
    ll(aeroX + aeroLegendW / 2, rowH + 12, colors.aero, aeroStyle) +
    `</g>`;

  // Axis titles
  const yTitle = `<text transform="rotate(-90)" x="${-(
    mt +
    ph / 2
  )}" y="14" text-anchor="middle" fill="#555" font-size="15" font-weight="600">Earnings (USD) / APR (%)</text>`;
  const yRightTitle = `<text transform="rotate(90)" x="${mt + ph / 2}" y="${-(
    W - 14
  )}" text-anchor="middle" fill="#555" font-size="15" font-weight="600">AERO (USD)</text>`;

  // Right y-axis ticks and labels (AERO price)
  const aeroTicks = Array.from({ length: 6 }, (_, i) => (i * yMaxAero) / 5);
  const aeroLabels = aeroTicks
    .map((v) => {
      const label = v.toFixed(1);
      return `<text x="${W - mr + 6}" y="${yP(v).toFixed(
        1
      )}" text-anchor="start" dominant-baseline="middle" fill="#555" font-size="14">${label}</text>`;
    })
    .join("");

  // Tick marks sticking out of axes
  const tk = 5; // tick length
  const yTickMarks = ticks
    .map(
      (v) =>
        `<line x1="${ml - tk}" x2="${ml}" y1="${yE(v).toFixed(1)}" y2="${yE(
          v
        ).toFixed(1)}" stroke="#bbb" stroke-width="1"/>`
    )
    .join("");
  const yRightTickMarks = aeroTicks
    .map(
      (v) =>
        `<line x1="${W - mr}" x2="${W - mr + tk}" y1="${yP(v).toFixed(
          1
        )}" y2="${yP(v).toFixed(1)}" stroke="#bbb" stroke-width="1"/>`
    )
    .join("");
  const xTickMarks = xIndices
    .map(
      (i) =>
        `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${
          mt + ph
        }" y2="${mt + ph + tk}" stroke="#bbb" stroke-width="1"/>`
    )
    .join("");

  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%" role="img" aria-label="Earnings and APR chart">
    <defs><clipPath id="${id}-clip"><rect x="${ml}" y="${mt}" width="${pw}" height="${ph}"/></clipPath></defs>
    <rect width="${W}" height="${H}" fill="white" rx="4"/>
    ${legend}
    ${gridLines}
    <!-- axes -->
    <line x1="${ml}" x2="${ml}" y1="${mt}" y2="${mt + ph}" stroke="#bbb"/>
    <line x1="${W - mr}" x2="${W - mr}" y1="${mt}" y2="${
    mt + ph
  }" stroke="#bbb"/>
    <line x1="${ml}" x2="${W - mr}" y1="${mt + ph}" y2="${
    mt + ph
  }" stroke="#bbb"/>
    ${yTickMarks}${yRightTickMarks}${xTickMarks}
    ${yLabels}${aeroLabels}${xLabels}
    ${yTitle}${yRightTitle}
    <!-- data lines (clipped to plot area) -->
    <g clip-path="url(#${id}-clip)">
      <g class="apr-lines">
        <polyline points="${polyA((d) => d.opt10Apr)}" fill="none" stroke="${
    colors.opt10
  }" stroke-width="1.5"/>
        <polyline points="${polyA((d) => d.opt10BcApr)}" fill="none" stroke="${
    colors.opt10Bc
  }" stroke-width="1.5"/>
        <polyline points="${polyA((d) => d.eqBc3Apr)}" fill="none" stroke="${
    colors.eqBc3
  }" stroke-width="1.5"/>
        <polyline points="${polyA((d) => d.actualApr)}" fill="none" stroke="${
    colors.actual
  }" stroke-width="1.5"/>
      </g>
      <g class="earn-lines">
        <polyline points="${polyE((d) => d.opt10Earn)}" fill="none" stroke="${
    colors.opt10
  }" stroke-width="1.8"/>
        <polyline points="${polyE((d) => d.opt10BcEarn)}" fill="none" stroke="${
    colors.opt10Bc
  }" stroke-width="1.8"/>
        <polyline points="${polyE((d) => d.eqBc3Earn)}" fill="none" stroke="${
    colors.eqBc3
  }" stroke-width="1.8"/>
        <polyline points="${polyE((d) => d.actualEarn)}" fill="none" stroke="${
    colors.actual
  }" stroke-width="1.8"/>
      </g>
      <polyline points="${polyP}" fill="none" stroke="${
    colors.aero
  }" stroke-width="1.5" stroke-dasharray="6,4"/>
    </g>
  </svg>`;
}

// Build chart variants with independent y-scales
const oneYearAgo = new Date();
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
const last1yData = epochSummaries.filter((d) => new Date(d.date) >= oneYearAgo);
const oneMonthAgo = new Date();
oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
const last1mData = epochSummaries.filter(
  (d) => new Date(d.date) >= oneMonthAgo
);
const svg1m = buildSvg(
  last1mData.length > 1 ? last1mData : epochSummaries,
  "chart-1m-svg"
);
const sixMonthsAgo = new Date();
sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
const last6mData = epochSummaries.filter(
  (d) => new Date(d.date) >= sixMonthsAgo
);
const svg6m = buildSvg(
  last6mData.length > 1 ? last6mData : epochSummaries,
  "chart-6m-svg"
);
const svg1y = buildSvg(
  last1yData.length > 1 ? last1yData : epochSummaries,
  "chart-1y-svg"
);
const svgAll = buildSvg(epochSummaries, "chart-all-svg");

// 5. Build HTML sections (one <details> per epoch)
const sections: string[] = [];
for (let i = 0; i < sortedEpochs.length; i++) {
  const [, epochRecords] = sortedEpochs[i];
  epochRecords.sort((a, b) => b.pool_votes - a.pool_votes);
  const first = epochRecords[0];

  const trueVotes = epochTotals.get(first.epoch_ts) ?? 0;
  const trueActualVotes = actualVotesByEpoch.get(first.epoch_ts) ?? 0;

  const sum = (fn: (r: EpochRecord) => number) =>
    epochRecords.reduce((s, r) => s + fn(r), 0);

  const totalPoolVotes = sum((r) => r.pool_votes);
  const totalPoolFeesBribes = sum((r) => r.fees_bribes_usd);
  const totalPoolApr = apr(totalPoolFeesBribes, totalPoolVotes, first.aero_usd);
  const totalActualEarn = sum((r) => r.actual_earnings_usd);
  const totalEqBc3Votes = sum((r) => r.eq_bc3_votes);
  const totalEqBc3Earn = sum((r) => r.eq_bc3_earnings_usd);
  const totalOpt10BcVotes = sum((r) => r.opt_10bc_votes);
  const totalOpt10BcEarn = sum((r) => r.opt_10bc_earnings_usd);
  const totalOpt10Votes = sum((r) => r.opt_10_votes);
  const totalOpt10Earn = sum((r) => r.opt_10_earnings_usd);

  const totalActualApr = apr(totalActualEarn, trueActualVotes, first.aero_usd);
  const totalEqBc3Apr = apr(totalEqBc3Earn, totalEqBc3Votes, first.aero_usd);
  const totalOpt10BcApr = apr(
    totalOpt10BcEarn,
    totalOpt10BcVotes,
    first.aero_usd
  );
  const totalOpt10Apr = apr(totalOpt10Earn, totalOpt10Votes, first.aero_usd);

  const epochTiming =
    i === 0
      ? `as of ${new Date()
          .toISOString()
          .replace("T", " ")
          .replace(/:\d{2}\.\d+Z$/, " UTC")}`
      : `until ${sortedEpochs[i - 1][1][0].epoch_date} 00:00 UTC`;

  const totalRow = `          <tr class="total">
            <td></td>
            <td>Total Votes / APR / Earnings</td>
            <td></td>
            <td class="right">${fmt(trueVotes)}</td>
            <td class="right">${totalPoolApr.toFixed(2)}%</td>
            <td class="right">${usdFmt(totalPoolFeesBribes)}</td>
            <td></td>
            <td></td>
            <td></td>
            <td class="sep right">${fmt(trueActualVotes)}</td>
            <td class="right">${totalActualApr.toFixed(2)}%</td>
            <td class="right">${usdFmt(totalActualEarn)}</td>
            <td class="sep right">${fmt(totalEqBc3Votes)}</td>
            <td class="right">${totalEqBc3Apr.toFixed(2)}%</td>
            <td class="right">${usdFmt(totalEqBc3Earn)}</td>
            <td class="sep right">${fmt(totalOpt10BcVotes)}</td>
            <td class="right">${totalOpt10BcApr.toFixed(2)}%</td>
            <td class="right">${usdFmt(totalOpt10BcEarn)}</td>
            <td class="sep right">${fmt(totalOpt10Votes)}</td>
            <td class="right">${totalOpt10Apr.toFixed(2)}%</td>
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
            <td class="sep right">${fmt(r.eq_bc3_votes)}</td>
            <td class="right">${r.eq_bc3_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.eq_bc3_earnings_usd)}</td>
            <td class="sep right">${fmt(r.opt_10bc_votes)}</td>
            <td class="right">${r.opt_10bc_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.opt_10bc_earnings_usd)}</td>
            <td class="sep right">${fmt(r.opt_10_votes)}</td>
            <td class="right">${r.opt_10_vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.opt_10_earnings_usd)}</td>
          </tr>`;
    })
    .join("\n");

  sections.push(`  <details>
    <summary>Epoch ${first.epoch_number} ${epochTiming}</summary>
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
            <th class="sep right">${i === 0 ? "Current" : "Actual"} Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
            <th class="sep right">EqBC3 Votes</th>
            <th class="right">%</th>
            <th class="right">Earned</th>
            <th class="sep right">Opt10BC Votes</th>
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

// 5b. Build strategy votes for latest epoch
const latestRecords = sortedEpochs[0]?.[1] ?? [];
const latestEpochHeading = `Current strategies as of ${new Date()
  .toISOString()
  .replace("T", " ")
  .replace(/:\d{2}\.\d+Z$/, " UTC")}`;

const buildVoteList = (
  label: string,
  voteFn: (r: EpochRecord) => number,
  pctFn: (r: EpochRecord) => number,
  earnFn: (r: EpochRecord) => number
) => {
  const items = latestRecords
    .filter((r) => Math.round(pctFn(r)) > 0)
    .sort((a, b) => pctFn(b) - pctFn(a))
    .map(
      (r) =>
        `        <li>${escapeHtml(r.pool_name)} \u2013 ${pctFn(r).toFixed(
          1
        )}%</li>`
    )
    .join("\n");
  if (!items) return "";
  const totalEarn = latestRecords.reduce((s, r) => s + earnFn(r), 0);
  return `      <div class="vote-strategy"><strong>${label}</strong><ul>\n${items}\n      </ul><p class="vote-earnings">Earnings: ${usdFmt(
    totalEarn
  )}</p></div>`;
};

const strategyVotesHtml = [
  buildVoteList(
    "Current Votes",
    (r) => r.actual_votes,
    (r) => r.actual_vote_pct,
    (r) => r.actual_earnings_usd
  ),
  buildVoteList(
    "EqBC3 Votes",
    (r) => r.eq_bc3_votes,
    (r) => r.eq_bc3_vote_pct,
    (r) => r.eq_bc3_earnings_usd
  ),
  buildVoteList(
    "Opt10BC Votes",
    (r) => r.opt_10bc_votes,
    (r) => r.opt_10bc_vote_pct,
    (r) => r.opt_10bc_earnings_usd
  ),
  buildVoteList(
    "Opt10 Votes",
    (r) => r.opt_10_votes,
    (r) => r.opt_10_vote_pct,
    (r) => r.opt_10_earnings_usd
  ),
]
  .filter(Boolean)
  .join("\n");

// 6. Write index.html
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
    .voter { font-size: .85rem; margin-bottom: .5rem; color: #555; }
    .intro { font-size: .85rem; line-height: 1.5; color: #444; margin-bottom: 1rem; max-width: 80ch; }
    .intro p { margin-bottom: .4rem; }
    .intro ul { margin: .3rem 0 .4rem 1.4rem; }
    .intro li { margin-bottom: .15rem; }
    .intro span { padding: .1rem .3rem; border-radius: 3px; font-size: .8rem; }
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
    /* Strategy votes */
    .strategy-votes { margin-bottom: 1rem; }
    .strategy-votes h2 { font-size: 1.1rem; margin-bottom: .4rem; }
    .strategy-votes > p { font-size: .85rem; color: #555; margin-bottom: .6rem; }
    .strategy-votes .vote-strategy { margin-bottom: .5rem; font-size: .85rem; }
    .strategy-votes ul { list-style: none; padding: 0; font-variant-numeric: tabular-nums; }
    .strategy-votes li { padding: .15rem 0; }
    .vote-strategy { display: inline-block; vertical-align: top; margin-right: 2rem; }
    .vote-strategy strong { display: block; margin-bottom: .2rem; }
    .vote-earnings { margin-top: .3rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    /* Chart toggle */
    .chart-wrap { margin-bottom: 1rem; overflow: hidden; resize: horizontal; width: min(1200px, 100%); }
    .chart-wrap > input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
    .chart-toggle { display: inline-flex; border-radius: 6px; overflow: hidden; border: 1px solid #d1d5db; margin-bottom: .6rem; }
    .chart-toggle label { padding: .4rem 1rem; font-size: .82rem; font-weight: 600; cursor: pointer; background: #fff; color: #666; transition: background .15s, color .15s; user-select: none; border-right: 1px solid #d1d5db; }
    .chart-toggle label:last-child { border-right: none; }
    .chart-toggle label:hover { background: #f3f4f6; }
    #chart-range-1m:checked ~ .chart-toggles label[for="chart-range-1m"],
    #chart-range-6m:checked ~ .chart-toggles label[for="chart-range-6m"],
    #chart-range-1y:checked ~ .chart-toggles label[for="chart-range-1y"],
    #chart-range-all:checked ~ .chart-toggles label[for="chart-range-all"] { background: #2563eb; color: #fff; }
    .chart-1m-wrap, .chart-6m-wrap, .chart-1y-wrap, .chart-all-wrap { display: none; }
    #chart-range-1m:checked ~ .chart-1m-wrap { display: block; }
    #chart-range-6m:checked ~ .chart-6m-wrap { display: block; }
    #chart-range-1y:checked ~ .chart-1y-wrap { display: block; }
    #chart-range-all:checked ~ .chart-all-wrap { display: block; }
    /* Focus toggle (earnings vs APR) */
    .chart-toggles { display: flex; gap: .6rem; align-items: center; margin-bottom: .6rem; }
    #chart-focus-earn:checked ~ .chart-toggles label[for="chart-focus-earn"],
    #chart-focus-apr:checked ~ .chart-toggles label[for="chart-focus-apr"] { background: #2563eb; color: #fff; }
    .earn-lines, .apr-lines { transition: opacity .2s; }
    #chart-focus-earn:checked ~ div .apr-lines { opacity: 0.3; }
    #chart-focus-apr:checked ~ div .earn-lines { opacity: 0.3; }
  </style>
</head>
<body>
  <h1>Aerodrome Votes \u2192 <a href="votes.csv">votes.csv</a></h1>
  <p class="voter">Voter: <code>${escapeHtml(voterAddress)}</code></p>
  <div class="intro">
    <p>This dashboard tracks weekly earnings from a voter on <a href="https://aerodrome.finance">Aerodrome Finance</a> and compares the voter's actual results against alternative allocation strategies. Each epoch lasts one week; the voter locks AERO tokens and distributes votes across liquidity pools to earn a share of each pool's fees and bribes, proportional to their vote share.</p>
    <p>The chart below plots actual and predicted earnings and APR per epoch. Four voting strategies are shown:</p>
    <ul>
      <li><strong>Actual</strong> \u2013 the voter's real vote allocation and resulting earnings.</li>
      <li><strong>EqBC3</strong> \u2013 votes split proportionally across the top 3 blue-chip pools by fees + bribes.</li>
      <li><strong>Opt10BC</strong> \u2013 votes optimally allocated across up to 10 blue-chip pools to maximize earnings (water-filling optimization).</li>
      <li><strong>Opt10</strong> \u2013 same optimization but across all pools, not limited to blue chips.</li>
    </ul>
  </div>
  <div class="chart-wrap">
    <input type="radio" name="chart-range" id="chart-range-1m" checked>
    <input type="radio" name="chart-range" id="chart-range-6m">
    <input type="radio" name="chart-range" id="chart-range-1y">
    <input type="radio" name="chart-range" id="chart-range-all">
    <input type="radio" name="chart-focus" id="chart-focus-earn" checked>
    <input type="radio" name="chart-focus" id="chart-focus-apr">
    <div class="chart-toggles">
      <div class="chart-toggle">
        <label for="chart-range-1m">1 Month</label>
        <label for="chart-range-6m">6 Months</label>
        <label for="chart-range-1y">1 Year</label>
        <label for="chart-range-all">All Time</label>
      </div>
      <div class="chart-toggle">
        <label for="chart-focus-earn">Earnings</label>
        <label for="chart-focus-apr">APR</label>
      </div>
    </div>
    <div class="chart-1m-wrap">${svg1m}</div>
    <div class="chart-6m-wrap">${svg6m}</div>
    <div class="chart-1y-wrap">${svg1y}</div>
    <div class="chart-all-wrap">${svgAll}</div>
  </div>
  <div class="strategy-votes">
    <h2>${latestEpochHeading}</h2>
    <p>Vote allocation across pools for each strategy in the current epoch.</p>
${strategyVotesHtml}
  </div>
  <p class="intro">The tables below shows the per-pool breakdown for every strategy for each epoch. Pool types are color-coded: <span class="bluechip">blue chip</span>, <span class="stablecoin">stable</span>, <span class="aero">aero</span>, and <span class="new">new</span>.</p>
${sections.join("\n")}
</body>
</html>`;

writeFileSync("index.html", html);
console.log(
  `Built index.html from votes.csv (${records.length} records, ${sortedEpochs.length} epochs)`
);
