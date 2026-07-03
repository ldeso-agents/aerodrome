import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Reconstructs our pool's staked TVL and displayed vAPR at every past epoch
// flip and caches the series in pool-history.csv (committed by CI). Runs are
// incremental: flips already in the CSV are never recomputed, so the daily
// run costs no RPC except on Thursdays when a new flip appears.

// Deployed contracts on Base
const POOL = "0x5C0D76fab1822bDeb47308eD6028231761ED723E" as const; // vAMM-kVCM/USDC
const GAUGE = "0x57387e4639048B67C30C911a145368bC5B33fE3b" as const;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as const;
const KVCM = "0x00fbac94fec8d4089d3fe979f39454f48c71a65d" as const; // token0, 18 decimals
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const; // token1, 6 decimals
// Our TVL is the combined gauge liquidity of these addresses; anything else
// counts as external. Changing this list requires a re-backfill (delete
// pool-history.csv) so the whole series uses one definition.
const OUR_ADDRESSES = [
  "0xa79cd47655156b299762dfe92a67980805ce5a31", // veAERO voter
  "0xf63af2c60547b7e4515a0bb2bcd5e6c09f29ecf5", // treasury LP, staked since epoch 149
] as const;

// First epoch flip at which the gauge existed: the pool was deployed at block
// 37190243 and its gauge at 37190335, both on 2025-10-22 (mid-epoch), so the
// first flip that could stream emissions is 2025-10-23 00:00 UTC.
const FIRST_FLIP_TS = 1761177600;

const WEEK = 7 * 24 * 3600;
const YEAR_S = 365 * 24 * 3600;
// Sample state 1h after the flip so Voter.distribute() has run and staked TVL
// reflects what a farmer's dashboard showed at the start of the epoch.
const FLIP_OFFSET_S = 3600;
const CSV_FILE = "pool-history.csv";

const HEADER = [
  "epoch_number",
  "epoch_date",
  "epoch_ts",
  "block",
  "status", // ok | no_gauge | no_emissions
  "gauge_supply_lp",
  "our_gauge_lp",
  "pool_supply_lp",
  "reserve0_kvcm",
  "reserve1_usdc",
  "reward_rate_aero_s",
  "aero_usd",
  "token0_usd",
  "token1_usd",
  "price_source",
  "staked_tvl_usd",
  "our_staked_tvl_usd",
  "external_lp",
  "displayed_vapr_pct",
] as const;

const gaugeAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function rewardRateByEpoch(uint256) view returns (uint256)",
]);

const poolAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)",
]);

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

/** Minimal decimal representation with ~12 significant digits. */
const numStr = (n: number) => (n === 0 ? "0" : parseFloat(n.toPrecision(12)).toString());

/** prices.csv as token -> (date -> usd), skipping the -1 "unpriceable" sentinels. */
function loadPricesCsv(): Map<string, Map<string, number>> {
  const prices = new Map<string, Map<string, number>>();
  if (!existsSync("prices.csv")) return prices;
  const lines = readFileSync("prices.csv", "utf-8").trimEnd().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [date, token, , priceStr] = lines[i].split(",");
    const price = parseFloat(priceStr);
    if (!date || !token || isNaN(price) || price < 0) continue;
    let dateMap = prices.get(token);
    if (!dateMap) prices.set(token, (dateMap = new Map()));
    dateMap.set(date, price);
  }
  return prices;
}

/** Price of a token on a date: exact match, else nearest within ±7 days. */
function priceAt(
  prices: Map<string, Map<string, number>>,
  token: string,
  date: string
): number | undefined {
  const dateMap = prices.get(token);
  if (!dateMap) return undefined;
  const exact = dateMap.get(date);
  if (exact !== undefined) return exact;
  const targetMs = Date.parse(date + "T00:00:00Z");
  let best: { dist: number; price: number } | undefined;
  for (const [d, p] of dateMap) {
    const dist = Math.abs(Date.parse(d + "T00:00:00Z") - targetMs);
    if (dist <= 7 * 24 * 3600 * 1000 && (!best || dist < best.dist))
      best = { dist, price: p };
  }
  return best?.price;
}

/** Last-resort daily price from Alchemy's historical endpoint (same pattern as strategy.ts). */
async function alchemyPriceAt(
  addr: string,
  date: string,
  alchemyKey: string
): Promise<number | undefined> {
  if (!alchemyKey) return undefined;
  try {
    const ts = Date.parse(date + "T00:00:00Z") / 1000;
    const json = await postJson(
      `https://api.g.alchemy.com/prices/v1/${alchemyKey}/tokens/historical`,
      {
        network: "base-mainnet",
        address: addr,
        startTime: new Date((ts - 3 * 24 * 3600) * 1000).toISOString(),
        endTime: new Date((ts + 24 * 3600) * 1000).toISOString(),
        interval: "1d",
      }
    );
    const points = json.data ?? [];
    if (points.length > 0) return parseFloat(points[points.length - 1].value);
  } catch (e) {
    console.warn(`  Alchemy price failed for ${addr} @ ${date}: ${e}`);
  }
  return undefined;
}

/** Anchor for epoch numbering, taken from votes.csv so both files agree. */
function epochAnchor(): { num: number; ts: number } {
  const lines = readFileSync("votes.csv", "utf-8").trimEnd().split("\n");
  const header = lines[0].split(",");
  const iNum = header.indexOf("epoch_number");
  const iDate = header.indexOf("epoch_date");
  const cols = lines[1].split(",").map((v) => v.replace(/^"(.*)"$/, "$1"));
  const num = parseInt(cols[iNum]);
  const ts = Date.parse(cols[iDate] + "T00:00:00Z") / 1000;
  if (isNaN(num) || isNaN(ts))
    throw new Error("cannot read epoch numbering anchor from votes.csv");
  return { num, ts };
}

/** Existing pool-history.csv rows keyed by epoch_ts, kept verbatim. */
function loadHistoryCsv(): Map<number, string> {
  const rows = new Map<number, string>();
  if (!existsSync(CSV_FILE)) return rows;
  const lines = readFileSync(CSV_FILE, "utf-8").trimEnd().split("\n");
  const iTs = lines[0].split(",").indexOf("epoch_ts");
  for (let i = 1; i < lines.length; i++) {
    const ts = parseInt(lines[i].split(",")[iTs]);
    if (!isNaN(ts)) rows.set(ts, lines[i]);
  }
  return rows;
}

/** First block with timestamp >= targetTs. Base blocks tick every 2s, so a
 * linear estimate lands within a few blocks; expand around it, then bisect. */
async function blockAtTimestamp(client: any, targetTs: number): Promise<bigint> {
  const cache = new Map<bigint, number>();
  const tsAt = async (n: bigint): Promise<number> => {
    let ts = cache.get(n);
    if (ts === undefined) {
      const b = await withRetry(
        () => client.getBlock({ blockNumber: n }),
        `getBlock ${n}`
      );
      cache.set(n, (ts = Number(b.timestamp)));
    }
    return ts;
  };
  const latest = await withRetry(() => client.getBlock(), "getBlock latest");
  const latestN = latest.number as bigint;
  const latestTs = Number(latest.timestamp);
  if (latestTs < targetTs)
    throw new Error(`timestamp ${targetTs} is after the latest block`);
  const clamp = (n: bigint) => (n < 1n ? 1n : n > latestN ? latestN : n);
  const est = clamp(latestN - BigInt(Math.round((latestTs - targetTs) / 2)));
  let lo = est,
    hi = est,
    step = 32n;
  while (lo > 1n && (await tsAt(lo)) >= targetTs) {
    lo = clamp(lo - step);
    step *= 4n;
  }
  step = 32n;
  while (hi < latestN && (await tsAt(hi)) < targetTs) {
    hi = clamp(hi + step);
    step *= 4n;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if ((await tsAt(mid)) >= targetTs) hi = mid;
    else lo = mid;
  }
  return hi;
}

// -- Main --

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL environment variable is required");
  const alchemyKey = process.env.ALCHEMY_API_KEY ?? "";

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const existing = loadHistoryCsv();
  const now = Math.floor(Date.now() / 1000);
  const lastFlip = now - (now % WEEK); // current epoch's flip is already fixed at +1h
  const expected: number[] = [];
  for (let ts = FIRST_FLIP_TS; ts <= lastFlip; ts += WEEK) expected.push(ts);
  const missing = expected.filter((ts) => !existing.has(ts));
  if (missing.length === 0) {
    console.log(`pool-history.csv is up to date (${existing.size} flips)`);
    return;
  }
  console.log(
    `Reconstructing ${missing.length} of ${expected.length} epoch flips…`
  );

  const anchor = epochAnchor();
  const prices = loadPricesCsv();

  // Historical AERO/sec rates are stored per epoch on the gauge, readable at
  // the latest block — no archive call needed for the rate.
  const rateResults = await withRetry(
    () =>
      client.multicall({
        contracts: missing.map((ts) => ({
          address: GAUGE,
          abi: gaugeAbi,
          functionName: "rewardRateByEpoch",
          args: [BigInt(ts)],
        })),
        allowFailure: true,
      }),
    "rewardRateByEpoch"
  );

  const newRows = new Map<number, string>();
  for (let i = 0; i < missing.length; i++) {
    const ts = missing[i];
    const epochDate = new Date(ts * 1000).toISOString().slice(0, 10);
    const epochNumber = anchor.num + Math.round((ts - anchor.ts) / WEEK);
    const block = await blockAtTimestamp(client, ts + FLIP_OFFSET_S);

    const row = (status: string, values: Partial<Record<(typeof HEADER)[number], string>>) =>
      HEADER.map((h) =>
        h === "epoch_number"
          ? String(epochNumber)
          : h === "epoch_date"
          ? epochDate
          : h === "epoch_ts"
          ? String(ts)
          : h === "block"
          ? String(block)
          : h === "status"
          ? status
          : values[h] ?? "0"
      ).join(",");

    let state: any;
    try {
      state = await withRetry(
        () =>
          client.multicall({
            contracts: [
              { address: GAUGE, abi: gaugeAbi, functionName: "totalSupply" },
              ...OUR_ADDRESSES.map((addr) => ({
                address: GAUGE,
                abi: gaugeAbi,
                functionName: "balanceOf" as const,
                args: [addr],
              })),
              { address: POOL, abi: poolAbi, functionName: "totalSupply" },
              { address: POOL, abi: poolAbi, functionName: "getReserves" },
            ],
            allowFailure: false,
            blockNumber: block,
          }),
        `state @ ${epochDate}`
      );
    } catch (err) {
      const code = await withRetry(
        () => client.getCode({ address: GAUGE, blockNumber: block }),
        `getCode @ ${epochDate}`
      );
      if (!code || code === "0x") {
        console.log(`  ${epochDate} (epoch ${epochNumber}): gauge not deployed yet`);
        newRows.set(ts, row("no_gauge", { price_source: "" }));
        continue;
      }
      throw err;
    }

    const gaugeSupply = Number(state[0]) / 1e18;
    const ourGaugeLp = OUR_ADDRESSES.reduce(
      (sum, _, j) => sum + Number(state[1 + j]) / 1e18,
      0
    );
    const poolSupplyRaw = state[1 + OUR_ADDRESSES.length];
    const reserves = state[2 + OUR_ADDRESSES.length];
    const poolSupply = Number(poolSupplyRaw) / 1e18;
    const reserve0 = Number(reserves[0]) / 1e18; // kVCM
    const reserve1 = Number(reserves[1]) / 1e6; // USDC

    const rateRes = rateResults[i];
    const rate =
      rateRes.status === "success" ? Number(rateRes.result as bigint) / 1e18 : 0;

    const aeroUsd =
      priceAt(prices, AERO, epochDate) ??
      (await alchemyPriceAt(AERO, epochDate, alchemyKey));
    if (aeroUsd === undefined)
      throw new Error(`no AERO price for ${epochDate} — run \`npm run fetch\` first`);
    let priceSource = "pool_implied";
    let usdcUsd = priceAt(prices, USDC, epochDate);
    if (usdcUsd === undefined) {
      usdcUsd = 1.0;
      priceSource += ",usdc=1";
    }
    // kVCM priced from the pool's own reserves: the AMM spot price at this
    // exact block, available for every flip (prices.csv only starts 2025-11-06).
    const kvcmUsd = reserve0 > 0 ? (reserve1 * usdcUsd) / reserve0 : 0;
    const csvKvcm = priceAt(prices, KVCM, epochDate);
    if (csvKvcm !== undefined && kvcmUsd > 0) {
      const devPct = ((kvcmUsd - csvKvcm) / csvKvcm) * 100;
      if (Math.abs(devPct) > 10)
        console.warn(
          `  ${epochDate}: pool-implied kVCM ${kvcmUsd.toFixed(4)} deviates ${devPct.toFixed(1)}% from prices.csv ${csvKvcm.toFixed(4)}`
        );
    }

    const stakedShare = poolSupply > 0 ? gaugeSupply / poolSupply : 0;
    const stakedTvlUsd = (reserve0 * kvcmUsd + reserve1 * usdcUsd) * stakedShare;
    const ourShare = poolSupply > 0 ? ourGaugeLp / poolSupply : 0;
    const ourStakedTvlUsd = (reserve0 * kvcmUsd + reserve1 * usdcUsd) * ourShare;
    const externalLp = gaugeSupply - ourGaugeLp;
    const vapr =
      rate > 0 && stakedTvlUsd > 0
        ? ((rate * YEAR_S * aeroUsd) / stakedTvlUsd) * 100
        : 0;
    const status = rate > 0 ? "ok" : "no_emissions";

    console.log(
      `  ${epochDate} (epoch ${epochNumber}): staked ${stakedTvlUsd.toFixed(0)} USD` +
        ` (ours ${ourStakedTvlUsd.toFixed(0)}), vAPR ${vapr.toFixed(1)}%${
          status !== "ok" ? ` [${status}]` : ""
        }`
    );
    newRows.set(
      ts,
      row(status, {
        gauge_supply_lp: numStr(gaugeSupply),
        our_gauge_lp: numStr(ourGaugeLp),
        pool_supply_lp: numStr(poolSupply),
        reserve0_kvcm: numStr(reserve0),
        reserve1_usdc: numStr(reserve1),
        reward_rate_aero_s: numStr(rate),
        aero_usd: numStr(aeroUsd),
        token0_usd: numStr(kvcmUsd),
        token1_usd: numStr(usdcUsd),
        price_source: priceSource,
        staked_tvl_usd: stakedTvlUsd.toFixed(2),
        our_staked_tvl_usd: ourStakedTvlUsd.toFixed(2),
        external_lp: numStr(externalLp),
        displayed_vapr_pct: vapr.toFixed(2),
      })
    );
  }

  const all = [...existing, ...newRows];
  all.sort((a, b) => a[0] - b[0]);
  writeFileSync(
    CSV_FILE,
    [HEADER.join(","), ...all.map(([, line]) => line)].join("\n") + "\n"
  );
  console.log(
    `Saved ${all.length} flips to ${CSV_FILE} (${newRows.size} new)`
  );
}

main();
