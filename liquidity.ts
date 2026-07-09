import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Reconstructs the full ownership history of vAMM-kVCM/USDC liquidity from
// on-chain events: LP token transfers (mints, burns, moves) plus gauge
// deposits/withdrawals, so staked LP is attributed back to its staker. Raw
// events are cached in liquidity-events.csv (incremental, like history.ts);
// per-epoch ownership snapshots are written to liquidity.csv and a summary
// is printed to stdout.
//
// eth_getLogs needs wide block ranges, which the default Alchemy free-tier
// endpoint caps at 10 blocks, so log scanning uses LOGS_RPC_URL (default:
// the public https://mainnet.base.org, 10k-block cap). BASE_RPC_URL is only
// used for current-state reads and the final balance verification.

// Deployed contracts on Base (same as history.ts)
const POOL = "0x5C0D76fab1822bDeb47308eD6028231761ED723E" as const; // vAMM-kVCM/USDC
const GAUGE = "0x57387e4639048B67C30C911a145368bC5B33fE3b" as const;
const VOTER_ADDRESS = "0xa79cd47655156b299762dfe92a67980805ce5a31" as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x0000000000000000000000000000000000000001"; // MINIMUM_LIQUIDITY sink

const POOL_DEPLOY_BLOCK = 37190243n;
const FIRST_FLIP_TS = 1761177600; // 2025-10-23 00:00 UTC
const WEEK = 7 * 24 * 3600;
const FLIP_OFFSET_S = 3600; // sample 1h after the flip, same as pool-history.csv
const LOGS_CHUNK = 10_000n; // mainnet.base.org getLogs range cap
const LOGS_CONCURRENCY = 5;

const EVENTS_CSV = "liquidity-events.csv";
const SNAPSHOTS_CSV = "liquidity.csv";

const events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1)",
  "event Deposit(address indexed from, address indexed to, uint256 amount)",
  "event Withdraw(address indexed from, uint256 amount)",
]);

const poolAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)",
]);

type Ev = {
  block: bigint;
  logIndex: number;
  txHash: string;
  contract: "pool" | "gauge";
  event: string;
  from: string;
  to: string;
  amount: bigint; // LP amount (Transfer value / Deposit / Withdraw amount)
  amount0: bigint; // kVCM side of Mint/Burn
  amount1: bigint; // USDC side of Mint/Burn
};

// -- Helpers (same conventions as history.ts) --

const MAX_RETRIES = 10;
const MAX_BACKOFF_S = 64;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTransient =
        err?.name === "TimeoutError" ||
        err?.name === "HttpRequestError" ||
        err?.details?.includes("timed out") ||
        err?.status === 429 ||
        err?.code === "ECONNRESET";
      if (isTransient && attempt < MAX_RETRIES) {
        const backoff = Math.min(2 ** attempt, MAX_BACKOFF_S);
        console.warn(
          `  ${err?.name ?? "Error"} (${label}), retrying in ${backoff}s (attempt ${
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

const numStr = (n: number) =>
  n === 0 ? "0" : parseFloat(n.toPrecision(12)).toString();
const lp = (wei: bigint) => Number(wei) / 1e18;

// -- Event cache --

const EVENTS_HEADER =
  "block,log_index,tx_hash,contract,event,from,to,amount,amount0,amount1";

function loadEventsCsv(): Ev[] {
  if (!existsSync(EVENTS_CSV)) return [];
  const lines = readFileSync(EVENTS_CSV, "utf-8").trimEnd().split("\n");
  const out: Ev[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    out.push({
      block: BigInt(c[0]),
      logIndex: parseInt(c[1]),
      txHash: c[2],
      contract: c[3] as Ev["contract"],
      event: c[4],
      from: c[5],
      to: c[6],
      amount: BigInt(c[7]),
      amount0: BigInt(c[8]),
      amount1: BigInt(c[9]),
    });
  }
  return out;
}

function saveEventsCsv(evs: Ev[]) {
  const rows = evs.map((e) =>
    [
      e.block,
      e.logIndex,
      e.txHash,
      e.contract,
      e.event,
      e.from,
      e.to,
      e.amount,
      e.amount0,
      e.amount1,
    ].join(",")
  );
  writeFileSync(EVENTS_CSV, [EVENTS_HEADER, ...rows].join("\n") + "\n");
}

async function fetchEvents(logsClient: any, latestBlock: bigint): Promise<Ev[]> {
  const cached = loadEventsCsv();
  const fromBlock =
    cached.length > 0 ? cached[cached.length - 1].block + 1n : POOL_DEPLOY_BLOCK;
  if (fromBlock > latestBlock) return cached;

  const starts: bigint[] = [];
  for (let b = fromBlock; b <= latestBlock; b += LOGS_CHUNK) starts.push(b);
  console.log(
    `Scanning ${starts.length} chunks of ${LOGS_CHUNK} blocks (${fromBlock} → ${latestBlock})…`
  );

  const chunkResults: Ev[][] = new Array(starts.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < starts.length) {
      const i = next++;
      const from = starts[i];
      const to =
        from + LOGS_CHUNK - 1n > latestBlock ? latestBlock : from + LOGS_CHUNK - 1n;
      const logs = await withRetry(
        () =>
          logsClient.getLogs({
            address: [POOL, GAUGE],
            events,
            fromBlock: from,
            toBlock: to,
          }),
        `getLogs ${from}-${to}`
      );
      chunkResults[i] = logs.map((l: any) => ({
        block: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
        contract: l.address.toLowerCase() === POOL.toLowerCase() ? "pool" : "gauge",
        event: l.eventName,
        from: (l.args.from ?? l.args.sender ?? "").toLowerCase(),
        to: (l.args.to ?? "").toLowerCase(),
        amount: l.args.value ?? l.args.amount ?? 0n,
        amount0: l.args.amount0 ?? 0n,
        amount1: l.args.amount1 ?? 0n,
      }));
      if (++done % 100 === 0)
        console.log(`  ${done}/${starts.length} chunks scanned`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LOGS_CONCURRENCY, starts.length) }, worker)
  );

  const fresh = chunkResults.flat();
  // The pool and the gauge both emit Deposit-like signatures only on their own
  // contract, so no cross-contract ambiguity; just sort and merge.
  fresh.sort((a, b) =>
    a.block !== b.block ? Number(a.block - b.block) : a.logIndex - b.logIndex
  );
  const all = [...cached, ...fresh];
  saveEventsCsv(all);
  console.log(`${all.length} events cached (${fresh.length} new)`);
  return all;
}

// -- Ownership reconstruction --

class Ledger {
  wallet = new Map<string, bigint>(); // LP held directly
  staked = new Map<string, bigint>(); // LP staked in the gauge, per staker

  private add(m: Map<string, bigint>, k: string, v: bigint) {
    const next = (m.get(k) ?? 0n) + v;
    if (next === 0n) m.delete(k);
    else m.set(k, next);
  }

  apply(e: Ev) {
    if (e.contract === "pool" && e.event === "Transfer") {
      if (e.from !== ZERO) this.add(this.wallet, e.from, -e.amount);
      if (e.to !== ZERO) this.add(this.wallet, e.to, e.amount);
    } else if (e.contract === "gauge" && e.event === "Deposit") {
      // LP moved staker -> gauge via the pool Transfer in the same tx; credit
      // the stake to the recipient (`to`), who owns it inside the gauge.
      this.add(this.staked, e.to, e.amount);
    } else if (e.contract === "gauge" && e.event === "Withdraw") {
      this.add(this.staked, e.from, -e.amount);
    }
  }

  /** Effective LP ownership: direct wallet balance (excluding the gauge's own
   * pooled balance and transient pool-held LP) plus gauge stake. */
  owners(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const skip = new Set([GAUGE.toLowerCase(), POOL.toLowerCase()]);
    for (const [a, v] of this.wallet) if (!skip.has(a)) out.set(a, v);
    for (const [a, v] of this.staked) out.set(a, (out.get(a) ?? 0n) + v);
    return out;
  }

  totalSupply(): bigint {
    let sum = 0n;
    for (const v of this.wallet.values()) sum += v;
    return sum;
  }
}

// -- pool-history.csv join (per-epoch USD context) --

type EpochState = {
  block: bigint;
  poolSupply: number;
  tvlUsd: number;
  kvcmUsd: number;
  usdcUsd: number;
};

function loadPoolHistory(): Map<number, EpochState> {
  const out = new Map<number, EpochState>();
  if (!existsSync("pool-history.csv")) return out;
  const lines = readFileSync("pool-history.csv", "utf-8").trimEnd().split("\n");
  const h = lines[0].split(",");
  const idx = (n: string) => h.indexOf(n);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const r0 = parseFloat(c[idx("reserve0_kvcm")]);
    const r1 = parseFloat(c[idx("reserve1_usdc")]);
    const p0 = parseFloat(c[idx("token0_usd")]);
    const p1 = parseFloat(c[idx("token1_usd")]);
    out.set(parseInt(c[idx("epoch_ts")]), {
      block: BigInt(c[idx("block")]),
      poolSupply: parseFloat(c[idx("pool_supply_lp")]),
      tvlUsd: r0 * p0 + r1 * p1,
      kvcmUsd: p0,
      usdcUsd: p1,
    });
  }
  return out;
}

// -- Main --

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL environment variable is required");
  const logsRpcUrl = process.env.LOGS_RPC_URL ?? "https://mainnet.base.org";

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const logsClient = createPublicClient({
    chain: base,
    transport: http(logsRpcUrl),
  });

  const latest = await withRetry(() => logsClient.getBlock(), "getBlock latest");
  const evs = await fetchEvents(logsClient, latest.number);

  // Deploy-block timestamp anchors the 2s-per-block clock used to date events.
  const deployTs = Number(
    (
      await withRetry(
        () => logsClient.getBlock({ blockNumber: POOL_DEPLOY_BLOCK }),
        "getBlock deploy"
      )
    ).timestamp
  );
  const tsOf = (block: bigint) => deployTs + 2 * Number(block - POOL_DEPLOY_BLOCK);
  const dateOf = (block: bigint) =>
    new Date(tsOf(block) * 1000).toISOString().slice(0, 10);

  // Replay events chronologically, snapshotting ownership at each epoch flip
  // (+1h, same instant pool-history.csv samples) and at the latest block.
  const history = loadPoolHistory();
  const now = Math.floor(Date.now() / 1000);
  const lastFlip = now - (now % WEEK);
  const flips: number[] = [];
  for (let ts = FIRST_FLIP_TS; ts <= lastFlip; ts += WEEK) flips.push(ts);

  const flipBlock = (ts: number) =>
    history.get(ts)?.block ??
    POOL_DEPLOY_BLOCK + BigInt(Math.floor((ts + FLIP_OFFSET_S - deployTs) / 2));

  const ledger = new Ledger();
  const snapshots: { ts: number; owners: Map<string, bigint> }[] = [];
  let flipIdx = 0;
  for (const e of evs) {
    while (flipIdx < flips.length && e.block > flipBlock(flips[flipIdx])) {
      snapshots.push({ ts: flips[flipIdx], owners: ledger.owners() });
      flipIdx++;
    }
    ledger.apply(e);
  }
  while (flipIdx < flips.length) {
    snapshots.push({ ts: flips[flipIdx], owners: ledger.owners() });
    flipIdx++;
  }
  const current = ledger.owners();

  // Per-address lifetime flows from Mint/Burn events. The LP recipient of the
  // Transfer(0x0 -> X) in the same tx is the depositor; Burn's `to` is the
  // withdrawer. A vAMM add/remove is balanced, so USD value ~= 2x USDC side.
  type Flow = {
    depositedUsd: number;
    withdrawnUsd: number;
    depositedKvcm: number;
    depositedUsdc: number;
    withdrawnKvcm: number;
    withdrawnUsdc: number;
    firstBlock: bigint;
    lastBlock: bigint;
    mints: number;
    burns: number;
  };
  const flows = new Map<string, Flow>();
  const flow = (a: string): Flow => {
    let f = flows.get(a);
    if (!f)
      flows.set(
        a,
        (f = {
          depositedUsd: 0,
          withdrawnUsd: 0,
          depositedKvcm: 0,
          depositedUsdc: 0,
          withdrawnKvcm: 0,
          withdrawnUsdc: 0,
          firstBlock: 0n,
          lastBlock: 0n,
          mints: 0,
          burns: 0,
        })
      );
    return f;
  };
  const mintRecipientByTx = new Map<string, string>();
  for (const e of evs)
    if (
      e.contract === "pool" &&
      e.event === "Transfer" &&
      e.from === ZERO &&
      e.to !== DEAD
    )
      mintRecipientByTx.set(e.txHash, e.to);
  for (const e of evs) {
    if (e.contract !== "pool") continue;
    if (e.event === "Mint") {
      const owner = mintRecipientByTx.get(e.txHash) ?? e.from;
      const f = flow(owner);
      f.depositedKvcm += Number(e.amount0) / 1e18;
      f.depositedUsdc += Number(e.amount1) / 1e6;
      f.depositedUsd += (Number(e.amount1) / 1e6) * 2;
      f.mints++;
      if (f.firstBlock === 0n) f.firstBlock = e.block;
      f.lastBlock = e.block;
    } else if (e.event === "Burn") {
      const f = flow(e.to);
      f.withdrawnKvcm += Number(e.amount0) / 1e18;
      f.withdrawnUsdc += Number(e.amount1) / 1e6;
      f.withdrawnUsd += (Number(e.amount1) / 1e6) * 2;
      f.burns++;
      if (f.firstBlock === 0n) f.firstBlock = e.block;
      f.lastBlock = e.block;
    }
  }

  // Verify the reconstruction against on-chain state at the latest block.
  const addrs = [...new Set([...current.keys(), ...flows.keys()])].filter(
    (a) => a !== DEAD
  );
  const [poolSupplyRaw, reserves, ...balances] = await withRetry(
    () =>
      client.multicall({
        contracts: [
          { address: POOL, abi: poolAbi, functionName: "totalSupply" },
          { address: POOL, abi: poolAbi, functionName: "getReserves" },
          ...addrs.flatMap((a) => [
            {
              address: POOL,
              abi: poolAbi,
              functionName: "balanceOf",
              args: [a],
            } as const,
            {
              address: GAUGE,
              abi: poolAbi,
              functionName: "balanceOf",
              args: [a],
            } as const,
          ]),
        ],
        allowFailure: false,
        blockNumber: latest.number,
      }),
    "verification multicall"
  );
  let mismatches = 0;
  for (let i = 0; i < addrs.length; i++) {
    const onChain =
      (balances[2 * i] as bigint) + (balances[2 * i + 1] as bigint);
    const ours = current.get(addrs[i]) ?? 0n;
    if (onChain !== ours) {
      mismatches++;
      console.warn(
        `  MISMATCH ${addrs[i]}: reconstructed ${lp(ours)} vs on-chain ${lp(onChain)}`
      );
    }
  }
  const supplyDelta =
    (poolSupplyRaw as bigint) - ledger.totalSupply() - 0n;
  console.log(
    `Verification: ${addrs.length} addresses checked, ${mismatches} mismatches; ` +
      `supply delta ${lp(supplyDelta)} LP`
  );

  // Contract detection for labelling.
  const isContract = new Map<string, boolean>();
  for (const a of addrs) {
    const code = await withRetry(
      () => client.getCode({ address: a as `0x${string}` }),
      `getCode ${a}`
    );
    isContract.set(a, !!code && code !== "0x");
  }

  // liquidity.csv: long-format per-epoch ownership.
  const totalAt = (owners: Map<string, bigint>) => {
    let t = 0n;
    for (const v of owners.values()) t += v;
    return t;
  };
  const rows: string[] = [
    "epoch_ts,epoch_date,address,lp,share_pct,usd_value",
  ];
  for (const s of snapshots) {
    const st = history.get(s.ts);
    const total = totalAt(s.owners);
    const date = new Date(s.ts * 1000).toISOString().slice(0, 10);
    const sorted = [...s.owners].sort((a, b) => (b[1] > a[1] ? 1 : -1));
    for (const [a, v] of sorted) {
      if (v === 0n) continue;
      const share = total > 0n ? Number((v * 1_000_000n) / total) / 10_000 : 0;
      const usd = st ? (lp(v) / st.poolSupply) * st.tvlUsd : NaN;
      rows.push(
        [
          s.ts,
          date,
          a,
          numStr(lp(v)),
          share.toFixed(4),
          isNaN(usd) ? "" : usd.toFixed(2),
        ].join(",")
      );
    }
  }
  // Current state as a final pseudo-epoch row set.
  {
    const r0 = Number((reserves as any)[0]) / 1e18;
    const r1 = Number((reserves as any)[1]) / 1e6;
    const kvcmUsd = r0 > 0 ? r1 / r0 : 0;
    const tvlUsd = r0 * kvcmUsd + r1; // USDC ~ $1
    const total = totalAt(current);
    const date = new Date(now * 1000).toISOString().slice(0, 10);
    const sorted = [...current].sort((a, b) => (b[1] > a[1] ? 1 : -1));
    for (const [a, v] of sorted) {
      if (v === 0n) continue;
      const share = total > 0n ? Number((v * 1_000_000n) / total) / 10_000 : 0;
      const usd = (lp(v) / lp(poolSupplyRaw as bigint)) * tvlUsd;
      rows.push([now, date, a, numStr(lp(v)), share.toFixed(4), usd.toFixed(2)].join(","));
    }
    console.log(
      `\nCurrent pool: ${numStr(r0)} kVCM + ${numStr(r1)} USDC` +
        ` (TVL ~$${tvlUsd.toFixed(0)}, kVCM ~$${kvcmUsd.toFixed(4)})`
    );
  }
  writeFileSync(SNAPSHOTS_CSV, rows.join("\n") + "\n");
  console.log(`Saved ${rows.length - 1} snapshot rows to ${SNAPSHOTS_CSV}`);

  // Console summary: lifetime flows and current holders.
  const label = (a: string) =>
    a === VOTER_ADDRESS.toLowerCase()
      ? " (tracked voter)"
      : isContract.get(a)
      ? " (contract)"
      : "";
  console.log("\nLifetime deposits/withdrawals per address (USD ~= 2x USDC side):");
  const byDeposit = [...flows].sort(
    (a, b) => b[1].depositedUsd - a[1].depositedUsd
  );
  for (const [a, f] of byDeposit) {
    console.log(
      `  ${a}${label(a)}: deposited ~$${f.depositedUsd.toFixed(0)} ` +
        `(${numStr(f.depositedKvcm)} kVCM + ${numStr(f.depositedUsdc)} USDC, ${f.mints} adds), ` +
        `withdrawn ~$${f.withdrawnUsd.toFixed(0)} (${f.burns} removes), ` +
        `active ${dateOf(f.firstBlock)} → ${dateOf(f.lastBlock)}`
    );
  }
  console.log("\nCurrent LP ownership:");
  const total = totalAt(current);
  const sorted = [...current].sort((a, b) => (b[1] > a[1] ? 1 : -1));
  for (const [a, v] of sorted) {
    if (v === 0n) continue;
    const share = total > 0n ? Number((v * 1_000_000n) / total) / 10_000 : 0;
    console.log(`  ${a}${label(a)}: ${numStr(lp(v))} LP (${share.toFixed(2)}%)`);
  }
}

main();
