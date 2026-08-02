# myschmeckles-prices

The daily stock price feed for **MySchmeckles**, a gamified net-worth tracker.

This repository exists so the app needs **no API key and no setup** from the
people using it. A scheduled job here fetches closing prices once a day and
commits them as a plain JSON file, which the app downloads directly.

## Why a file instead of an API

Every free stock API requires a per-user key, and the keyless ones refuse
cross-origin browser requests — measured from a page origin, Yahoo, Stooq and
Nasdaq all fail CORS. This job runs server-side, where CORS does not apply, so
the awkwardness lives here instead of in the app.

A daily closing price is also the right resolution for the app: it's a
once-a-day check-in with a daily history, and jittery intraday numbers would
work against its deliberately calm tone.

## Files

| File | Purpose |
|---|---|
| `universe.txt` | The tickers to price. One per line; `#` comments ignored. |
| `build.mjs` | Fetches each ticker and writes `stocks.json`. |
| `stocks.json` | The published feed. **This is what the app downloads.** |
| `.github/workflows/prices.yml` | Runs the job at 23:00 UTC daily. |

## The feed format

```json
{
  "generated": "2026-08-02T10:12:28.249Z",
  "currency": "USD",
  "count": 149,
  "stocks": [{ "s": "AAPL", "n": "Apple Inc.", "p": 308.91 }]
}
```

`s` = symbol, `n` = display name, `p` = price in USD. The app uses `n` for
search-by-name, so a ticker in this file is always both findable and priceable.

## Adding a ticker

Append it to `universe.txt`. The next run picks it up.

## Safety rules

The build **refuses to publish** if fewer than 80% of the universe returns a
fresh quote, and carries the previous price forward for any single symbol that
fails. One bad upstream day cannot gut the feed.

## Running it by hand

```bash
node build.mjs
```

Requires Node 20+ (uses built-in `fetch`).
