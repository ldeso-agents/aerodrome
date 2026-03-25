import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

// Deployed Sugar contracts on Base
// https://github.com/velodrome-finance/sugar/blob/main/deployments/base.env
const LP_SUGAR = "0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe" as const;
const REWARDS_SUGAR = "0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const PAGE = 200;
const WEEK = 7 * 24 * 3600;
const DAY = 24 * 3600;

// -- ABI fragments (only what we use) --

const lpSugarAbi = [
  {
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_filter", type: "uint256" },
    ],
    name: "all",
    outputs: [
      {
        components: [
          { name: "lp", type: "address" },
          { name: "symbol", type: "string" },
          { name: "decimals", type: "uint8" },
          { name: "liquidity", type: "uint256" },
          { name: "type", type: "int24" },
          { name: "tick", type: "int24" },
          { name: "sqrt_ratio", type: "uint160" },
          { name: "token0", type: "address" },
          { name: "reserve0", type: "uint256" },
          { name: "staked0", type: "uint256" },
          { name: "token1", type: "address" },
          { name: "reserve1", type: "uint256" },
          { name: "staked1", type: "uint256" },
          { name: "gauge", type: "address" },
          { name: "gauge_liquidity", type: "uint256" },
          { name: "gauge_alive", type: "bool" },
          { name: "fee", type: "address" },
          { name: "bribe", type: "address" },
          { name: "factory", type: "address" },
          { name: "emissions", type: "uint256" },
          { name: "emissions_token", type: "address" },
          { name: "emissions_cap", type: "uint256" },
          { name: "pool_fee", type: "uint256" },
          { name: "unstaked_fee", type: "uint256" },
          { name: "token0_fees", type: "uint256" },
          { name: "token1_fees", type: "uint256" },
          { name: "locked", type: "uint256" },
          { name: "emerging", type: "uint256" },
          { name: "created_at", type: "uint32" },
          { name: "nfpm", type: "address" },
          { name: "alm", type: "address" },
          { name: "root", type: "address" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_account", type: "address" },
      { name: "_addresses", type: "address[]" },
    ],
    name: "tokens",
    outputs: [
      {
        components: [
          { name: "token_address", type: "address" },
          { name: "symbol", type: "string" },
          { name: "decimals", type: "uint8" },
          { name: "account_balance", type: "uint256" },
          { name: "listed", type: "bool" },
          { name: "emerging", type: "bool" },
        ],
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "voter",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const votedEvent = {
  type: "event",
  name: "Voted",
  inputs: [
    { name: "voter", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "weight", type: "uint256", indexed: false },
    { name: "totalWeight", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

const abstainedEvent = {
  type: "event",
  name: "Abstained",
  inputs: [
    { name: "voter", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
    { name: "weight", type: "uint256", indexed: false },
    { name: "totalWeight", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

const epochStruct = {
  components: [
    { name: "ts", type: "uint256" },
    { name: "lp", type: "address" },
    { name: "votes", type: "uint256" },
    { name: "emissions", type: "uint256" },
    {
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      name: "bribes",
      type: "tuple[]",
    },
    {
      components: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      name: "fees",
      type: "tuple[]",
    },
  ],
  name: "",
  type: "tuple[]",
} as const;

const rewardsSugarAbi = [
  {
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
    ],
    name: "epochsLatest",
    outputs: [epochStruct],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_address", type: "address" },
    ],
    name: "epochsByAddress",
    outputs: [epochStruct],
    stateMutability: "view",
    type: "function",
  },
] as const;

// -- Types --

type PoolMeta = { symbol: string; type: number; token0: string; token1: string };
type TokenMeta = { symbol: string; decimals: number };
type RawReward = readonly { token: Address; amount: bigint }[];
type RawEpoch = {
  ts: bigint;
  lp: Address;
  votes: bigint;
  emissions: bigint;
  bribes: RawReward;
  fees: RawReward;
};
type EpochRecord = {
  epoch_ts: number;
  epoch_date: string;
  price_date: string;
  pool_name: string;
  pool_address: string;
  votes: number;
  vote_pct: number;
  fees_usd: number;
  fees_token0_usd: number;
  token0: string;
  fees_token1_usd: number;
  token1: string;
  bribes_usd: number;
  bribe_tokens: string[];
  epoch_number: number;
  address_votes: number;
};
type PriceMap = Map<string, Map<string, number>>; // token -> (YYYY-MM-DD -> usd)

// -- Helpers --

/** Fetch event logs, splitting block range on error (handles RPC block limits). */
async function fetchLogsChunked<T>(
  client: ReturnType<typeof createPublicClient>,
  params: { address: Address; event: any; args: any },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<T[]> {
  try {
    return await client.getLogs({ ...params, fromBlock, toBlock }) as T[];
  } catch {
    if (toBlock - fromBlock <= 1000n) throw new Error(`getLogs failed for range ${fromBlock}-${toBlock}`);
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [left, right] = await Promise.all([
      fetchLogsChunked<T>(client, params, fromBlock, mid),
      fetchLogsChunked<T>(client, params, mid + 1n, toBlock),
    ]);
    return [...left, ...right];
  }
}

/** POST JSON with exponential backoff on 429. Throws on other non-2xx responses. */
async function postJson(url: string, body: object): Promise<any> {
  const MAX_RETRIES = 10;
  const MAX_BACKOFF_S = 64;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status === 429 && attempt < MAX_RETRIES) {
      const backoff = Math.min(2 ** attempt, MAX_BACKOFF_S);
      console.warn(`  429 from ${url}, retrying in ${backoff}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return resp.json();
  }
}

/** Build a human-readable pool name. CL pools have empty symbol in Sugar. */
function poolName(pool: PoolMeta, tokenMap: Map<string, TokenMeta>): string {
  if (pool.symbol) return pool.symbol;
  const t0 = tokenMap.get(pool.token0)?.symbol ?? "???";
  const t1 = tokenMap.get(pool.token1)?.symbol ?? "???";
  const prefix = pool.type > 0 ? `CL${pool.type}` : pool.type === 0 ? "sAMM" : "vAMM";
  return `${prefix}-${t0}/${t1}`;
}

function rewardTokenSymbols(rewards: RawReward, tokenMap: Map<string, TokenMeta>): string[] {
  return rewards
    .filter((r) => r.amount > 0n)
    .map((r) => tokenMap.get(r.token.toLowerCase())?.symbol ?? "???");
}

function computeUsdForToken(
  rewards: RawReward,
  targetToken: string,
  tokenMap: Map<string, TokenMeta>,
  priceMap: PriceMap,
  date: string,
): number {
  let total = 0;
  for (const r of rewards) {
    if (r.amount === 0n) continue;
    const addr = r.token.toLowerCase();
    if (addr !== targetToken) continue;
    const decimals = tokenMap.get(addr)?.decimals ?? 18;
    const amount = Number(r.amount) / 10 ** decimals;
    const price = priceMap.get(addr)?.get(date) ?? 0;
    total += amount * price;
  }
  return Math.round(total * 100) / 100;
}

// -- Price helpers --

async function fetchHistoricalPrices(
  alchemyKey: string,
  tokenRanges: Map<string, { startTs: number; endTs: number }>,
  tokenMap: Map<string, TokenMeta>,
): Promise<PriceMap> {
  const prices: PriceMap = new Map();
  const ONE_YEAR_S = 364 * DAY;

  let i = 0;
  for (const [addr, range] of tokenRanges) {
    if (i++ > 0) await new Promise((r) => setTimeout(r, 200));
    const dateMap = new Map<string, number>();
    prices.set(addr, dateMap);

    for (let chunkStart = range.startTs; chunkStart < range.endTs; chunkStart += ONE_YEAR_S) {
      const chunkEnd = Math.min(chunkStart + ONE_YEAR_S, range.endTs);
      try {
        const json = await postJson(
          `https://api.g.alchemy.com/prices/v1/${alchemyKey}/tokens/historical`,
          {
            network: "base-mainnet",
            address: addr,
            startTime: new Date(chunkStart * 1000).toISOString(),
            endTime: new Date(chunkEnd * 1000).toISOString(),
            interval: "1d",
          },
        );
        for (const pt of json.data ?? []) {
          dateMap.set(pt.timestamp.slice(0, 10), parseFloat(pt.value));
        }
      } catch (e) {
        const sym = tokenMap.get(addr)?.symbol ?? addr;
        console.warn(`  Skipping prices for ${sym}: ${e}`);
        break;
      }
    }
  }
  return prices;
}

function computeUsd(
  rewards: RawReward,
  tokenMap: Map<string, TokenMeta>,
  priceMap: PriceMap,
  date: string,
): number {
  let total = 0;
  for (const r of rewards) {
    if (r.amount === 0n) continue;
    const addr = r.token.toLowerCase();
    const decimals = tokenMap.get(addr)?.decimals ?? 18;
    const amount = Number(r.amount) / 10 ** decimals;
    const price = priceMap.get(addr)?.get(date) ?? 0;
    total += amount * price;
  }
  return Math.round(total * 100) / 100;
}

function loadPricesCsv(): PriceMap {
  const prices: PriceMap = new Map();
  if (!existsSync("prices.csv")) return prices;
  const lines = readFileSync("prices.csv", "utf-8").trimEnd().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [date, token, , priceStr] = lines[i].split(",");
    const price = parseFloat(priceStr);
    if (!date || !token || isNaN(price)) continue;
    let dateMap = prices.get(token);
    if (!dateMap) {
      dateMap = new Map();
      prices.set(token, dateMap);
    }
    dateMap.set(date, price);
  }
  return prices;
}

function savePricesCsv(
  prices: PriceMap,
  tokenMap: Map<string, TokenMeta>,
): void {
  const rows: { date: string; token: string; symbol: string; price: number }[] = [];
  for (const [token, dateMap] of prices) {
    const symbol = tokenMap.get(token)?.symbol ?? "???";
    for (const [date, price] of dateMap) {
      rows.push({ date, token, symbol, price });
    }
  }
  // Most recent dates first, sub-ordered by token symbol
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
  const lines = ["date,token_address,token_symbol,price_usd"];
  for (const r of rows) {
    lines.push(`${r.date},${r.token},${r.symbol},${r.price}`);
  }
  writeFileSync("prices.csv", lines.join("\n") + "\n");
}

// -- Main --

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL environment variable is required");
  const alchemyKey = process.env.ALCHEMY_API_KEY ?? "";

  // Parse optional --address flag
  let addressFilter: Address | undefined;
  const addrIdx = process.argv.indexOf("--address");
  if (addrIdx !== -1 && process.argv[addrIdx + 1]) {
    addressFilter = process.argv[addrIdx + 1] as Address;
    console.log(`Address filter: ${addressFilter}`);
  }

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  // 1. Fetch all pools from LpSugar.all (paginated)
  console.log("Fetching pools…");
  const pools = new Map<string, PoolMeta>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.readContract({
      address: LP_SUGAR,
      abi: lpSugarAbi,
      functionName: "all",
      args: [BigInt(PAGE), BigInt(offset), 0n],
    });
    for (const p of page) {
      pools.set(p.lp.toLowerCase(), {
        symbol: p.symbol,
        type: p.type,
        token0: p.token0.toLowerCase(),
        token1: p.token1.toLowerCase(),
      });
    }
    console.log(`  offset=${offset} got=${page.length} total=${pools.size}`);
    if (page.length < PAGE) break;
  }

  // 2. Fetch all tokens for fee/bribe symbol resolution
  console.log("Fetching tokens…");
  const tokens = new Map<string, TokenMeta>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.readContract({
      address: LP_SUGAR,
      abi: lpSugarAbi,
      functionName: "tokens",
      args: [BigInt(PAGE), BigInt(offset), ZERO, []],
    });
    for (const t of page) {
      tokens.set(t.token_address.toLowerCase(), {
        symbol: t.symbol,
        decimals: t.decimals,
      });
    }
    if (page.length < PAGE) break;
  }
  console.log(`  ${tokens.size} tokens`);

  // 3. Fetch latest epochs from RewardsSugar.epochsLatest (paginated)
  console.log("Fetching latest epochs…");
  const latestEpochs: RawEpoch[] = [];
  const totalPools = pools.size;
  for (let offset = 0; offset < totalPools; offset += PAGE) {
    const page = await client.readContract({
      address: REWARDS_SUGAR,
      abi: rewardsSugarAbi,
      functionName: "epochsLatest",
      args: [BigInt(PAGE), BigInt(offset)],
    });
    latestEpochs.push(...page);
  }

  // Identify all pools that received any votes
  const votedPools = latestEpochs.filter((e) => e.votes > 0n);
  console.log(`  ${latestEpochs.length} epochs fetched, ${votedPools.length} pools with votes`);

  // 4. Fetch ALL historical epochs for every voted pool
  console.log("Fetching historical epochs for all voted pools…");
  // allEpochs: keyed by lp (lowercase) → array of raw epochs
  const allEpochs = new Map<string, RawEpoch[]>();
  for (const { lp } of votedPools) {
    const addr = lp.toLowerCase();
    if (allEpochs.has(addr)) continue;
    const poolEpochs: RawEpoch[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await client.readContract({
        address: REWARDS_SUGAR,
        abi: rewardsSugarAbi,
        functionName: "epochsByAddress",
        args: [BigInt(PAGE), BigInt(offset), lp],
      });
      poolEpochs.push(...page);
      if (page.length < PAGE) break;
    }
    allEpochs.set(addr, poolEpochs);
    const pool = pools.get(addr);
    const label = pool ? poolName(pool, tokens) : lp;
    console.log(`  ${label}: ${poolEpochs.length} epochs`);
  }

  // 4b. Fetch address voting history (if --address provided)
  // addressVotesMap: key = `${epoch_ts}_${pool}` → address votes (number, 18-dec adjusted)
  const addressVotesMap = new Map<string, number>();
  if (addressFilter) {
    console.log(`Fetching voting history for ${addressFilter}…`);
    const voterAddress = await client.readContract({
      address: LP_SUGAR,
      abi: lpSugarAbi,
      functionName: "voter",
    });
    console.log(`  Voter contract: ${voterAddress}`);

    const latestBlock = await client.getBlockNumber();
    type LogEntry = { args: { pool: Address; tokenId: bigint; weight: bigint; timestamp: bigint }; blockNumber: bigint; logIndex: number };

    const [votedLogs, abstainedLogs] = await Promise.all([
      fetchLogsChunked<LogEntry>(
        client,
        { address: voterAddress, event: votedEvent, args: { voter: addressFilter } },
        0n, latestBlock,
      ),
      fetchLogsChunked<LogEntry>(
        client,
        { address: voterAddress, event: abstainedEvent, args: { voter: addressFilter } },
        0n, latestBlock,
      ),
    ]);

    // Merge and sort by block/logIndex
    const allVoteEvents = [
      ...votedLogs.map((l) => ({ ...l.args, type: "voted" as const, blockNumber: l.blockNumber, logIndex: l.logIndex })),
      ...abstainedLogs.map((l) => ({ ...l.args, type: "abstained" as const, blockNumber: l.blockNumber, logIndex: l.logIndex })),
    ].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

    // Build final state: epoch → pool → tokenId → weight
    const voteState = new Map<number, Map<string, Map<bigint, bigint>>>();
    for (const ev of allVoteEvents) {
      const epochTs = Math.floor(Number(ev.timestamp) / WEEK) * WEEK;
      let epochMap = voteState.get(epochTs);
      if (!epochMap) { epochMap = new Map(); voteState.set(epochTs, epochMap); }
      const poolKey = ev.pool.toLowerCase();
      let poolMap = epochMap.get(poolKey);
      if (!poolMap) { poolMap = new Map(); epochMap.set(poolKey, poolMap); }
      poolMap.set(ev.tokenId, ev.type === "voted" ? ev.weight : 0n);
    }

    for (const [epochTs, epochMap] of voteState) {
      for (const [pool, tokenMap] of epochMap) {
        let total = 0n;
        for (const w of tokenMap.values()) total += w;
        if (total > 0n) addressVotesMap.set(`${epochTs}_${pool}`, Number(total) / 1e18);
      }
    }

    console.log(`  Found ${allVoteEvents.length} vote events across ${voteState.size} epochs, ${addressVotesMap.size} non-zero (pool, epoch) pairs`);

    // Fetch epoch data for pools the address voted for but not yet in allEpochs
    const extraPools = new Set<string>();
    for (const key of addressVotesMap.keys()) {
      const pool = key.split("_")[1];
      if (!allEpochs.has(pool) && pools.has(pool)) extraPools.add(pool);
    }
    if (extraPools.size > 0) {
      console.log(`  Fetching epoch data for ${extraPools.size} extra address-voted pools…`);
      for (const addr of extraPools) {
        const poolEpochs: RawEpoch[] = [];
        for (let offset = 0; ; offset += PAGE) {
          const page = await client.readContract({
            address: REWARDS_SUGAR,
            abi: rewardsSugarAbi,
            functionName: "epochsByAddress",
            args: [BigInt(PAGE), BigInt(offset), addr as Address],
          });
          poolEpochs.push(...page);
          if (page.length < PAGE) break;
        }
        allEpochs.set(addr, poolEpochs);
        const pool = pools.get(addr);
        const label = pool ? poolName(pool, tokens) : addr;
        console.log(`    ${label}: ${poolEpochs.length} epochs`);
      }
    }
  }

  // 5. Group by epoch timestamp and keep top 30 pools per epoch by votes
  //    (plus any pools the tracked address voted for)
  const byEpoch = new Map<number, { lp: string; ep: RawEpoch }[]>();
  for (const [lp, epochs] of allEpochs) {
    for (const ep of epochs) {
      const ts = Number(ep.ts);
      let bucket = byEpoch.get(ts);
      if (!bucket) {
        bucket = [];
        byEpoch.set(ts, bucket);
      }
      bucket.push({ lp, ep });
    }
  }
  const selectedEntries: { ts: number; lp: string; ep: RawEpoch }[] = [];
  for (const [ts, bucket] of byEpoch) {
    bucket.sort((a, b) =>
      b.ep.votes > a.ep.votes ? 1 : b.ep.votes < a.ep.votes ? -1 : 0,
    );
    const top30 = new Set(bucket.slice(0, 30).map((e) => e.lp));
    for (const entry of bucket.slice(0, 30)) {
      selectedEntries.push({ ts, lp: entry.lp, ep: entry.ep });
    }
    // Include address-voted pools not in top 30
    if (addressFilter) {
      for (const entry of bucket) {
        if (!top30.has(entry.lp) && addressVotesMap.has(`${ts}_${entry.lp}`)) {
          selectedEntries.push({ ts, lp: entry.lp, ep: entry.ep });
        }
      }
    }
  }
  console.log(
    `Selected ${new Set(selectedEntries.map((e) => e.lp)).size} unique pools across ${byEpoch.size} epochs (${selectedEntries.length} records)`,
  );

  // 6. Resolve missing token symbols via Alchemy
  if (alchemyKey) {
    const missingAddrs = new Set<string>();
    for (const { lp } of selectedEntries) {
      const pool = pools.get(lp);
      if (!pool) continue;
      if (!tokens.has(pool.token0)) missingAddrs.add(pool.token0);
      if (!tokens.has(pool.token1)) missingAddrs.add(pool.token1);
    }

    if (missingAddrs.size > 0) {
      console.log(`Fetching metadata for ${missingAddrs.size} unknown tokens…`);
      const beforeCount = tokens.size;
      for (const addr of missingAddrs) {
        const json = await postJson(
          `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
          { jsonrpc: "2.0", method: "alchemy_getTokenMetadata", params: [addr], id: 1 },
        );
        if (json.result?.symbol) {
          tokens.set(addr, {
            symbol: json.result.symbol,
            decimals: json.result.decimals ?? 18,
          });
        }
      }
      console.log(`  Resolved ${tokens.size - beforeCount} of ${missingAddrs.size} tokens (${tokens.size} total)`);
    }
  }

  // 7. Build entry records from selected per-epoch top 30
  const entries: { record: EpochRecord; fees: RawReward; bribes: RawReward; pool_token0: string; pool_token1: string }[] = [];
  for (const { lp, ep } of selectedEntries) {
    const pool = pools.get(lp);
    if (!pool) continue;
    const epochStartTs = Number(ep.ts);
    entries.push({
      record: {
        epoch_ts: epochStartTs,
        epoch_date: new Date(epochStartTs * 1000).toISOString().slice(0, 10),
        price_date: epochStartTs + WEEK > Math.floor(Date.now() / 1000)
          ? new Date().toISOString().slice(0, 10)
          : new Date((epochStartTs + WEEK) * 1000).toISOString().slice(0, 10),
        pool_name: poolName(pool, tokens),
        pool_address: ep.lp,
        votes: Number(ep.votes) / 1e18,
        vote_pct: 0,
        fees_usd: 0,
        fees_token0_usd: 0,
        token0: tokens.get(pool.token0)?.symbol ?? "???",
        fees_token1_usd: 0,
        token1: tokens.get(pool.token1)?.symbol ?? "???",
        bribes_usd: 0,
        bribe_tokens: rewardTokenSymbols(ep.bribes, tokens),
        epoch_number: 0,
        address_votes: addressVotesMap.get(`${epochStartTs}_${lp}`) ?? 0,
      },
      fees: ep.fees,
      bribes: ep.bribes,
      pool_token0: pool.token0,
      pool_token1: pool.token1,
    });
  }

  // 8. Fetch token prices and compute USD values
  const cachedPrices = loadPricesCsv();
  const cachedPriceCount = [...cachedPrices.values()].reduce((n, m) => n + m.size, 0);
  console.log(`Loaded ${cachedPriceCount} cached prices from prices.csv`);

  if (alchemyKey) {
    const nowTs = Math.floor(Date.now() / 1000);

    // Collect all needed (token, date) pairs and track which are for completed epochs
    const needed = new Map<string, { dates: Set<string>; completedDates: Set<string> }>();
    for (const { record, fees, bribes } of entries) {
      const isCompleted = record.epoch_ts + WEEK <= nowTs;
      for (const r of [...fees, ...bribes]) {
        if (r.amount === 0n) continue;
        const addr = r.token.toLowerCase();
        let entry = needed.get(addr);
        if (!entry) {
          entry = { dates: new Set(), completedDates: new Set() };
          needed.set(addr, entry);
        }
        entry.dates.add(record.price_date);
        if (isCompleted) entry.completedDates.add(record.price_date);
      }
    }

    // Build fetch ranges, skipping completed dates already in cache
    const tokenRanges = new Map<string, { startTs: number; endTs: number }>();
    for (const [token, { dates, completedDates }] of needed) {
      const cached = cachedPrices.get(token);
      for (const date of dates) {
        if (completedDates.has(date) && cached?.has(date)) continue;
        const ts = Math.floor(new Date(date).getTime() / 1000);
        const existing = tokenRanges.get(token);
        if (existing) {
          existing.startTs = Math.min(existing.startTs, ts - DAY);
          existing.endTs = Math.max(existing.endTs, ts + DAY);
        } else {
          tokenRanges.set(token, { startTs: ts - DAY, endTs: ts + DAY });
        }
      }
    }

    console.log(`Fetching prices for ${tokenRanges.size} tokens…`);

    // Fetch all missing prices in one pass
    const fetched = tokenRanges.size > 0
      ? await fetchHistoricalPrices(alchemyKey, tokenRanges, tokens)
      : new Map();

    // Build combined price map (cache + fetched) and update cache for completed epochs
    const priceMap: PriceMap = new Map();
    for (const [token, { dates, completedDates }] of needed) {
      const cached = cachedPrices.get(token);
      const fresh = fetched.get(token);
      const merged = new Map<string, number>();
      priceMap.set(token, merged);
      for (const date of dates) {
        const price = fresh?.get(date) ?? cached?.get(date);
        if (price === undefined) continue;
        merged.set(date, price);
        if (completedDates.has(date) && !cached?.has(date)) {
          if (!cachedPrices.has(token)) cachedPrices.set(token, new Map());
          cachedPrices.get(token)!.set(date, price);
        }
      }
    }

    for (const { record, fees, bribes, pool_token0, pool_token1 } of entries) {
      record.fees_usd = computeUsd(fees, tokens, priceMap, record.price_date);
      record.fees_token0_usd = computeUsdForToken(fees, pool_token0, tokens, priceMap, record.price_date);
      record.fees_token1_usd = computeUsdForToken(fees, pool_token1, tokens, priceMap, record.price_date);
      record.bribes_usd = computeUsd(bribes, tokens, priceMap, record.price_date);
    }

    // Save only completed-epoch prices
    const toSave: PriceMap = new Map();
    for (const [token, { completedDates }] of needed) {
      const cached = cachedPrices.get(token);
      if (!cached) continue;
      const filtered = new Map<string, number>();
      for (const date of completedDates) {
        const price = cached.get(date);
        if (price !== undefined) filtered.set(date, price);
      }
      if (filtered.size > 0) toSave.set(token, filtered);
    }
    savePricesCsv(toSave, tokens);
    const savedPriceCount = [...toSave.values()].reduce((n, m) => n + m.size, 0);
    console.log(
      `Saved ${savedPriceCount} prices to prices.csv (${savedPriceCount - cachedPriceCount} new)`,
    );
  } else {
    console.log("ALCHEMY_API_KEY not set, skipping USD price computation");
  }

  // 9. Compute vote percentages per epoch (using all fetched epoch data)
  const epochTotals = new Map<number, number>();
  for (const [, epochs] of allEpochs) {
    for (const ep of epochs) {
      const ts = Number(ep.ts);
      epochTotals.set(ts, (epochTotals.get(ts) ?? 0) + Number(ep.votes) / 1e18);
    }
  }
  console.log(`Computing vote percentages for ${epochTotals.size} epochs…`);
  for (const { record } of entries) {
    const total = epochTotals.get(record.epoch_ts) ?? 0;
    record.vote_pct = total > 0 ? Math.round((record.votes / total) * 100 * 10000) / 10000 : 0;
  }

  // 10. Compute epoch numbers
  const records = entries.map((e) => e.record);
  const epochTimestamps = [...new Set(records.map((r) => r.epoch_ts))].sort(
    (a, b) => a - b,
  );
  if (epochTimestamps.length > 0) {
    const baseTs = epochTimestamps[0];
    for (const r of records) {
      r.epoch_number = Math.round((r.epoch_ts - baseTs) / WEEK);
    }
  }

  records.sort((a, b) => b.epoch_ts - a.epoch_ts || b.votes - a.votes);

  // 11. Write index.html (static, no JavaScript)
  {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const usdFmt = (n: number) =>
      "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tagSpans = (arr: string[]) =>
      arr.map((s) => `<span>${escapeHtml(s)}</span>`).join("");

    // Group records by epoch
    const byEpochArr = new Map<number, typeof records>();
    for (const r of records) {
      let arr = byEpochArr.get(r.epoch_ts);
      if (!arr) { arr = []; byEpochArr.set(r.epoch_ts, arr); }
      arr.push(r);
    }
    const sortedEpochs = [...byEpochArr.entries()].sort((a, b) => b[0] - a[0]);

    const sections: string[] = [];
    for (let i = 0; i < sortedEpochs.length; i++) {
      const [, epochRecords] = sortedEpochs[i];
      epochRecords.sort((a, b) => b.votes - a.votes);
      const first = epochRecords[0];
      const rows = epochRecords
        .map(
          (r, j) =>
            `          <tr>
            <td>${j + 1}</td>
            <td>${escapeHtml(r.pool_name)}</td>
            <td class="right">${fmt(r.votes)}</td>
            <td class="right">${r.vote_pct.toFixed(2)}%</td>
            <td class="right">${usdFmt(r.fees_usd)}</td>
            <td class="right">${usdFmt(r.fees_token0_usd)}</td>
            <td>${escapeHtml(r.token0)}</td>
            <td class="right">${usdFmt(r.fees_token1_usd)}</td>
            <td>${escapeHtml(r.token1)}</td>
            <td class="right">${usdFmt(r.bribes_usd)}</td>
            <td><div class="tags">${tagSpans(r.bribe_tokens)}</div></td>${addressFilter ? `
            <td class="right">${fmt(r.address_votes)}</td>` : ""}
          </tr>`,
        )
        .join("\n");

      sections.push(`  <details${i === 0 ? " open" : ""}>
    <summary>Epoch ${first.epoch_number} \u2013 ${first.epoch_date}${i === 0 ? " (current epoch)" : ""}</summary>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Pool</th>
            <th class="right">Votes</th>
            <th class="right">Vote %</th>
            <th class="right">Fees (USD)</th>
            <th class="right">Fees Token0 (USD)</th>
            <th>Token0</th>
            <th class="right">Fees Token1 (USD)</th>
            <th>Token1</th>
            <th class="right">Bribes (USD)</th>
            <th>Bribe Tokens</th>${addressFilter ? `
            <th class="right">Addr Votes</th>` : ""}
          </tr>
        </thead>
        <tbody>
  ${rows}
        </tbody>
      </table>
    </div>
  </details>`);
    }

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
  <h1>Aerodrome Votes (as of ${new Date().toISOString().replace("T", " ").replace(/:\d{2}\.\d+Z$/, " UTC")}) → <a href="votes.csv">votes.csv</a></h1>
${sections.join("\n")}
</body>
</html>`;
    writeFileSync("index.html", html);
  }

  // 12. Write votes.csv
  const baseFields = [
    "epoch_number",
    "epoch_date",
    "pool_name",
    "votes",
    "vote_pct",
    "fees_usd",
    "fees_token0_usd",
    "token0",
    "fees_token1_usd",
    "token1",
    "bribes_usd",
    "bribe_tokens",
    "pool_address",
  ] as const;
  const fields: readonly (keyof EpochRecord)[] = addressFilter
    ? [...baseFields, "address_votes"]
    : baseFields;

  const csvLines = [fields.join(",")];
  for (const r of records) {
    csvLines.push(
      fields
        .map((f) => {
          const v = r[f];
          if (Array.isArray(v)) return v.join(";");
          if (typeof v === "string" && v.includes(",")) return `"${v}"`;
          return String(v);
        })
        .join(","),
    );
  }
  writeFileSync("votes.csv", csvLines.join("\n") + "\n");

  console.log(
    `Saved ${records.length} records across ${epochTimestamps.length} epochs`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
