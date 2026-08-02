// Builds the static stock price feed that MySchmeckles reads.
//
// Runs on a schedule (see .github/workflows/prices.yml), NOT in the app. That
// is the whole point: this process absorbs whatever network quirks and rate
// limits exist, and the app just downloads a finished JSON file. No API key,
// no signup, no per-user setup — the app is for people who are not
// financially or technically savvy, so "go register for an API key" was never
// an acceptable step.
//
// It runs server-side, where the browser's CORS rules don't apply — which is
// why it can use a keyless source the app itself could never call directly.
//
// Usage: node build.mjs

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIVERSE = join(HERE, "universe.txt");
const OUT = join(HERE, "stocks.json");

// Politeness settings. Nobody is waiting on this job, so it runs slowly on
// purpose rather than hammering a free endpoint.
const CONCURRENCY = 4;
const RETRIES = 3;
const RETRY_BASE_MS = 1500;
const TIMEOUT_MS = 15000;

// If more than this share of the universe fails, something is broken upstream
// and we must NOT publish — a gutted file would blank out real holdings.
const MIN_SUCCESS_RATE = 0.8;

const UA = "Mozilla/5.0 (compatible; MySchmecklesPriceFeed/1.0)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUniverse() {
  const raw = await readFile(UNIVERSE, "utf8");
  const tickers = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.toUpperCase());
  return [...new Set(tickers)];
}

// Previous run's output, used to carry a symbol through a transient failure
// instead of dropping it out of the feed entirely.
async function readPrevious() {
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    const map = new Map();
    for (const s of prev.stocks ?? []) map.set(s.s, s);
    return map;
  } catch {
    return new Map();
  }
}

async function fetchQuote(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1d&interval=1d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number" || !(price > 0)) throw new Error("no price in response");
    if (meta.currency !== "USD") throw new Error(`unexpected currency ${meta.currency}`);
    return { s: symbol, n: meta.longName || meta.shortName || symbol, p: Number(price.toFixed(4)) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(symbol) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fetchQuote(symbol);
    } catch (err) {
      if (attempt === RETRIES) {
        console.warn(`  ! ${symbol}: ${err.message}`);
        return null;
      }
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
  return null;
}

async function main() {
  const tickers = await readUniverse();
  const previous = await readPrevious();
  console.log(`Fetching ${tickers.length} symbols (concurrency ${CONCURRENCY})…`);

  const results = [];
  let fresh = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < tickers.length) {
      const symbol = tickers[cursor++];
      const quote = await fetchWithRetry(symbol);
      if (quote) {
        results.push(quote);
        fresh++;
      } else if (previous.has(symbol)) {
        // Keep yesterday's number rather than dropping the symbol.
        results.push(previous.get(symbol));
      }
      await sleep(120);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const rate = fresh / tickers.length;
  console.log(`Fresh quotes: ${fresh}/${tickers.length} (${(rate * 100).toFixed(1)}%)`);
  if (rate < MIN_SUCCESS_RATE) {
    console.error(
      `Success rate below ${MIN_SUCCESS_RATE * 100}% — refusing to publish. ` +
        `Leaving the existing feed in place.`
    );
    process.exit(1);
  }

  results.sort((a, b) => a.s.localeCompare(b.s));
  const payload = {
    generated: new Date().toISOString(),
    currency: "USD",
    count: results.length,
    stocks: results,
  };

  await writeFile(OUT, JSON.stringify(payload) + "\n", "utf8");
  console.log(`Wrote ${OUT} (${results.length} symbols)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
