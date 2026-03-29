import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

// Deployed Sugar contracts on Base
// https://github.com/velodrome-finance/sugar/blob/main/deployments/base.env
const LP_SUGAR = "0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe" as const;
const REWARDS_SUGAR = "0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678" as const;
const VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" as const;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DEFAULT_VOTER_ADDRESS =
  "0xa79cd47655156b299762DFE92A67980805ce5a31" as const;

const PAGE = 200;
const WEEK = 7 * 24 * 3600;
const DAY = 24 * 3600;

// -- ABI fragments (only what we use) --

const lpSugarAbi = parseAbi([
  "function all(uint256 _limit, uint256 _offset, uint256 _filter) view returns ((address lp, string symbol, uint8 decimals, uint256 liquidity, int24 type, int24 tick, uint160 sqrt_ratio, address token0, uint256 reserve0, uint256 staked0, address token1, uint256 reserve1, uint256 staked1, address gauge, uint256 gauge_liquidity, bool gauge_alive, address fee, address bribe, address factory, uint256 emissions, address emissions_token, uint256 emissions_cap, uint256 pool_fee, uint256 unstaked_fee, uint256 token0_fees, uint256 token1_fees, uint256 locked, uint256 emerging, uint32 created_at, address nfpm, address alm, address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address, string symbol, uint8 decimals, uint256 account_balance, bool listed, bool emerging)[])",
]);

const rewardsSugarAbi = parseAbi([
  "function epochsLatest(uint256 _limit, uint256 _offset) view returns ((uint256 ts, address lp, uint256 votes, uint256 emissions, (address token, uint256 amount)[] bribes, (address token, uint256 amount)[] fees)[])",
  "function epochsByAddress(uint256 _limit, uint256 _offset, address _address) view returns ((uint256 ts, address lp, uint256 votes, uint256 emissions, (address token, uint256 amount)[] bribes, (address token, uint256 amount)[] fees)[])",
]);

const voterAbi = parseAbi(["function ve() view returns (address)"]);

const veAbi = parseAbi([
  "function ownerOf(uint256 _tokenId) view returns (address)",
]);

const votedEvent = parseAbiItem(
  "event Voted(address indexed voter, address indexed pool, uint256 indexed tokenId, uint256 weight, uint256 totalWeight, uint256 timestamp)"
);

// -- Types --

type PoolMeta = {
  symbol: string;
  type: number;
  token0: string;
  token1: string;
};
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
type PoolType = "stablecoin" | "bluechip" | "aero" | "new" | "other";
type EpochRecord = {
  epoch_ts: number;
  epoch_number: number;
  epoch_date: string;
  price_date: string;
  pool_name: string;
  pool_type: PoolType;
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
type PriceMap = Map<string, Map<string, number>>; // token -> (YYYY-MM-DD -> usd)

// -- Helpers --

function getOrSet<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (!v) {
    v = init();
    map.set(key, v);
  }
  return v;
}

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
    if (resp.status === 429)
      throw Object.assign(new Error("429"), { status: 429 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return resp.json();
  }, url);
}

/** Paginated readContract fetch. Accumulates all pages into a single array.
 *  When totalItems is provided, fetches ceil(totalItems/PAGE) pages instead of
 *  stopping on a short page (needed when the contract returns short pages). */
async function fetchAllPages<T>(
  client: { readContract: (args: any) => Promise<any> },
  params: {
    address: Address;
    abi: any;
    functionName: string;
    extraArgs?: readonly unknown[];
    totalItems?: number;
  }
): Promise<T[]> {
  const results: T[] = [];
  const maxOffset = params.totalItems ?? Infinity;
  for (let offset = 0; offset < maxOffset; offset += PAGE) {
    const page = (await client.readContract({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: [BigInt(PAGE), BigInt(offset), ...(params.extraArgs ?? [])],
    })) as T[];
    results.push(...page);
    if (page.length < PAGE && maxOffset === Infinity) break;
  }
  return results;
}

const isStablecoin = (symbol: string) => /USD|EUR/i.test(symbol);
const isBluechip = (symbol: string) => /ETH|BTC/i.test(symbol);
const isAero = (symbol: string) => symbol === "AERO";

/** Build a human-readable pool name. CL pools have empty symbol in Sugar. */
function poolName(pool: PoolMeta, tokenMap: Map<string, TokenMeta>): string {
  if (pool.symbol) return pool.symbol;
  const t0 = tokenMap.get(pool.token0)?.symbol ?? "???";
  const t1 = tokenMap.get(pool.token1)?.symbol ?? "???";
  const prefix =
    pool.type > 0 ? `CL${pool.type}` : pool.type === 0 ? "sAMM" : "vAMM";
  return `${prefix}-${t0}/${t1}`;
}

function rewardTokenSymbols(
  rewards: RawReward,
  tokenMap: Map<string, TokenMeta>
): string[] {
  return rewards
    .filter((r) => r.amount > 0n)
    .map((r) => tokenMap.get(r.token.toLowerCase())?.symbol ?? "???");
}

function computeUsd(
  rewards: RawReward,
  tokenMap: Map<string, TokenMeta>,
  priceMap: PriceMap,
  date: string,
  targetToken?: string
): number {
  let total = 0;
  for (const r of rewards) {
    if (r.amount === 0n) continue;
    const addr = r.token.toLowerCase();
    if (targetToken && addr !== targetToken) continue;
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
  tokenMap: Map<string, TokenMeta>
): Promise<PriceMap> {
  const prices: PriceMap = new Map();
  const ONE_YEAR_S = 364 * DAY;

  let i = 0;
  for (const [addr, range] of tokenRanges) {
    if (i++ > 0) await new Promise((r) => setTimeout(r, 200));
    const dateMap = new Map<string, number>();
    prices.set(addr, dateMap);

    for (
      let chunkStart = range.startTs;
      chunkStart < range.endTs;
      chunkStart += ONE_YEAR_S
    ) {
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
          }
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

function loadPricesCsv(): PriceMap {
  const prices: PriceMap = new Map();
  if (!existsSync("prices.csv")) return prices;
  const lines = readFileSync("prices.csv", "utf-8").trimEnd().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [date, token, , priceStr] = lines[i].split(",");
    const price = parseFloat(priceStr);
    if (!date || !token || isNaN(price)) continue;
    getOrSet(prices, token, () => new Map()).set(date, price);
  }
  return prices;
}

function savePricesCsv(
  prices: PriceMap,
  tokenMap: Map<string, TokenMeta>
): void {
  const rows: { date: string; token: string; symbol: string; price: number }[] =
    [];
  for (const [token, dateMap] of prices) {
    const symbol = tokenMap.get(token)?.symbol ?? "???";
    for (const [date, price] of dateMap) {
      rows.push({ date, token, symbol, price });
    }
  }
  rows.sort(
    (a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol)
  );
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
  const voterAddress = (
    process.argv[2] ?? DEFAULT_VOTER_ADDRESS
  ).toLowerCase() as Address;
  console.log(`Tracking voter address: ${voterAddress}`);

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  // 1. Fetch all pools from LpSugar.all (paginated)
  console.log("Fetching pools…");
  const poolPages = await fetchAllPages<{
    lp: Address;
    symbol: string;
    type: number;
    token0: Address;
    token1: Address;
  }>(client, {
    address: LP_SUGAR,
    abi: lpSugarAbi,
    functionName: "all",
    extraArgs: [0n],
  });
  const pools = new Map<string, PoolMeta>();
  for (const p of poolPages) {
    pools.set(p.lp.toLowerCase(), {
      symbol: p.symbol,
      type: p.type,
      token0: p.token0.toLowerCase(),
      token1: p.token1.toLowerCase(),
    });
  }
  console.log(`  ${pools.size} pools`);

  // 2. Fetch all tokens for fee/bribe symbol resolution
  console.log("Fetching tokens…");
  const tokenPages = await fetchAllPages<{
    token_address: Address;
    symbol: string;
    decimals: number;
  }>(client, {
    address: LP_SUGAR,
    abi: lpSugarAbi,
    functionName: "tokens",
    extraArgs: [ZERO, []],
  });
  const tokens = new Map<string, TokenMeta>();
  for (const t of tokenPages) {
    tokens.set(t.token_address.toLowerCase(), {
      symbol: t.symbol,
      decimals: t.decimals,
    });
  }
  console.log(`  ${tokens.size} tokens`);

  // 3. Fetch latest epochs from RewardsSugar.epochsLatest (paginated)
  console.log("Fetching latest epochs…");
  const latestEpochs = await fetchAllPages<RawEpoch>(client, {
    address: REWARDS_SUGAR,
    abi: rewardsSugarAbi,
    functionName: "epochsLatest",
    totalItems: pools.size,
  });

  const votedPools = latestEpochs.filter((e) => e.votes > 0n);
  console.log(
    `  ${latestEpochs.length} epochs fetched, ${votedPools.length} pools with votes`
  );

  // 4. Fetch ALL historical epochs for every voted pool
  console.log("Fetching historical epochs for all voted pools…");
  const allEpochs = new Map<string, RawEpoch[]>();
  for (const { lp } of votedPools) {
    const addr = lp.toLowerCase();
    if (allEpochs.has(addr)) continue;
    const poolEpochs = await fetchAllPages<RawEpoch>(client, {
      address: REWARDS_SUGAR,
      abi: rewardsSugarAbi,
      functionName: "epochsByAddress",
      extraArgs: [lp],
    });
    allEpochs.set(addr, poolEpochs);
    const pool = pools.get(addr);
    const label = pool ? poolName(pool, tokens) : lp;
    console.log(`  ${label}: ${poolEpochs.length} epochs`);
  }

  // 5. Group by epoch timestamp
  const byEpoch = new Map<number, { lp: string; ep: RawEpoch }[]>();
  for (const [lp, epochs] of allEpochs) {
    for (const ep of epochs) {
      getOrSet(byEpoch, Number(ep.ts), () => []).push({ lp, ep });
    }
  }

  // 6. Fetch Voted events for the tracked address
  console.log(`Fetching voting history for ${voterAddress}…`);
  const tokenVotesByEpoch = new Map<
    number,
    Map<string, { pool: string; weight: number; ts: number }[]>
  >();
  const voterVotesByEpoch = new Map<number, Map<string, number>>();
  {
    const nowTs = Math.floor(Date.now() / 1000);

    // Load cached voter votes from votes.csv for completed epochs
    const cachedEpochs = new Set<number>();
    if (existsSync("votes.csv")) {
      const lines = readFileSync("votes.csv", "utf-8").trimEnd().split("\n");
      const header = lines[0].split(",");
      const idx = (name: string) => header.indexOf(name);
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]
          .split(",")
          .map((v) => v.replace(/^"(.*)"$/, "$1"));
        const epochDate = cols[idx("epoch_date")];
        const pool = cols[idx("pool_address")]?.toLowerCase();
        const voterVotes = parseFloat(cols[idx("voter_votes")]);
        const voterAddr = cols[idx("voter_address")];
        if (voterAddr !== voterAddress) continue;
        if (!epochDate || !pool || isNaN(voterVotes)) continue;
        const epochTs = Math.floor(
          new Date(epochDate + "T00:00:00Z").getTime() / 1000
        );
        if (epochTs + WEEK > nowTs) continue;
        if (voterVotes > 0)
          getOrSet(voterVotesByEpoch, epochTs, () => new Map()).set(
            pool,
            voterVotes
          );
        cachedEpochs.add(epochTs);
      }
      console.log(
        `  Loaded cached voter votes for ${cachedEpochs.size} completed epochs from votes.csv`
      );
    }

    // Determine earliest uncached epoch to narrow the block scan range
    const uncachedEpochs = [...byEpoch.keys()].filter(
      (ts) => !cachedEpochs.has(ts)
    );

    if (uncachedEpochs.length > 0) {
      const BLOCK_CHUNK = 10_000n;
      const BATCH_CONCURRENCY = 10;
      const latestBlock = await client.getBlockNumber();
      const latestBlockData = await client.getBlock({
        blockNumber: latestBlock,
      });

      // Estimate start block from earliest uncached epoch (~2s/block on Base)
      const earliestUncachedTs = Math.min(...uncachedEpochs);
      const secsBack = Number(latestBlockData.timestamp) - earliestUncachedTs;
      const blocksBack = BigInt(Math.ceil(secsBack / 2) + 50_000);
      const estimatedStart =
        latestBlock > blocksBack ? latestBlock - blocksBack : 0n;
      const startBlock =
        estimatedStart > 3_022_926n ? estimatedStart : 3_022_926n;

      const totalChunks = Number((latestBlock - startBlock) / BLOCK_CHUNK) + 1;
      let processed = 0;
      console.log(
        `  ${uncachedEpochs.length} uncached epochs, scanning blocks ${startBlock}–${latestBlock} (${totalChunks} chunks)…`
      );

      for (
        let batchStart = startBlock;
        batchStart <= latestBlock;
        batchStart += BLOCK_CHUNK * BigInt(BATCH_CONCURRENCY)
      ) {
        const batch: Promise<any[]>[] = [];
        for (let i = 0; i < BATCH_CONCURRENCY; i++) {
          const from = batchStart + BLOCK_CHUNK * BigInt(i);
          if (from > latestBlock) break;
          const to =
            from + BLOCK_CHUNK - 1n > latestBlock
              ? latestBlock
              : from + BLOCK_CHUNK - 1n;
          batch.push(
            withRetry(
              () =>
                client.getLogs({
                  address: VOTER,
                  event: votedEvent,
                  args: { voter: voterAddress },
                  fromBlock: from,
                  toBlock: to,
                }),
              `getLogs ${from}–${to}`
            )
          );
        }
        const results = await Promise.all(batch);
        for (const logs of results) {
          for (const log of logs) {
            const pool = log.args.pool!.toLowerCase();
            const tokenId = String(log.args.tokenId!);
            const weight = Number(log.args.weight!) / 1e18;
            const ts = Number(log.args.timestamp!);
            const epochTs = ts - (ts % WEEK);
            if (cachedEpochs.has(epochTs)) continue;
            const byTokenId = getOrSet(
              tokenVotesByEpoch,
              epochTs,
              () => new Map()
            );
            const events = getOrSet(byTokenId, tokenId, () => []);
            events.push({ pool, weight, ts });
          }
          processed++;
        }
        if (processed % 200 === 0) {
          console.log(`  ${processed}/${totalChunks} chunks scanned…`);
        }
      }
    } else {
      console.log("  All epochs cached, skipping block scan");
    }

    // Discard tokenIds not owned by the voter
    const veAddress = await client.readContract({
      address: VOTER,
      abi: voterAbi,
      functionName: "ve",
    });
    const allTokenIds = new Set<string>();
    for (const byTokenId of tokenVotesByEpoch.values()) {
      for (const tokenId of byTokenId.keys()) allTokenIds.add(tokenId);
    }
    const ownedTokenIds = new Set<string>();
    for (const tokenId of allTokenIds) {
      const owner = (
        await client.readContract({
          address: veAddress,
          abi: veAbi,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        })
      ).toLowerCase();
      if (owner === voterAddress) ownedTokenIds.add(tokenId);
    }
    console.log(
      `  ${ownedTokenIds.size}/${allTokenIds.size} tokenIds owned by voter: ${[
        ...ownedTokenIds,
      ].join(", ")}`
    );

    // Aggregate by (epoch, tokenId), keep only events from the latest timestamp
    for (const [epochTs, byTokenId] of tokenVotesByEpoch) {
      const poolTotals = getOrSet(voterVotesByEpoch, epochTs, () => new Map());
      for (const [tokenId, events] of byTokenId) {
        if (!ownedTokenIds.has(tokenId)) continue;
        const maxTs = Math.max(...events.map((e) => e.ts));
        for (const e of events) {
          if (e.ts !== maxTs) continue;
          poolTotals.set(e.pool, (poolTotals.get(e.pool) ?? 0) + e.weight);
        }
      }
    }

    const totalVoterVotes = [...voterVotesByEpoch.values()].reduce(
      (n, m) => n + m.size,
      0
    );
    console.log(
      `  ${totalVoterVotes} pool-vote entries across ${voterVotesByEpoch.size} epochs`
    );
  }

  // 7. Keep top 30 pools per epoch by votes, plus all pools the voter voted for
  const selectedEntries: { ts: number; lp: string; ep: RawEpoch }[] = [];
  for (const [ts, bucket] of byEpoch) {
    bucket.sort((a, b) =>
      b.ep.votes > a.ep.votes ? 1 : b.ep.votes < a.ep.votes ? -1 : 0
    );
    const voterPools = voterVotesByEpoch.get(ts);
    for (const [i, entry] of bucket.entries()) {
      if (i < 30 || voterPools?.has(entry.lp)) {
        selectedEntries.push({ ts, lp: entry.lp, ep: entry.ep });
      }
    }
  }
  console.log(
    `Selected ${
      new Set(selectedEntries.map((e) => e.lp)).size
    } unique pools across ${byEpoch.size} epochs (${
      selectedEntries.length
    } records)`
  );

  // 8. Resolve missing token symbols via Alchemy
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
          {
            jsonrpc: "2.0",
            method: "alchemy_getTokenMetadata",
            params: [addr],
            id: 1,
          }
        );
        if (json.result?.symbol) {
          tokens.set(addr, {
            symbol: json.result.symbol,
            decimals: json.result.decimals ?? 18,
          });
        }
      }
      console.log(
        `  Resolved ${tokens.size - beforeCount} of ${
          missingAddrs.size
        } tokens (${tokens.size} total)`
      );
    }
  }

  // 9. Build entry records from selected pools (top 30 + voter-voted)
  const entries: {
    record: EpochRecord;
    fees: RawReward;
    bribes: RawReward;
    pool_token0: string;
    pool_token1: string;
  }[] = [];
  for (const { lp, ep } of selectedEntries) {
    const pool = pools.get(lp);
    if (!pool) continue;
    const epochStartTs = Number(ep.ts);
    const epochVoterVotes = voterVotesByEpoch.get(epochStartTs);
    const voterVotesForPool = epochVoterVotes?.get(lp) ?? 0;
    const voterTotalForEpoch = epochVoterVotes
      ? [...epochVoterVotes.values()].reduce((a, b) => a + b, 0)
      : 0;
    entries.push({
      record: {
        epoch_ts: epochStartTs,
        epoch_number: 0,
        epoch_date: new Date(epochStartTs * 1000).toISOString().slice(0, 10),
        price_date:
          epochStartTs + WEEK > Math.floor(Date.now() / 1000)
            ? new Date().toISOString().slice(0, 10)
            : new Date((epochStartTs + WEEK) * 1000).toISOString().slice(0, 10),
        pool_name: poolName(pool, tokens),
        pool_type: "other",
        total_votes: 0,
        pool_votes: Number(ep.votes) / 1e18,
        pool_vote_pct: 0,
        voter_votes: voterVotesForPool,
        voter_vote_pct:
          voterTotalForEpoch > 0
            ? Math.round(
                (voterVotesForPool / voterTotalForEpoch) * 100 * 10000
              ) / 10000
            : 0,
        fees_bribes_usd: 0,
        fees_usd: 0,
        bribes_usd: 0,
        bribe_tokens: rewardTokenSymbols(ep.bribes, tokens),
        fees_token0_usd: 0,
        token0: tokens.get(pool.token0)?.symbol ?? "???",
        fees_token1_usd: 0,
        token1: tokens.get(pool.token1)?.symbol ?? "???",
        aero_usd: 0,
        pool_address: ep.lp,
        voter_address: voterAddress,
      },
      fees: ep.fees,
      bribes: ep.bribes,
      pool_token0: pool.token0,
      pool_token1: pool.token1,
    });
  }

  // 10. Fetch token prices and compute USD values
  const cachedPrices = loadPricesCsv();
  const cachedPriceCount = [...cachedPrices.values()].reduce(
    (n, m) => n + m.size,
    0
  );
  console.log(`Loaded ${cachedPriceCount} cached prices from prices.csv`);

  if (alchemyKey) {
    const nowTs = Math.floor(Date.now() / 1000);

    // Collect all needed (token, date) pairs
    const needed = new Map<
      string,
      { dates: Set<string>; completedDates: Set<string> }
    >();
    const addNeeded = (token: string, date: string, isCompleted: boolean) => {
      const entry = getOrSet(needed, token, () => ({
        dates: new Set(),
        completedDates: new Set(),
      }));
      entry.dates.add(date);
      if (isCompleted) entry.completedDates.add(date);
    };

    for (const { record, fees, bribes } of entries) {
      const isCompleted = record.epoch_ts + WEEK <= nowTs;
      addNeeded(AERO, record.price_date, isCompleted);
      for (const r of [...fees, ...bribes]) {
        if (r.amount === 0n) continue;
        addNeeded(r.token.toLowerCase(), record.price_date, isCompleted);
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

    const fetched =
      tokenRanges.size > 0
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
          getOrSet(cachedPrices, token, () => new Map()).set(date, price);
        }
      }
    }

    for (const { record, fees, bribes, pool_token0, pool_token1 } of entries) {
      record.fees_usd = computeUsd(fees, tokens, priceMap, record.price_date);
      record.fees_token0_usd = computeUsd(
        fees,
        tokens,
        priceMap,
        record.price_date,
        pool_token0
      );
      record.fees_token1_usd = computeUsd(
        fees,
        tokens,
        priceMap,
        record.price_date,
        pool_token1
      );
      record.bribes_usd = computeUsd(
        bribes,
        tokens,
        priceMap,
        record.price_date
      );
      record.fees_bribes_usd =
        Math.round((record.fees_usd + record.bribes_usd) * 100) / 100;
      const aeroPrice = priceMap.get(AERO)?.get(record.price_date) ?? 0;
      record.aero_usd = aeroPrice;
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
    const savedPriceCount = [...toSave.values()].reduce(
      (n, m) => n + m.size,
      0
    );
    console.log(
      `Saved ${savedPriceCount} prices to prices.csv (${
        savedPriceCount - cachedPriceCount
      } new)`
    );
  } else {
    console.log("ALCHEMY_API_KEY not set, skipping USD price computation");
  }

  // 11. Compute vote percentages per epoch (using all fetched epoch data)
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
    record.total_votes = total;
    record.pool_vote_pct =
      total > 0
        ? Math.round((record.pool_votes / total) * 100 * 10000) / 10000
        : 0;
  }

  // 12. Compute epoch numbers
  const records = entries.map((e) => e.record);
  const epochTimestamps = [...new Set(records.map((r) => r.epoch_ts))].sort(
    (a, b) => a - b
  );
  if (epochTimestamps.length > 0) {
    const baseTs = epochTimestamps[0];
    for (const r of records) {
      r.epoch_number = Math.round((r.epoch_ts - baseTs) / WEEK);
    }
  }

  // 13. Classify pool types
  {
    // Build map of token address -> earliest epoch timestamp
    const tokenFirstEpoch = new Map<string, number>();
    for (const [lp, epochs] of allEpochs) {
      const pool = pools.get(lp);
      if (!pool) continue;
      for (const ep of epochs) {
        const ts = Number(ep.ts);
        for (const addr of [pool.token0, pool.token1]) {
          const prev = tokenFirstEpoch.get(addr);
          if (prev === undefined || ts < prev) tokenFirstEpoch.set(addr, ts);
        }
      }
    }

    for (const { record, pool_token0, pool_token1 } of entries) {
      const sym0 = record.token0;
      const sym1 = record.token1;
      const s0 = isStablecoin(sym0);
      const s1 = isStablecoin(sym1);
      const b0 = isBluechip(sym0);
      const b1 = isBluechip(sym1);
      const a0 = isAero(sym0);
      const a1 = isAero(sym1);

      if (s0 && s1) {
        record.pool_type = "stablecoin";
      } else if ((b0 && (b1 || s1)) || (b1 && (b0 || s0))) {
        record.pool_type = "bluechip";
      } else if ((a0 && (b1 || s1)) || (a1 && (b0 || s0))) {
        record.pool_type = "aero";
      } else {
        // Check if either token is "new" (first appeared within last 4 epochs)
        const threshold = record.epoch_ts - 3 * WEEK;
        const first0 = tokenFirstEpoch.get(pool_token0);
        const first1 = tokenFirstEpoch.get(pool_token1);
        if (
          (first0 !== undefined && first0 >= threshold) ||
          (first1 !== undefined && first1 >= threshold)
        ) {
          record.pool_type = "new";
        } else {
          record.pool_type = "other";
        }
      }
    }
  }

  records.sort(
    (a, b) => b.epoch_ts - a.epoch_ts || b.pool_votes - a.pool_votes
  );

  // 14. Write votes.csv
  const fields = [
    "epoch_number",
    "epoch_date",
    "pool_name",
    "pool_type",
    "total_votes",
    "pool_votes",
    "pool_vote_pct",
    "voter_votes",
    "voter_vote_pct",
    "fees_bribes_usd",
    "fees_usd",
    "bribes_usd",
    "bribe_tokens",
    "fees_token0_usd",
    "token0",
    "fees_token1_usd",
    "token1",
    "aero_usd",
    "pool_address",
    "voter_address",
  ] as const;

  const csvLines = [fields.join(",")];
  for (const r of records) {
    csvLines.push(
      fields
        .map((f) => {
          const v = r[f];
          if (Array.isArray(v)) return v.join(";");
          if (typeof v === "string") return `"${v}"`;
          return String(v);
        })
        .join(",")
    );
  }
  writeFileSync("votes.csv", csvLines.join("\n") + "\n");
  console.log(
    `Saved ${records.length} records across ${epochTimestamps.length} epochs`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
