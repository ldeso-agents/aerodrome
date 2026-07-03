import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Deployed contracts on Base
// Sugar addresses: https://github.com/velodrome-finance/sugar/blob/main/deployments/base.env
const LP_SUGAR = "0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe" as const;
const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as const;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as const;
// Used only if Voter.minter() reverts
const MINTER_FALLBACK = "0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5" as const;

// The pool we own and could farm: vAMM-kVCM/USDC
const POOL = "0x5C0D76fab1822bDeb47308eD6028231761ED723E" as const;

const WEEK = 7 * 24 * 3600;
const EPOCHS_PER_YEAR = 365 / 7;
const TRAILING_EPOCHS = 4;

// -- ABI fragments (only what we use) --

const voterAbi = parseAbi([
  "function minter() view returns (address)",
  "function totalWeight() view returns (uint256)",
  "function weights(address _pool) view returns (uint256)",
]);

const minterAbi = parseAbi(["function weekly() view returns (uint256)"]);

const lpSugarAbi = parseAbi([
  "function all(uint256 _limit, uint256 _offset, uint256 _filter) view returns ((address lp, string symbol, uint8 decimals, uint256 liquidity, int24 type, int24 tick, uint160 sqrt_ratio, address token0, uint256 reserve0, uint256 staked0, address token1, uint256 reserve1, uint256 staked1, address gauge, uint256 gauge_liquidity, bool gauge_alive, address fee, address bribe, address factory, uint256 emissions, address emissions_token, uint256 emissions_cap, uint256 pool_fee, uint256 unstaked_fee, uint256 token0_fees, uint256 token1_fees, uint256 locked, uint256 emerging, uint32 created_at, address nfpm, address alm, address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address, string symbol, uint8 decimals, uint256 account_balance, bool listed, bool emerging)[])",
]);

const PAGE = 200;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

// Cross-sectional hurdle population: live gauges with at least this much
// staked TVL — below it, displayed vAPRs are dust-pool noise.
const HURDLE_TVL_FLOOR = 100_000;
// External-LP inflow classification (pool-history.csv, LP units): the relative
// term filters compounding noise once the gauge is large, the absolute term
// handles early epochs where external LP is near zero.
const INFLOW_REL = 0.02; // of gauge supply
const INFLOW_ABS = 0.005; // of pool supply

// -- Types --

type TokenMeta = { symbol: string; decimals: number };
type OtherPool = {
  name: string;
  votes: number; // our current votes on the pool
  otherVotes: number; // votes from everyone else
  reward: number; // fees + bribes USD, latest epoch
};
type RawGauge = {
  lp: string;
  symbol: string;
  type: number; // -1 volatile vAMM, 0 stable, >0 CL tick spacing
  token0: string;
  token1: string;
  staked0: bigint;
  staked1: bigint;
  emissionsPerSec: number; // AERO/sec
};
type GaugeStat = { lp: string; symbol: string; type: number; stakedTvlUsd: number; vapr: number };
type HistRow = {
  epoch: number;
  date: string;
  status: string;
  gaugeLp: number;
  ourLp: number;
  poolLp: number;
  externalLp: number;
  stakedTvlUsd: number;
  vapr: number;
};

// -- Helpers (same conventions as fetch.ts) --

const MAX_RETRIES = 10;
const MAX_BACKOFF_S = 64;

/** Run an async function with exponential backoff on transient errors (timeouts, rate limits). */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTransient =
        err?.name === "TimeoutError" ||
        err?.details?.includes("timed out") ||
        err?.status === 429 ||
        err?.code === "ECONNRESET";
      if (isTransient && attempt < MAX_RETRIES) {
        const backoff = Math.min(2 ** attempt, MAX_BACKOFF_S);
        console.warn(
          `  ${
            err?.name ?? "Error"
          } (${label}), retrying in ${backoff}s (attempt ${
            attempt + 1
          }/${MAX_RETRIES})`
        );
        await new Promise((r) => setTimeout(r, backoff * 1000));
        continue;
      }
      throw err;
    }
  }
}

/** POST JSON with retries on 429. Throws on other non-2xx responses. */
async function postJson(url: string, body: object): Promise<any> {
  return withRetry(async () => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok)
      throw Object.assign(new Error(`HTTP ${resp.status} from ${url}`), {
        status: resp.status,
      });
    return resp.json();
  }, url);
}

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

function loadTokensCsv(): Map<string, TokenMeta> {
  const tokens = new Map<string, TokenMeta>();
  if (!existsSync("tokens.csv")) return tokens;
  const lines = readFileSync("tokens.csv", "utf-8").trimEnd().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [addr, symbol, decimalsStr] = lines[i].split(",");
    const decimals = parseInt(decimalsStr);
    if (!addr || !symbol || isNaN(decimals)) continue;
    tokens.set(addr, { symbol, decimals });
  }
  return tokens;
}

/** Latest cached price per token from prices.csv (fallback when Alchemy is unavailable). */
function loadLatestCachedPrices(): Map<string, { date: string; price: number }> {
  const latest = new Map<string, { date: string; price: number }>();
  if (!existsSync("prices.csv")) return latest;
  const lines = readFileSync("prices.csv", "utf-8").trimEnd().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [date, token, , priceStr] = lines[i].split(",");
    const price = parseFloat(priceStr);
    if (!date || !token || isNaN(price) || price < 0) continue;
    const prev = latest.get(token);
    if (!prev || date > prev.date) latest.set(token, { date, price });
  }
  return latest;
}

/** Current USD price of a token: latest daily point from Alchemy, else prices.csv cache. */
async function currentPriceUsd(
  addr: string,
  alchemyKey: string,
  cache: Map<string, { date: string; price: number }>
): Promise<{ price: number; date: string }> {
  if (alchemyKey) {
    try {
      const endTs = Math.floor(Date.now() / 1000);
      const json = await postJson(
        `https://api.g.alchemy.com/prices/v1/${alchemyKey}/tokens/historical`,
        {
          network: "base-mainnet",
          address: addr,
          startTime: new Date((endTs - 3 * 24 * 3600) * 1000).toISOString(),
          endTime: new Date(endTs * 1000).toISOString(),
          interval: "1d",
        }
      );
      const points = json.data ?? [];
      if (points.length > 0) {
        const last = points[points.length - 1];
        return {
          price: parseFloat(last.value),
          date: last.timestamp.slice(0, 10),
        };
      }
    } catch (e) {
      console.warn(`  Alchemy price failed for ${addr}: ${e}`);
    }
  }
  const cached = cache.get(addr);
  if (cached) return { price: cached.price, date: cached.date };
  throw new Error(`No price available for token ${addr}`);
}

/** Spot USD prices for many tokens via Alchemy's batch endpoint (25/request),
 * falling back to the prices.csv cache per token. In-memory only. */
async function batchSpotPrices(
  addrs: string[],
  alchemyKey: string,
  cache: Map<string, { date: string; price: number }>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (alchemyKey) {
    for (let i = 0; i < addrs.length; i += 25) {
      const chunk = addrs.slice(i, i + 25);
      try {
        const json = await postJson(
          `https://api.g.alchemy.com/prices/v1/${alchemyKey}/tokens/by-address`,
          { addresses: chunk.map((a) => ({ network: "base-mainnet", address: a })) }
        );
        for (const entry of json.data ?? []) {
          if (entry.error) continue;
          const usd = (entry.prices ?? []).find((p: any) => p.currency === "usd");
          const price = usd ? parseFloat(usd.value) : NaN;
          if (!isNaN(price) && price > 0) out.set(entry.address.toLowerCase(), price);
        }
      } catch (e) {
        console.warn(`  Alchemy batch prices failed (${chunk.length} tokens): ${e}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  for (const a of addrs) {
    if (out.has(a)) continue;
    const cached = cache.get(a);
    if (cached && cached.price > 0) out.set(a, cached.price);
  }
  return out;
}

/** vAPR at which cumulative staked TVL crosses quantile q (population sorted by vAPR). */
function weightedPercentile(stats: GaugeStat[], q: number): number {
  const sorted = [...stats].sort((a, b) => a.vapr - b.vapr);
  const total = sorted.reduce((s, x) => s + x.stakedTvlUsd, 0);
  let cum = 0;
  for (const x of sorted) {
    cum += x.stakedTvlUsd;
    if (cum >= q * total) return x.vapr;
  }
  return NaN;
}

/** pool-history.csv rows written by history.ts (npm run history). */
function loadPoolHistory(): HistRow[] {
  if (!existsSync("pool-history.csv")) return [];
  const lines = readFileSync("pool-history.csv", "utf-8").trimEnd().split("\n");
  const header = lines[0].split(",");
  const idx = (name: string) => header.indexOf(name);
  const rows: HistRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    rows.push({
      epoch: parseInt(c[idx("epoch_number")]),
      date: c[idx("epoch_date")],
      status: c[idx("status")],
      gaugeLp: parseFloat(c[idx("gauge_supply_lp")]),
      ourLp: parseFloat(c[idx("our_gauge_lp")]),
      poolLp: parseFloat(c[idx("pool_supply_lp")]),
      externalLp: parseFloat(c[idx("external_lp")]),
      stakedTvlUsd: parseFloat(c[idx("staked_tvl_usd")]),
      vapr: parseFloat(c[idx("displayed_vapr_pct")]),
    });
  }
  return rows.sort((a, b) => a.epoch - b.epoch);
}

type HistPoint = {
  epoch: number;
  date: string;
  stakedTvlUsd: number;
  vapr: number;
  dExtPct: number; // external LP change over the epoch, % of gauge supply
  inflow: boolean;
};

/** Classify each historical epoch as external-inflow vs quiet (LP units, so
 * price moves don't masquerade as flows) and locate the vAPR level that
 * separated them. ~40 points, so only order statistics — no fitting. */
function inferHistoricalCeiling(hist: HistRow[]) {
  const ok = hist.filter((r) => r.status === "ok" && r.stakedTvlUsd > 0);
  const points: HistPoint[] = [];
  for (let i = 0; i + 1 < ok.length; i++) {
    const cur = ok[i];
    const next = ok[i + 1];
    if (next.epoch !== cur.epoch + 1) continue;
    const dExt = next.externalLp - cur.externalLp;
    const inflow = dExt > Math.max(INFLOW_REL * cur.gaugeLp, INFLOW_ABS * cur.poolLp);
    points.push({
      epoch: cur.epoch,
      date: cur.date,
      stakedTvlUsd: cur.stakedTvlUsd,
      vapr: cur.vapr,
      dExtPct: cur.gaugeLp > 0 ? (dExt / cur.gaugeLp) * 100 : 0,
      inflow,
    });
  }
  const inflows = points.filter((p) => p.inflow);
  const quiets = points.filter((p) => !p.inflow);
  // Decision stump: cutoff minimizing misclassifications of "inflow iff vAPR > v"
  const candidates = [0, ...new Set(points.map((p) => p.vapr))].sort((a, b) => a - b);
  let stump = { vapr: 0, errors: Infinity };
  for (const v of candidates) {
    const errors = points.filter((p) => p.inflow !== p.vapr > v).length;
    if (errors < stump.errors) stump = { vapr: v, errors };
  }
  return {
    points,
    nInflow: inflows.length,
    minInflowVapr: inflows.length ? Math.min(...inflows.map((p) => p.vapr)) : NaN,
    maxQuietVapr: quiets.length ? Math.max(...quiets.map((p) => p.vapr)) : NaN,
    stump,
    // With fewer than 3 observed inflows the order statistics are anecdotes
    sufficient: inflows.length >= 3 && quiets.length >= 3,
  };
}

// -- Main --

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL environment variable is required");
  const alchemyKey = process.env.ALCHEMY_API_KEY ?? "";

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const read = (args: any) =>
    withRetry(() => client.readContract(args), args.functionName);

  // 1. On-chain snapshot
  console.log("Fetching on-chain snapshot…");
  let minter: Address;
  try {
    minter = (await read({
      address: VOTER,
      abi: voterAbi,
      functionName: "minter",
    })) as Address;
  } catch {
    console.warn(`  Voter.minter() failed, using fallback ${MINTER_FALLBACK}`);
    minter = MINTER_FALLBACK;
  }

  // This LpSugar deployment has no byAddress(), so page through all() like fetch.ts
  // does. While scanning, sum every live gauge's emission rate: only part of
  // Minter.weekly() reaches gauges on Aerodrome (the veAERO rebase and team
  // allocation are carved out of it), so the gauge total must be measured, not
  // derived from weekly().
  async function scanPools(): Promise<{
    pool: any;
    gaugesWeeklyAero: number;
    gauges: RawGauge[];
  }> {
    let pool: any;
    let totalRate = 0;
    const gauges: RawGauge[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = (await read({
        address: LP_SUGAR,
        abi: lpSugarAbi,
        functionName: "all",
        args: [BigInt(PAGE), BigInt(offset), 0n],
      })) as any[];
      for (const p of page) {
        if (p.gauge_alive) totalRate += Number(p.emissions) / 1e18;
        // Same pages feed the cross-sectional vAPR distribution: every live
        // gauge that is actually streaming emissions is a farming venue.
        if (p.gauge_alive && Number(p.emissions) > 0) {
          gauges.push({
            lp: (p.lp as string).toLowerCase(),
            symbol: p.symbol,
            type: Number(p.type),
            token0: (p.token0 as string).toLowerCase(),
            token1: (p.token1 as string).toLowerCase(),
            staked0: p.staked0 as bigint,
            staked1: p.staked1 as bigint,
            emissionsPerSec: Number(p.emissions) / 1e18,
          });
        }
        if (p.lp.toLowerCase() === POOL.toLowerCase()) pool = p;
      }
      if (page.length < PAGE) break;
    }
    if (!pool) throw new Error(`Pool ${POOL} not found in LpSugar.all()`);
    return { pool, gaugesWeeklyAero: totalRate * WEEK, gauges };
  }

  const [weeklyRaw, totalWeightRaw, poolWeightRaw, scan] = await Promise.all([
    read({ address: minter, abi: minterAbi, functionName: "weekly" }),
    read({ address: VOTER, abi: voterAbi, functionName: "totalWeight" }),
    read({
      address: VOTER,
      abi: voterAbi,
      functionName: "weights",
      args: [POOL],
    }),
    scanPools(),
  ]);

  const { pool, gaugesWeeklyAero } = scan;
  const minterWeeklyAero = Number(weeklyRaw as bigint) / 1e18;
  const totalVotes = Number(totalWeightRaw as bigint) / 1e18;
  const poolVotes = Number(poolWeightRaw as bigint) / 1e18;
  if (gaugesWeeklyAero < 100_000 || gaugesWeeklyAero > minterWeeklyAero) {
    console.warn(
      `  Warning: measured gauge emissions ${fmt(
        gaugesWeeklyAero
      )} AERO/wk look implausible vs Minter.weekly() = ${fmt(minterWeeklyAero)}`
    );
  }

  // 2. Token metadata and prices
  const tokenMap = loadTokensCsv();
  const priceCache = loadLatestCachedPrices();
  const token0 = (pool.token0 as string).toLowerCase();
  const token1 = (pool.token1 as string).toLowerCase();
  const t0 = tokenMap.get(token0) ?? { symbol: "token0", decimals: 18 };
  const t1 = tokenMap.get(token1) ?? { symbol: "token1", decimals: 18 };

  console.log("Fetching prices…");
  const aeroPrice = await currentPriceUsd(AERO, alchemyKey, priceCache);
  const price0 = await currentPriceUsd(token0, alchemyKey, priceCache);
  const price1 = await currentPriceUsd(token1, alchemyKey, priceCache);

  // 3. Pool TVL
  const reserve0 = Number(pool.reserve0 as bigint) / 10 ** t0.decimals;
  const reserve1 = Number(pool.reserve1 as bigint) / 10 ** t1.decimals;
  const staked0 = Number(pool.staked0 as bigint) / 10 ** t0.decimals;
  const staked1 = Number(pool.staked1 as bigint) / 10 ** t1.decimals;
  const poolTvlUsd = reserve0 * price0.price + reserve1 * price1.price;
  const stakedTvlUsd = staked0 * price0.price + staked1 * price1.price;
  const gaugeRateAeroPerSec = Number(pool.emissions as bigint) / 1e18;

  // 3b. Cross-sectional hurdle: emissions-vAPR of every live gauge, weighted
  // by staked TVL. Mercenary capital equalizes returns at the margin, so where
  // the bulk of staked dollars sits is the market hurdle rate it farms at.
  console.log(`Pricing ${scan.gauges.length} live gauges for the market hurdle…`);
  const decimalsMap = new Map<string, number>();
  for (const [addr, meta] of tokenMap) decimalsMap.set(addr, meta.decimals);
  for (let offset = 0; ; offset += PAGE) {
    const page = (await read({
      address: LP_SUGAR,
      abi: lpSugarAbi,
      functionName: "tokens",
      args: [BigInt(PAGE), BigInt(offset), ZERO, []],
    })) as any[];
    for (const t of page)
      decimalsMap.set((t.token_address as string).toLowerCase(), t.decimals);
    if (page.length < PAGE) break;
  }
  const gaugeTokens = [
    ...new Set(scan.gauges.flatMap((g) => [g.token0, g.token1])),
  ].filter((a) => decimalsMap.has(a));
  const spotPrices = await batchSpotPrices(gaugeTokens, alchemyKey, priceCache);

  const gaugeStats: GaugeStat[] = [];
  let unpricedGauges = 0;
  for (const g of scan.gauges) {
    const d0 = decimalsMap.get(g.token0);
    const d1 = decimalsMap.get(g.token1);
    const p0 = spotPrices.get(g.token0);
    const p1 = spotPrices.get(g.token1);
    if (d0 === undefined || d1 === undefined || p0 === undefined || p1 === undefined) {
      unpricedGauges++;
      continue;
    }
    const staked =
      (Number(g.staked0) / 10 ** d0) * p0 + (Number(g.staked1) / 10 ** d1) * p1;
    if (staked <= 0) continue;
    gaugeStats.push({
      lp: g.lp,
      symbol: g.symbol,
      type: g.type,
      stakedTvlUsd: staked,
      vapr:
        ((g.emissionsPerSec * WEEK * EPOCHS_PER_YEAR * aeroPrice.price) / staked) * 100,
    });
  }
  const eligible = gaugeStats.filter(
    (s) => s.stakedTvlUsd >= HURDLE_TVL_FLOOR && s.lp !== POOL.toLowerCase()
  );
  const setStats = (set: GaugeStat[]) => ({
    n: set.length,
    tvl: set.reduce((s, x) => s + x.stakedTvlUsd, 0),
    p25: weightedPercentile(set, 0.25),
    p50: weightedPercentile(set, 0.5),
    p75: weightedPercentile(set, 0.75),
  });
  const ammSet = eligible.filter((s) => s.type <= 0); // volatile + stable AMMs, like ours
  const clSet = eligible.filter((s) => s.type > 0);
  const bucketEdges = [0, 10, 20, 40, 80, Infinity];
  const buckets = bucketEdges.slice(0, -1).map((lo, i) => {
    const hi = bucketEdges[i + 1];
    const inBucket = ammSet.filter((s) => s.vapr >= lo && s.vapr < hi);
    const tvl = inBucket.reduce((s, x) => s + x.stakedTvlUsd, 0);
    return {
      label: isFinite(hi) ? `${lo}–${hi}%` : `${lo}%+`,
      count: inBucket.length,
      tvlSharePct: 0, // filled below once the AMM total is known
      tvl,
    };
  });
  const ammTvl = ammSet.reduce((s, x) => s + x.stakedTvlUsd, 0);
  for (const b of buckets) b.tvlSharePct = ammTvl > 0 ? (b.tvl / ammTvl) * 100 : 0;
  const crossSection = {
    nGauges: scan.gauges.length,
    nPriced: gaugeStats.length,
    unpricedGauges,
    tvlFloor: HURDLE_TVL_FLOOR,
    amm: setStats(ammSet),
    cl: setStats(clSet),
    all: setStats(eligible),
    buckets: buckets.map(({ tvl, ...b }) => b),
  };
  console.log(
    `  priced ${gaugeStats.length}/${scan.gauges.length} live gauges (${unpricedGauges} unpriced); ` +
      `AMM hurdle p25/p50/p75 = ${crossSection.amm.p25.toFixed(1)}/${crossSection.amm.p50.toFixed(
        1
      )}/${crossSection.amm.p75.toFixed(1)}% across ${ammSet.length} gauges ($${fmt(ammTvl)})`
  );

  // 3c. Historical evidence: at which displayed vAPR did external LP actually
  // arrive in our own gauge? (pool-history.csv is maintained by `npm run history`.)
  const poolHist = loadPoolHistory();
  const historical = inferHistoricalCeiling(poolHist);
  if (historical.points.length > 0) {
    console.log(
      `  history: ${historical.points.length} epochs, ${historical.nInflow} inflows; ` +
        `min inflow vAPR ${historical.minInflowVapr.toFixed(1)}%, ` +
        `stump ${historical.stump.vapr.toFixed(1)}% (${historical.stump.errors} errors), ` +
        `max quiet ${historical.maxQuietVapr.toFixed(1)}%`
    );
  } else {
    console.warn("  no pool-history.csv — run `npm run history` for the historical ceiling");
  }

  // Deterrence default: the strictest defensible ceiling both methods support.
  const ceilingCandidates = [
    crossSection.amm.p25,
    historical.sufficient ? historical.minInflowVapr : NaN,
  ].filter((v) => isFinite(v));
  const inferredCeiling = ceilingCandidates.length
    ? Math.min(50, Math.max(5, Math.round(Math.min(...ceilingCandidates))))
    : 20;

  // 4. Baseline from votes.csv (refreshed by `npm run fetch` right before this script in CI)
  const lines = readFileSync("votes.csv", "utf-8").trimEnd().split("\n");
  const header = lines[0].split(",");
  const idx = (name: string) => header.indexOf(name);
  type Row = string[];
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(lines[i].split(",").map((v) => v.replace(/^"(.*)"$/, "$1")));
  }
  const num = (col: string, c: Row) => parseFloat(c[idx(col)] ?? "0");

  const latestEpoch = Math.max(...rows.map((c) => num("epoch_number", c)));
  const epochRows = (n: number) => rows.filter((c) => num("epoch_number", c) === n);
  const latestRows = epochRows(latestEpoch);
  const poolRow = (rs: Row[]) =>
    rs.find((c) => c[idx("pool_address")].toLowerCase() === POOL.toLowerCase());

  const latestPoolRow = poolRow(latestRows);
  if (!latestPoolRow) {
    throw new Error(
      `Pool ${POOL} not found in votes.csv latest epoch ${latestEpoch} — run \`npm run fetch\` first`
    );
  }

  const voterAddress = latestRows[0][idx("voter_address")];
  const voterPower = num("actual_votes_total", latestRows[0]);
  const voterVotesOnPool = num("actual_votes", latestPoolRow);
  const poolFeesBribesLatest = num("fees_bribes_usd", latestPoolRow);
  const epochDate = latestRows[0][idx("epoch_date")];

  const epochEarnings = (n: number) =>
    epochRows(n).reduce((sum, c) => sum + num("actual_earnings_usd", c), 0);
  const currentEarningsLatest = epochEarnings(latestEpoch);
  const trailingWindow = Array.from(
    { length: TRAILING_EPOCHS },
    (_, i) => latestEpoch - i
  );
  const currentEarningsTrailing =
    trailingWindow.reduce((sum, n) => sum + epochEarnings(n), 0) /
    TRAILING_EPOCHS;
  const poolFeesBribesTrailing =
    trailingWindow.reduce(
      (sum, n) => sum + (poolRow(epochRows(n)) ? num("fees_bribes_usd", poolRow(epochRows(n))!) : 0),
      0
    ) / TRAILING_EPOCHS;

  // Pools we currently vote on (excluding the target pool), for the forgone-earnings model
  const otherPools: OtherPool[] = latestRows
    .filter(
      (c) =>
        num("actual_votes", c) > 0 &&
        c[idx("pool_address")].toLowerCase() !== POOL.toLowerCase()
    )
    .map((c) => ({
      name: c[idx("pool_name")],
      votes: num("actual_votes", c),
      otherVotes: num("pool_votes", c) - num("actual_votes", c),
      reward: num("fees_bribes_usd", c),
    }));

  // 5. Calibration cross-check: emissions the gauge streams this epoch (set at the last
  // flip by last epoch's votes) vs what current votes would send at the next flip.
  const gaugeWeeklyAero = gaugeRateAeroPerSec * WEEK;
  const votesWeeklyAero = gaugesWeeklyAero * (poolVotes / totalVotes);
  const calibrationRatio =
    votesWeeklyAero > 0 ? gaugeWeeklyAero / votesWeeklyAero : 0;
  if (calibrationRatio > 2 || (calibrationRatio > 0 && calibrationRatio < 0.5)) {
    console.warn(
      `  Warning: gauge rate (${fmt(gaugeWeeklyAero)} AERO/wk) and vote share (${fmt(
        votesWeeklyAero
      )} AERO/wk) diverge ${calibrationRatio.toFixed(2)}x — emissions model may be off`
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    epochNumber: latestEpoch,
    epochDate,
    voterAddress,
    minterWeeklyAero,
    weeklyToGaugesAero: gaugesWeeklyAero,
    totalVotes,
    poolVotes,
    voterPower,
    voterVotesOnPool,
    currentEarningsUsd: {
      latest: currentEarningsLatest,
      trailing: currentEarningsTrailing,
      trailingEpochs: TRAILING_EPOCHS,
    },
    otherPools,
    pool: {
      symbol: `vAMM-${t0.symbol}/${t1.symbol}`,
      address: POOL,
      gauge: pool.gauge as string,
      token0: { symbol: t0.symbol, reserve: reserve0, staked: staked0 },
      token1: { symbol: t1.symbol, reserve: reserve1, staked: staked1 },
      poolTvlUsd,
      stakedTvlUsd,
      feesBribesUsd: {
        latest: poolFeesBribesLatest,
        trailing: poolFeesBribesTrailing,
      },
      gaugeWeeklyAero,
    },
    prices: {
      aero: aeroPrice.price,
      token0: price0.price,
      token1: price1.price,
      dates: { aero: aeroPrice.date, token0: price0.date, token1: price1.date },
    },
    hurdle: {
      inferredCeiling,
      crossSection,
      historical: {
        nEpochs: historical.points.length,
        nInflow: historical.nInflow,
        minInflowVapr: historical.minInflowVapr,
        maxQuietVapr: historical.maxQuietVapr,
        stump: historical.stump,
        sufficient: historical.sufficient,
        points: historical.points,
      },
    },
  };

  console.log(JSON.stringify(snapshot, null, 2));
  console.log(
    `Calibration: gauge streams ${fmt(gaugeWeeklyAero)} AERO/wk now vs ${fmt(
      votesWeeklyAero
    )} AERO/wk implied by current votes (ratio ${calibrationRatio.toFixed(2)})`
  );

  // 6. Build strategy.html
  const pf = (v: number) => (isFinite(v) ? v.toFixed(1) + "%" : "–");
  const csRow = (
    name: string,
    s: { n: number; tvl: number; p25: number; p50: number; p75: number }
  ) =>
    `<tr><td>${name}</td><td class="right">${s.n}</td><td class="right">${usdFmt(s.tvl)}</td>` +
    `<td class="right">${pf(s.p25)}</td><td class="right">${pf(s.p50)}</td><td class="right">${pf(s.p75)}</td></tr>`;
  const defaultAllocationPct =
    voterPower > 0
      ? Math.round((voterVotesOnPool / voterPower) * 1000) / 10
      : 0;
  const maxWeeklyAero = gaugesWeeklyAero * ((poolVotes - voterVotesOnPool + voterPower) / totalVotes);
  const maxWeeklyUsd = maxWeeklyAero * aeroPrice.price;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aerodrome Own-Pool Strategy</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; padding: 1rem; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    h2 { font-size: 1.1rem; margin: 1.2rem 0 .4rem; }
    a { color: #2563eb; }
    .voter { font-size: .85rem; margin-bottom: .5rem; color: #555; }
    .intro { font-size: .85rem; line-height: 1.5; color: #444; margin-bottom: 1rem; max-width: 80ch; }
    .intro p { margin-bottom: .4rem; }
    table { border-collapse: collapse; font-size: .85rem; margin-top: .5rem; font-variant-numeric: tabular-nums; }
    th, td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid #e0e0e0; white-space: nowrap; }
    th { background: #f0f0f0; font-weight: 600; }
    .right { text-align: right; }
    .total { font-weight: 600; background: #f0f0f0; }
    .scroll { overflow-x: auto; }
    .muted { color: #777; font-size: .8rem; }
    .delta-pos { color: #15803d; font-weight: 600; }
    .delta-neg { color: #b91c1c; font-weight: 600; }
    .controls { display: flex; gap: 1.5rem; flex-wrap: wrap; margin: .8rem 0 1rem; padding: .8rem; background: #f0f0f0; border-radius: 6px; font-size: .85rem; }
    .controls label { display: flex; flex-direction: column; gap: .3rem; font-weight: 600; }
    .controls input[type="number"] { width: 8em; font: inherit; padding: .25rem .4rem; border: 1px solid #bbb; border-radius: 4px; text-align: right; font-variant-numeric: tabular-nums; }
    .controls input[type="range"] { width: 14em; }
    .controls .slider-row { display: flex; align-items: center; gap: .6rem; font-weight: 400; }
    .big { font-size: 1.05rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .footnotes { font-size: .8rem; color: #555; line-height: 1.5; max-width: 90ch; margin-top: 1.5rem; }
    .footnotes li { margin: .2rem 0 .2rem 1.4rem; }
  </style>
</head>
<body>
  <h1>Aerodrome Own-Pool Strategy <span class="muted">→ <a href="index.html">voting dashboard</a></span></h1>
  <p class="voter">Voter: <code>${escapeHtml(voterAddress)}</code> · Pool: <code>${POOL}</code> (${escapeHtml(
    snapshot.pool.symbol
  )}) · Snapshot: ${snapshot.generatedAt.slice(0, 16).replace("T", " ")} UTC · Epoch ${latestEpoch} (${epochDate})</p>
  <div class="intro">
    <p>This page models farming our own votes: instead of voting for pools with the best fees and bribes,
    point some or all of our ${fmt(voterPower)} votes at our own ${escapeHtml(snapshot.pool.symbol)} pool so it
    receives a share of the weekly AERO emissions, then capture those emissions ourselves by staking LP in the gauge.
    Votes cast now take effect at the next epoch flip (Thursday 00:00 UTC).</p>
  </div>

  <h2>Snapshot</h2>
  <div class="scroll"><table>
    <tbody>
      <tr><td>AERO price</td><td class="right">${usdFmt(aeroPrice.price, 4)}</td>
          <td>${escapeHtml(t0.symbol)} price</td><td class="right">${usdFmt(price0.price, 4)}</td></tr>
      <tr><td>Weekly emissions to gauges</td><td class="right">${fmt(gaugesWeeklyAero)} AERO (${usdFmt(
    gaugesWeeklyAero * aeroPrice.price
  )}) of ${fmt(minterWeeklyAero)} minted</td>
          <td>Total votes this epoch</td><td class="right">${fmt(totalVotes)}</td></tr>
      <tr><td>Our vote power</td><td class="right">${fmt(voterPower)} (${(
    (voterPower / totalVotes) *
    100
  ).toFixed(3)}% of total)</td>
          <td>Pool votes now</td><td class="right">${fmt(poolVotes)} (${fmt(
    voterVotesOnPool
  )} ours)</td></tr>
      <tr><td>Pool TVL</td><td class="right">${usdFmt(poolTvlUsd)}</td>
          <td>Staked (gauge) TVL</td><td class="right">${usdFmt(stakedTvlUsd)}</td></tr>
      <tr><td>Pool fees+bribes, latest epoch</td><td class="right">${usdFmt(
        poolFeesBribesLatest,
        2
      )}</td>
          <td>Gauge streaming this epoch</td><td class="right">${fmt(
            gaugeWeeklyAero
          )} AERO/wk</td></tr>
      <tr><td>Current voting earnings, epoch ${latestEpoch}</td><td class="right">${usdFmt(
    currentEarningsLatest
  )}/wk</td>
          <td>Trailing ${TRAILING_EPOCHS}-epoch average</td><td class="right">${usdFmt(
            currentEarningsTrailing
          )}/wk</td></tr>
    </tbody>
  </table></div>
  <p class="muted">Maximum emissions our votes could send to the pool (100% allocation):
  <strong>${fmt(maxWeeklyAero)} AERO/week ≈ ${usdFmt(maxWeeklyUsd)}/week</strong> at the current AERO price.</p>

  <h2>Scenario</h2>
  <div class="controls">
    <label>Vote allocation to our pool
      <span class="slider-row">
        <input type="range" id="alloc-slider" min="0" max="100" step="0.5" value="${defaultAllocationPct}">
        <input type="number" id="alloc" min="0" max="100" step="0.5" value="${defaultAllocationPct}">%
      </span>
    </label>
    <label>Capital to deposit ($)
      <input type="number" id="cap" min="0" step="1000" value="100000">
      <span class="muted" id="cap-split"></span>
    </label>
    <label>Target vAPR ceiling (%)
      <input type="number" id="target-vapr" min="0.1" step="1" value="${inferredCeiling}">
    </label>
  </div>
  <p class="muted">Target vAPR ceiling default of ${inferredCeiling}% is inferred from mercenary behavior
  (see <a href="#inferred-ceiling">Inferred vAPR ceiling</a>): market hurdle p25 = ${
    isFinite(crossSection.amm.p25) ? crossSection.amm.p25.toFixed(1) + "%" : "n/a"
  } across ${crossSection.amm.n} comparable AMM gauges${
    historical.sufficient
      ? `; external LP historically arrived in our gauge above ${historical.minInflowVapr.toFixed(1)}%`
      : ""
  }. Edit freely — it only drives the deterrence rows.</p>

  <div class="scroll"><table id="emissions-table">
    <thead><tr><th></th><th class="right">Value</th></tr></thead>
    <tbody>
      <tr><td>Votes on pool after reallocation</td><td class="right" id="out-pool-votes"></td></tr>
      <tr><td>Share of total votes</td><td class="right" id="out-share"></td></tr>
      <tr><td>Weekly emissions to pool</td><td class="right" id="out-emissions"></td></tr>
      <tr class="total"><td>Weekly emissions value</td><td class="right big" id="out-emissions-usd"></td></tr>
    </tbody>
  </table></div>

  <h2>Weekly income: current strategy vs own-pool farming</h2>
  <div class="scroll"><table id="compare-table">
    <thead><tr><th>Income source</th><th class="right">Current</th><th class="right">Own-pool scenario</th></tr></thead>
    <tbody>
      <tr><td>LP emissions captured (our stake share)</td><td class="right">–</td><td class="right" id="cmp-lp"></td></tr>
      <tr><td>Voting: our pool's fees+bribes</td><td class="right" id="cmp-own-cur"></td><td class="right" id="cmp-own"></td></tr>
      <tr><td>Voting: other pools' fees+bribes</td><td class="right" id="cmp-other-cur"></td><td class="right" id="cmp-other"></td></tr>
      <tr class="total"><td>Total per week</td><td class="right" id="cmp-total-cur"></td><td class="right" id="cmp-total"></td></tr>
      <tr><td>Net delta vs current</td><td class="right">–</td><td class="right" id="cmp-delta"></td></tr>
      <tr><td>Annualized delta</td><td class="right">–</td><td class="right" id="cmp-delta-year"></td></tr>
    </tbody>
  </table></div>
  <p class="muted">Current column is epoch ${latestEpoch} actuals (trailing ${TRAILING_EPOCHS}-epoch average: ${usdFmt(
    currentEarningsTrailing
  )}/wk). Scenario assumes incumbent stakers (${usdFmt(
    stakedTvlUsd
  )}) neither add nor remove liquidity.</p>

  <h2>Mercenary deterrence: TVL to add before the flip</h2>
  <p class="intro">Once emissions land, the gauge's displayed vAPR = annualized emissions ÷ staked TVL.
  A high vAPR attracts mercenary LPs who dilute our share. Adding TVL before the epoch flip keeps the
  displayed vAPR below the target ceiling so the pool never shows up on farming radars.</p>
  <div class="scroll"><table id="deter-table">
    <tbody>
      <tr><td>vAPR after our deposit</td><td class="right big" id="det-vapr"></td></tr>
      <tr><td>Staked TVL required for target vAPR</td><td class="right" id="det-req"></td></tr>
      <tr class="total"><td>Additional TVL to add before flip</td><td class="right big" id="det-add"></td></tr>
    </tbody>
  </table></div>

  <h2 id="inferred-ceiling">Inferred vAPR ceiling</h2>
  <p class="intro">Two independent estimates of the vAPR level at which mercenary capital shows up,
  used to default the target ceiling above.
  <strong>Cross-sectional:</strong> mercenary capital equalizes returns at the margin, so the
  staked-TVL-weighted distribution of emissions-vAPR across all live gauges reveals the market
  hurdle rate it farms at — staying below the p25 keeps our pool less attractive than what ~75%
  of already-deployed capital accepts elsewhere.
  <strong>Historical:</strong> our own gauge's record (<code>pool-history.csv</code>, one snapshot
  per epoch flip) shows the displayed vAPR levels at which external LP actually arrived —
  external means everything not staked by the voter address.</p>

  <div class="scroll"><table>
    <thead><tr><th>Cross-section (today)</th><th class="right">Gauges</th><th class="right">Staked TVL</th>
      <th class="right">p25</th><th class="right">p50</th><th class="right">p75</th></tr></thead>
    <tbody>
      ${csRow("Comparable AMM (volatile + stable)", crossSection.amm)}
      ${csRow("Concentrated liquidity", crossSection.cl)}
      ${csRow("All pool types", crossSection.all)}
    </tbody>
  </table></div>
  <p class="muted">TVL-weighted percentiles over live gauges with ≥ ${usdFmt(
    HURDLE_TVL_FLOOR
  )} staked, our pool excluded; ${crossSection.nPriced} of ${
    crossSection.nGauges
  } emitting gauges priced (${crossSection.unpricedGauges} skipped for missing token prices).
  CL gauges shown for context only — their displayed vAPR is not comparable to a vAMM's.</p>

  <div class="scroll"><table>
    <thead><tr><th>Displayed vAPR</th><th class="right">AMM gauges</th><th class="right">Share of staked TVL</th></tr></thead>
    <tbody>
      ${crossSection.buckets
        .map(
          (b) =>
            `<tr><td>${b.label}</td><td class="right">${b.count}</td><td class="right">${b.tvlSharePct.toFixed(1)}%</td></tr>`
        )
        .join("\n      ")}
    </tbody>
  </table></div>

  ${
    historical.points.length > 0
      ? `<p class="intro" style="margin-top:1rem">Historical evidence: of ${historical.points.length} past epochs,
  <strong>${historical.nInflow}</strong> saw external LP inflow. External capital arrived at displayed vAPRs down to
  <strong>${pf(historical.minInflowVapr)}</strong> (best single split: inflow iff vAPR &gt; ${pf(
          historical.stump.vapr
        )}, ${historical.stump.errors} of ${historical.points.length} epochs misclassified); the quietest weeks ran as high as ${pf(
          historical.maxQuietVapr
        )} without attracting anyone.${
          historical.sufficient
            ? ""
            : " Too few observations on one side — treated as insufficient evidence for the default above."
        }</p>
  <div class="scroll"><table>
    <thead><tr><th class="right">Epoch</th><th>Flip</th><th class="right">Staked TVL</th>
      <th class="right">Displayed vAPR</th><th class="right">Δ external LP</th><th>Result</th></tr></thead>
    <tbody>
      ${historical.points
        .map(
          (p) =>
            `<tr><td class="right">${p.epoch}</td><td>${p.date}</td><td class="right">${usdFmt(
              p.stakedTvlUsd
            )}</td><td class="right">${pf(p.vapr)}</td><td class="right">${
              (p.dExtPct >= 0 ? "+" : "") + p.dExtPct.toFixed(1)
            }%</td><td>${
              p.inflow ? '<span class="delta-neg">inflow</span>' : '<span class="muted">quiet</span>'
            }</td></tr>`
        )
        .join("\n      ")}
    </tbody>
  </table></div>
  <p class="muted">Δ external LP is the change in non-voter gauge liquidity over the epoch, in LP units
  (price-independent), relative to gauge supply at the flip. Inflow = growth beyond
  max(${INFLOW_REL * 100}% of gauge supply, ${INFLOW_ABS * 100}% of pool supply).</p>`
      : `<p class="muted">No pool history yet — run <code>npm run history</code> to build pool-history.csv.</p>`
  }

  <h2>Allocation ladder</h2>
  <div class="scroll"><table id="ladder-table">
    <thead><tr>
      <th class="right">Allocation</th><th class="right">AERO/week</th><th class="right">$/week to pool</th>
      <th class="right">LP income/week</th><th class="right">Total/week</th><th class="right">Δ vs current</th>
      <th class="right">vAPR after deposit</th><th class="right">TVL for target</th><th class="right">Extra TVL needed</th>
    </tr></thead>
    <tbody id="ladder-body"></tbody>
  </table></div>

  <div class="footnotes">
    <strong>Assumptions</strong>
    <li>Emissions to a gauge = total gauge emissions × pool votes / total votes. Only ${(
      (gaugesWeeklyAero / minterWeeklyAero) *
      100
    ).toFixed(0)}% of Minter weekly (${fmt(
    minterWeeklyAero
  )} AERO) reaches gauges — the veAERO rebase and team allocation are carved out — so the total is measured by summing every live gauge's streaming rate (${fmt(
    gaugesWeeklyAero
  )} AERO/wk).</li>
    <li>One-epoch lag: votes cast now direct emissions that start streaming at the next flip. The gauge currently streams ${fmt(
      gaugeWeeklyAero
    )} AERO/wk (set by last epoch's votes); current votes imply ${fmt(
    votesWeeklyAero
  )} AERO/wk at the next flip.</li>
    <li>Total votes are held constant: reallocating our votes moves them between pools without changing the total.</li>
    <li>Own-pool fees+bribes use the latest epoch's ${usdFmt(
      poolFeesBribesLatest,
      2
    )} (trailing ${TRAILING_EPOCHS}-epoch average ${usdFmt(
    snapshot.pool.feesBribesUsd.trailing,
    2
  )}); voting more for our own pool doesn't create new fees, it only changes our share of them.</li>
    <li>Other-pool voting income assumes the freed/remaining votes stay spread across our current pools in the same proportions.</li>
    <li>Incumbent staked TVL is assumed static; in practice mercenary TVL chases displayed vAPR — that response is exactly what the deterrence calculator is for.</li>
    <li>Prices are point-in-time (AERO ${usdFmt(aeroPrice.price, 4)}, ${escapeHtml(
    t0.symbol
  )} ${usdFmt(price0.price, 4)}); no price-impact modeling for acquiring ${escapeHtml(
    t0.symbol
  )} or for AERO sell pressure from farming.</li>
    <li>LP deposits into a vAMM pool must be balanced 50/50 by value at deposit time, so the ${escapeHtml(
      t0.symbol
    )}/${escapeHtml(
    t1.symbol
  )} split cannot be chosen: half the deposit's value must be provided as each token (the scenario shows the implied amounts at current prices).</li>
    <li>Cross-sectional hurdle: emissions-vAPR = gauge streaming rate × 52.14 weeks × AERO price ÷ staked TVL,
    over live gauges streaming emissions; tokens priced via Alchemy spot with prices.csv fallback, gauges with
    unpriceable tokens skipped. Pool "type" from LpSugar (≤ 0 = basic AMM, &gt; 0 = CL).</li>
    <li>Historical ceiling: pool-history.csv snapshots gauge state 1h after each epoch flip via archive calls;
    the AERO rate per epoch comes from the gauge's own rewardRateByEpoch record. Our TVL is defined as the
    gauge balance of the voter address only — LP staked by any other address counts as external, including
    addresses we might control that are not the voter.</li>
    <li>The inferred ceiling defaults to the stricter of (cross-sectional p25, lowest vAPR that ever drew
    external inflow), rounded and clamped to 5–50%; it is a starting point, not a hard rule.</li>
  </div>

  <script>
  const S = ${JSON.stringify(snapshot)};
  (function() {
    var fmtN = function(n, d) { return n.toLocaleString('en-US', {minimumFractionDigits: d || 0, maximumFractionDigits: d || 0}); };
    var fmtU = function(n, d) { return '$' + fmtN(n, d); };
    var EPOCHS_PER_YEAR = 365 / 7;
    var el = function(id) { return document.getElementById(id); };

    // Scenario math shared by the main outputs and the ladder rows.
    // alloc: fraction of our vote power on the pool; capital: our LP deposit ($).
    function scenario(alloc, capital) {
      var otherVotesOnPool = S.poolVotes - S.voterVotesOnPool;
      var ourVotes = alloc * S.voterPower;
      var poolVotes = otherVotesOnPool + ourVotes;
      var share = poolVotes / S.totalVotes;
      var weeklyAero = S.weeklyToGaugesAero * share;
      var weeklyUsd = weeklyAero * S.prices.aero;
      var stakedAfter = S.pool.stakedTvlUsd + capital;
      var lpIncome = stakedAfter > 0 ? weeklyUsd * capital / stakedAfter : 0;
      var ownVoteIncome = poolVotes > 0 ? S.pool.feesBribesUsd.latest * ourVotes / poolVotes : 0;
      // Remaining votes spread across our other pools proportionally to today's allocation
      var currentOther = S.voterPower - S.voterVotesOnPool;
      var scale = currentOther > 0 ? (1 - alloc) * S.voterPower / currentOther : 0;
      var otherIncome = 0;
      S.otherPools.forEach(function(p) {
        var v = p.votes * scale;
        var denom = p.otherVotes + v;
        if (denom > 0) otherIncome += p.reward * v / denom;
      });
      var vApr = stakedAfter > 0 ? weeklyUsd * EPOCHS_PER_YEAR / stakedAfter * 100 : 0;
      return {
        poolVotes: poolVotes, share: share, weeklyAero: weeklyAero, weeklyUsd: weeklyUsd,
        lpIncome: lpIncome, ownVoteIncome: ownVoteIncome, otherIncome: otherIncome,
        total: lpIncome + ownVoteIncome + otherIncome, vApr: vApr, stakedAfter: stakedAfter
      };
    }

    function deltaCell(cell, delta) {
      cell.textContent = (delta >= 0 ? '+' : '−') + fmtU(Math.abs(delta));
      cell.classList.toggle('delta-pos', delta >= 0);
      cell.classList.toggle('delta-neg', delta < 0);
    }

    function recalc() {
      var alloc = Math.min(100, Math.max(0, parseFloat(el('alloc').value) || 0)) / 100;
      var capital = parseFloat(el('cap').value) || 0;
      // A volatile vAMM deposit is balanced 50/50 by value — the split is not a choice.
      el('cap-split').textContent = '= ' + fmtU(capital / 2) + ' ' + S.pool.token1.symbol +
        ' + ' + fmtN(capital / 2 / S.prices.token0) + ' ' + S.pool.token0.symbol +
        ' (' + fmtU(capital / 2) + ')';
      var target = parseFloat(el('target-vapr').value) || 0;
      var current = S.currentEarningsUsd.latest;
      var s = scenario(alloc, capital);

      el('out-pool-votes').textContent = fmtN(s.poolVotes);
      el('out-share').textContent = (s.share * 100).toFixed(4) + '%';
      el('out-emissions').textContent = fmtN(s.weeklyAero) + ' AERO';
      el('out-emissions-usd').textContent = fmtU(s.weeklyUsd) + '/wk';

      el('cmp-lp').textContent = fmtU(s.lpIncome);
      el('cmp-own-cur').textContent = fmtU(scenario(S.voterVotesOnPool / S.voterPower, 0).ownVoteIncome, 2);
      el('cmp-own').textContent = fmtU(s.ownVoteIncome, 2);
      el('cmp-other-cur').textContent = fmtU(current - scenario(S.voterVotesOnPool / S.voterPower, 0).ownVoteIncome);
      el('cmp-other').textContent = fmtU(s.otherIncome);
      el('cmp-total-cur').textContent = fmtU(current);
      el('cmp-total').textContent = fmtU(s.total);
      deltaCell(el('cmp-delta'), s.total - current);
      deltaCell(el('cmp-delta-year'), (s.total - current) * EPOCHS_PER_YEAR);

      var tvlReq = target > 0 ? s.weeklyUsd * EPOCHS_PER_YEAR / (target / 100) : Infinity;
      var extra = Math.max(0, tvlReq - s.stakedAfter);
      el('det-vapr').textContent = s.vApr.toFixed(1) + '%';
      el('det-req').textContent = isFinite(tvlReq) ? fmtU(tvlReq) : '–';
      el('det-add').textContent = isFinite(tvlReq) ? fmtU(extra) : '–';

      var body = el('ladder-body');
      body.textContent = '';
      [5, 10, 25, 50, 75, 100].forEach(function(pct) {
        var r = scenario(pct / 100, capital);
        var req = target > 0 ? r.weeklyUsd * EPOCHS_PER_YEAR / (target / 100) : Infinity;
        var add = Math.max(0, req - r.stakedAfter);
        var tr = document.createElement('tr');
        var cells = [
          pct + '%', fmtN(r.weeklyAero), fmtU(r.weeklyUsd), fmtU(r.lpIncome), fmtU(r.total),
          null, r.vApr.toFixed(1) + '%',
          isFinite(req) ? fmtU(req) : '–', isFinite(req) ? fmtU(add) : '–'
        ];
        cells.forEach(function(text, i) {
          var td = document.createElement('td');
          td.className = 'right';
          if (i === 5) deltaCell(td, r.total - current); else td.textContent = text;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }

    var slider = el('alloc-slider'), box = el('alloc');
    slider.addEventListener('input', function() { box.value = slider.value; recalc(); });
    box.addEventListener('input', function() { slider.value = box.value; recalc(); });
    ['cap', 'target-vapr'].forEach(function(id) {
      el(id).addEventListener('input', recalc);
    });
    recalc();
  })();
  </script>
</body>
</html>`;

  writeFileSync("strategy.html", html);
  console.log(`Built strategy.html (epoch ${latestEpoch}, ${epochDate})`);
}

main();
