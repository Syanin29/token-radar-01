// Token Radar's scoring model, restated: a sealed snapshot goes in, a ranked board comes out.
//
// radar-2-comps prices each pre-token protocol from its own snapshot figures. The price is a
// category multiple — the winsorized median of market-cap-over-TVL among the category's
// protocols whose token already trades — times the protocol's TVL, nudged by two small
// factors: recent growth and how long the protocol has run without a token. No name is ever
// hardcoded; every number comes from the snapshot passed in.
//
// A protocol counts as pre-token when its record shows no token at all: market cap, CoinGecko
// id and symbol are all empty. Even then it only ranks when it is not a wrapped, staked or
// bridged spin-off of a token that already trades. That rules out the Bridge / Canonical
// Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX categories, names that carry
// a whole word wrapped, staked or staking, names that open with an exchange's name, and names
// that close with a version tag. The snapshot's watchlist is a floor, not the board: all 40 of
// its slugs appear, and the radar appends every other rankable protocol underneath, so the
// board covers the full rankable set, not just the floor.
//
// The value of one row, all from the snapshot:
//   multiple  = clamp(winsorized median of FDV/TVL over traded peers in the category, 0.02, 1.5)
//   growth    = clamp(change_7d, -60, 120), in percent
//   growthMul = 1 + (growth / 100) * 0.5
//   maturity  = 0.6 + min(age_days, 1095) / 1095 * 0.4   (age missing: 365 days)
//   implied   = max(1, round(tvl_usd * multiple * growthMul * maturity))
//
// Age is measured from the day DefiLlama first listed the protocol — the best available
// record of how long it has operated token-free. Growth and maturity only nudge the figure;
// the category multiple and the TVL decide the order. One scoring function serves all rows.

/** One protocol entry from the snapshot: the ten fields the sealed input carries. */
export interface SnapshotProtocol
{
  slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
}

/** The snapshot as a whole document. */
export interface Snapshot
{
  as_of: string; source: string;
  floor_usd: number; protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model constants, as the dashboard prints them. */
export interface ModelConstants
{
  growth_weight: number; growth_floor: number;
  growth_cap: number; maturity_floor: number;
  maturity_range: number; maturity_days: number;
  unknown_age_days: number; multiple_floor: number;
  multiple_cap: number; min_peers: number;
  winsor_low: number; winsor_high: number;
}

export const MODEL: ModelConstants =
{
  growth_weight: 0.5, growth_floor: -60,
  growth_cap: 120, maturity_floor: 0.6,
  maturity_range: 0.4, maturity_days: 1095,
  unknown_age_days: 365, multiple_floor: 0.02,
  multiple_cap: 1.5, min_peers: 4,
  winsor_low: 0.05, winsor_high: 0.95,
};

/** The version label the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2-comps';

/** The live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS: number = 24;

/** One category's traded peers: the multiple the board uses for it, and where it came from. */
export interface CategoryComp
{
  category: string; peers: number;
  median_ratio: number; multiple: number;
  source: 'category' | 'global';
}

/** The comps table: the global fallback multiple and one row per category that has peers. */
export interface CompsTable
{
  global_multiple: number; global_peers: number;
  categories: CategoryComp[];
}

/** A farm step: an action, what it costs, and how long it takes. */
export interface FarmStep
{
  text: string; cost: string; time: string;
}

/** One board.json row: the ranked board's row. */
export interface BoardRow
{
  rank: number; slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; watchlist: boolean;
  age_days: number | null; implied_value_usd: number;
  model:
  {
    category_multiple: number; multiple_source: 'category' | 'global';
    peers: number; growth_pct: number;
    growth_multiplier: number; maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow
{
  rank: number; slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null;
  listed_at: string | null; age_days: number | null;
  watchlist: boolean; implied_value_usd: number;
  category_multiple: number; multiple_source: 'category' | 'global';
  peers: number; growth_multiplier: number;
  maturity_multiplier: number; farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow
{
  slug: string; name: string;
  category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the comps and the model. */
export interface RadarData
{
  as_of: string; source: string; floor_usd: number;
  model: ModelConstants; model_version: string;
  watchlist_size: number; board_size: number;
  early_size: number; live_size: number;
  comps: CompsTable; rows: RadarRow[];
  live: LiveRow[];
}

/** Raised when the snapshot is not one this model can score. */
export class SnapshotError extends Error
{
  constructor(msg: string) {
    super(msg);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Four decimals, the precision the board and the dashboard both print. */
const roundTo4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** `value` when it is a finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** The median of an already-sorted array; NaN when empty. */
function medianOfSorted(sorted: number[]): number {
  const count = sorted.length;
  if (count === 0) return NaN;
  return count % 2 === 1 ? sorted[(count - 1) / 2]! : (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2;
}

/**
 * Winsorize a sample at the given quantiles, then take the median, so the tails cannot drag
 * the multiple. Deterministic: sorting and index math only.
 */
function clippedMedian(values: number[], low: number, high: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return NaN;
  const floor = ordered[Math.floor(low * (ordered.length - 1))]!;
  const ceiling = ordered[Math.ceil(high * (ordered.length - 1))]!;
  const clipped = ordered.map((v) => Math.min(ceiling, Math.max(floor, v)));
  return medianOfSorted(clipped);
}

/** A raw median forced inside the model's multiple band. */
function clampMultiple(raw: number, model: ModelConstants): number {
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, raw));
}

/** Whole days from `from` to `to`, floored at zero; null when a date is absent or bad. */
export function ageDays(snapDate: string, listed: string | null): number | null {
  if (listed === null) return null;
  const snapshotDay = Date.parse(`${snapDate}T00:00:00Z`);
  const listedDay = Date.parse(`${listed}T00:00:00Z`);
  if (!Number.isFinite(snapshotDay) || !Number.isFinite(listedDay)) return null;
  return Math.max(0, Math.floor((snapshotDay - listedDay) / MS_PER_DAY));
}

/**
 * The comps table of the snapshot: for every category with at least `min_peers` traded
 * protocols, the winsorized median of their market-cap-over-TVL ratios, clamped to the
 * multiple band; the same for the whole traded set, which thin categories fall back to.
 */
export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): CompsTable {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const ratios = traded.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMultiple = clampMultiple(clippedMedian(ratios, model.winsor_low, model.winsor_high), model);
  const perCategory = new Map<string, number[]>();
  traded.forEach((p) => {
    if (p.category === null) return;
    const bucket = perCategory.get(p.category) ?? [];
    bucket.push(p.mcap_usd! / p.tvl_usd);
    perCategory.set(p.category, bucket);
  });
  const categories: CategoryComp[] = [...perCategory.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .filter(([, bucket]) => bucket.length >= model.min_peers)
    .map(([category, bucket]) => {
      const med = clippedMedian(bucket, model.winsor_low, model.winsor_high);
      return { category, peers: bucket.length, median_ratio: roundTo4dp(med), multiple: roundTo4dp(clampMultiple(med, model)), source: 'category' as const };
    });
  return { global_multiple: roundTo4dp(globalMultiple), global_peers: traded.length, categories };
}

/** The multiple one category gets: its own comps row, else the global fallback. */
export function multipleFor(category: string | null, comps: CompsTable): { multiple: number; source: 'category' | 'global'; peers: number } {
  if (category !== null) {
    const hit = comps.categories.find((c) => c.category === category);
    if (hit !== undefined) return { multiple: hit.multiple, source: 'category', peers: hit.peers };
  }
  return { multiple: comps.global_multiple, source: 'global', peers: comps.global_peers };
}

/** The multipliers and the implied value one protocol gets under `model` and `comps`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: CompsTable,
  model: ModelConstants,
): { implied: number; multiple: number; source: 'category' | 'global'; peers: number; growthPct: number; growthFactor: number; maturityFactor: number; age: number | null } {
  const growthRaw = finiteOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, growthRaw));
  const growthFactor = 1 + (growthPct / 100) * model.growth_weight;
  const ageVal = ageDays(asOf, protocol.listed_at);
  const ageUsed = ageVal ?? model.unknown_age_days;
  const maturityFactor = model.maturity_floor + (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const { multiple, source, peers } = multipleFor(protocol.category, comps);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthFactor * maturityFactor));
  return { implied, multiple, source, peers, growthPct, growthFactor, maturityFactor, age: ageVal };
}

/** A name ending in a release is a pool of another protocol, by DefiLlama's version-marker rule. */
const VERSION_TAG = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const DERIVATIVE_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Exchange names: a protocol starting with one is the exchange's own product. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol's record carries no token at all. */
export function isPreToken(proto: SnapshotProtocol): boolean {
  return proto.mcap_usd === null && proto.gecko_id === null && proto.symbol === null;
}

/** Whether the board may rank a protocol: pre-token and no wrapped/staked product. */
export function isRankable(proto: SnapshotProtocol): boolean {
  if (!isPreToken(proto)) return false;
  if (proto.category !== null && DERIVATIVE_CATS.has(proto.category)) return false;
  if (EXCHANGE_NAMES.some((name) => proto.name.startsWith(name))) return false;
  if (VERSION_TAG.test(proto.name)) return false;
  if (WRAPPED_WORD.test(proto.name)) return false;
  return true;
}

/** The snapshot's protocols keyed by slug. */
function slugIndex(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((entry) => [entry.slug, entry]));
}

/** The board's protocols, strongest first, carrying ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; comps: CompsTable } {
  const comps = buildComps(snapshot, model);
  const index = slugIndex(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: each slug it names joins when the snapshot carries it.
  snapshot.watchlist.forEach((slug) => {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  });
  // The early radar: every other rankable protocol, whatever its TVL. A picked protocol is
  // never displaced by an early one.
  snapshot.protocols.forEach((p) => {
    if (!picked.has(p.slug) && isRankable(p)) picked.set(p.slug, p);
  });

  const scored = [...picked.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, model);
    return { protocol: p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0));
  const watchlist = new Set(snapshot.watchlist);
  const board: BoardRow[] = scored.map((s, position) => ({
    rank: position + 1, slug: s.protocol.slug, name: s.protocol.name,
    category: s.protocol.category,
    chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd,
    change_7d: s.protocol.change_7d,
    mcap_usd: s.protocol.mcap_usd,
    listed_at: s.protocol.listed_at,
    gecko_id: s.protocol.gecko_id,
    symbol: s.protocol.symbol,
    token_status: 'pre-token', watchlist: watchlist.has(s.protocol.slug),
    age_days: s.age, implied_value_usd: s.implied,
    model: { category_multiple: s.multiple,
      multiple_source: s.source,
      peers: s.peers,
      growth_pct: s.growthPct, growth_multiplier: roundTo4dp(s.growthFactor),
      maturity_multiplier: roundTo4dp(s.maturityFactor), age_days: s.age,
    },
    farm_steps: farmSteps(s.protocol, s.age).map(stepText),
  }));
  return { board, comps };
}

/** One step as a single string: action first, then its cost and time, inside the gate's 20..600 characters. */
export function stepText(item: FarmStep): string {
  let joined = `${item.text} Cost: ${item.cost}. Time: ${item.time}.`;
  if (joined.length > 600) joined = `${joined.slice(0, 596)}...`;
  if (joined.length < 20) joined = `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/** The first chain a protocol names, else a neutral phrase. */
function primaryChain(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  return p.chains[0]!;
}

/** The capital one farm position needs, from the protocol's own TVL. */
const CAPITAL_TIERS: Array<{ atLeast: number; amount: number }> = [
  { atLeast: 5_000_000_000, amount: 250 },
  { atLeast: 1_000_000_000, amount: 150 },
  { atLeast: 100_000_000, amount: 100 },
];
const CAPITAL_FALLBACK = 50;
function capitalTier(p: SnapshotProtocol): number {
  for (const tier of CAPITAL_TIERS) if (p.tvl_usd >= tier.atLeast) return tier.amount;
  return CAPITAL_FALLBACK;
}

/** The hold length, from the protocol's age: younger protocols get a longer qualifying window. */
const HOLD_BANDS: Array<{ under: number; days: number }> = [
  { under: 180, days: 60 },
  { under: 365, days: 45 },
];
const HOLD_DEFAULT = 30;
function holdSpan(age: number | null): number {
  if (age === null) return HOLD_DEFAULT;
  for (const band of HOLD_BANDS) if (age < band.under) return band.days;
  return HOLD_DEFAULT;
}

/** The gas a transaction on the protocol's main chain usually costs, in dollars. */
const GAS_BY_CHAIN: Record<string, { setup: number; weekly: number }> = {
  Ethereum: { setup: 12, weekly: 6 },
  Bitcoin: { setup: 5, weekly: 3 },
  Tron: { setup: 5, weekly: 3 },
};
function gasQuote(chain: string): { setup: number; weekly: number } {
  return GAS_BY_CHAIN[chain] ?? { setup: 2, weekly: 1 };
}

/** One opening move: which categories it fits, and the sentence it writes. */
interface OpeningMove {
  test: (category: string) => boolean;
  text: (name: string, capital: number, chain: string) => string;
}
const OPENING_MOVES: OpeningMove[] = [
  { test: (c) => c.includes('risk curator') || c.includes('curator') || c.includes('allocator'), text: (name, capital, chain) => `Deposit $${capital} of USDC into a ${name} curator vault on ${chain} and keep the vault shares.` },
  { test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), text: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it and repay it once.` },
  { test: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'), text: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
  { test: (c) => c.includes('staking') || c.includes('restak'), text: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.` },
  { test: (c) => c.includes('perpetual') || c.includes('derivative'), text: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.` },
  { test: (c) => c.includes('prediction'), text: (name, capital, chain) => `Fund $${capital} and place one market position on ${name}, then settle it when the market resolves.` },
  { test: (c) => c.includes('stable'), text: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.` },
  { test: (c) => c.includes('rwa'), text: (name, capital, chain) => `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the full term.` },
  { test: (c) => c.includes('insurance'), text: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.` },
  { test: (c) => c.includes('options'), text: (name, capital, chain) => `Deposit $${capital} of USDC into an ${name} options vault on ${chain} and keep the shares.` },
  { test: (c) => c.includes('payment') || c.includes('card'), text: (name, capital, chain) => `Spend $${capital} through ${name} on ${chain} and keep the receipts as activity.` },
  { test: (c) => c.includes('chain'), text: (name, capital, chain) => `Bridge $${capital} of USDC to ${name} and use it in one of its native apps.` },
];

/** The one opening action for the category, in words a farmer can follow. */
function openingAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const lowered = (p.category ?? '').toLowerCase();
  for (const move of OPENING_MOVES) {
    if (move.test(lowered)) return move.text(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** One weekly move: which categories it fits, and the sentence it writes. */
interface WeeklyMove {
  test: (category: string) => boolean; text: string;
}
const WEEKLY_MOVES: WeeklyMove[] = [
  { test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), text: 'Make one qualifying action each week: a deposit, a borrow, a repayment or a vote.' },
  { test: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'), text: 'Make one qualifying action each week: add or remove a little liquidity, or swap once through the pool.' },
  { test: (c) => c.includes('perpetual') || c.includes('derivative') || c.includes('options'), text: 'Make one qualifying action each week: open or close one small position, or adjust the margin.' },
  { test: (c) => c.includes('prediction'), text: 'Make one qualifying action each week: place or settle one market position.' },
  { test: (c) => c.includes('risk curator') || c.includes('curator') || c.includes('allocator'), text: 'Make one qualifying action each week: add to the vault, move between vaults, or vote on an allocation.' },
];

/** The category's weekly qualifying action. */
function weeklyAction(p: SnapshotProtocol): string {
  const lowered = (p.category ?? '').toLowerCase();
  for (const move of WEEKLY_MOVES) {
    if (move.test(lowered)) return move.text;
  }
  return 'Make one qualifying action each week, such as a deposit, a swap, a claim or a vote.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list.
 */
export function farmSteps(proto: SnapshotProtocol, ageVal: number | null): FarmStep[] {
  const chain = primaryChain(proto);
  const capital = capitalTier(proto);
  const hold = holdSpan(ageVal);
  const gas = gasQuote(chain);
  const opening = openingAction(proto, capital, chain);
  const step = (text: string, cost: string, time: string): FarmStep => ({ text, cost, time });
  const plan = [
    step(`Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, `under $${gas.setup} of gas for the first transaction on ${chain}`, '5 minutes'),
    step(opening, `$${capital} of capital and about $${gas.setup} of gas`, '15 minutes to set up'),
    step(weeklyAction(proto), `about $${gas.weekly} of gas a week`, '10 minutes a week'),
    step(`Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, `the $${capital} stays in the position`, `${hold} days`),
    step(`Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, 'no fee to check, and never pay to claim', '10 minutes'),
    step(`Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, 'nothing but the log', '5 minutes'),
  ];
  return plan;
}

/** The live-token protocols for the dashboard's Live token view, by market cap. */
export function liveRows(snap: Snapshot): LiveRow[] {
  const traded = snap.protocols.filter((proto) => !isPreToken(proto) && proto.category !== 'CEX');
  traded.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return traded.slice(0, LIVE_ROWS).map((proto) => ({
    slug: proto.slug,
    name: proto.name,
    category: proto.category,
    chains: proto.chains,
    tvl_usd: proto.tvl_usd,
    mcap_usd: proto.mcap_usd,
    change_7d: proto.change_7d,
  }));
}

/** A board row's compact form for data.js. */
export function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    age_days: r.age_days,
    watchlist: r.watchlist,
    implied_value_usd: r.implied_value_usd,
    category_multiple: r.model.category_multiple,
    multiple_source: r.model.multiple_source,
    peers: r.model.peers,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    farm_steps: r.farm_steps,
  };
}

/** The dashboard's whole dataset, from the snapshot. */
export function buildRadar(snap: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, comps } = buildBoard(snap, model);
  const live = liveRows(snap);
  const earlyCount = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snap.as_of, source: snap.source,
    floor_usd: snap.floor_usd,
    model, model_version: MODEL_VERSION,
    watchlist_size: snap.watchlist.length, board_size: board.length,
    early_size: earlyCount, live_size: live.length,
    comps,
    rows: board.map(radarRow), live,
  };
  return { board: board, radar: radar };
}

/** A file's text as JSON, refused when it is not JSON. */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
}

/** Parse the snapshot file's text into the shape the model scores. */
export function parseSnapshot(input: string): Snapshot {
  const parsed: unknown = readJson(input);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SnapshotError('snapshot.json is not a JSON object');
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = doc.protocols.map((entry, position) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotError(`snapshot.json's protocol ${position} is not an object`);
    const fields = entry as Record<string, unknown>;
    if (typeof fields.slug !== 'string' || typeof fields.name !== 'string' || typeof fields.tvl_usd !== 'number' || !Number.isFinite(fields.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${position} lacks a slug, a name or a TVL`);
    }
    return { slug: fields.slug,
      name: fields.name,
      category: typeof fields.category === 'string' ? fields.category : null,
      chains: Array.isArray(fields.chains) ? fields.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: fields.tvl_usd,
      change_7d: typeof fields.change_7d === 'number' && Number.isFinite(fields.change_7d) ? fields.change_7d : null,
      mcap_usd: typeof fields.mcap_usd === 'number' && Number.isFinite(fields.mcap_usd) ? fields.mcap_usd : null,
      listed_at: typeof fields.listed_at === 'string' ? fields.listed_at : null,
      gecko_id: typeof fields.gecko_id === 'string' ? fields.gecko_id : null,
      symbol: typeof fields.symbol === 'string' ? fields.symbol : null,
    };
  });
  return { as_of: doc.as_of, source: doc.source,
    floor_usd: doc.floor_usd,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** The reason a board fails the gate, or null: coverage, ranks, order, a single shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  const noIssue: string | null = null;
  const present = new Set(board.map((r) => r.slug));
  const absent = snap.watchlist.filter((s) => !present.has(s));
  if (absent.length > 0) return `the board misses ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  const orderedRanks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let position = 0; position < orderedRanks.length; position++) {
    if (orderedRanks[position] !== position + 1) return `rank ${position + 1} is ${orderedRanks[position]}`;
  }
  for (let position = 1; position < board.length; position++) {
    if (board[position]!.implied_value_usd > board[position - 1]!.implied_value_usd) return `row ${position + 1} outranks row ${position} on implied value`;
  }
  const firstValue = board[0]!.implied_value_usd;
  const lastValue = board[board.length - 1]!.implied_value_usd;
  if (board.length >= 2 && firstValue === lastValue) {
    return `all ${board.length} rows share the same implied value $${firstValue}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${row.slug} has a farm step of ${trimmed.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return noIssue;
}

/** data.js, compact: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(payload: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(payload) + ';\n';
}
