# Hozamo

Hozamo is a multi-exchange spot trading CLI and reusable Node.js library.
It currently supports SafeTrade and CoinEx. The same client/service layer can
later be called from an AWS Lambda handler.

> **Setting up Hozamo?** Follow the
> [environment setup guide](docs/environment.md) for step-by-step HiveOS/Linux
> and Windows instructions, API credential configuration and scheduled-run
> working-directory requirements.

> [!WARNING]
>
> Hozamo is beta software and can submit real cryptocurrency exchange orders.
> Always use a dedicated API key with only the permissions Hozamo requires, and **explicitly disable withdrawal permission**. Withdrawal access is not required for any Hozamo functionality.
>
> Test every strategy with `--dryrun` and start with the smallest order permitted by the exchange.
>
> Most importantly: **NEVER share your API key or secret with anyone.** Treat them like account credentials. A compromised API key may allow an unauthorized person to place harmful trades, and unnecessary permissions could put the assets stored in your account at even greater risk.

## Requirements

- Node.js 20 or newer
- An API key for balances and orders on the selected exchange
- `npm install` to install the pinned HTTP client used for optional proxying

Public price requests do not require an API key. CoinEx status requests use its
authenticated deposit/withdrawal configuration endpoint.

## Run the CLI

Install dependencies once, then run the CLI:

```bash
npm install
node hozamo --help
node hozamo price --exchange coinex --pair BTC-USDT
```

To make `hozamo` available as a command while developing locally:

```bash
npm link
hozamo --help
```

Alternatively, every command can be run through npm:

```bash
npm run hozamo -- price --exchange coinex --pair BTC-USDT
```

Running `node hozamo` without a command prints the help screen.

## Configuration

Copy the example and insert dedicated, trading-only API credentials for the
exchange you want to use:

```bash
cp .env.example .env
```

```dotenv
HOZAMO_EXCHANGE=coinex
HOZAMO_DNS_RESULT_ORDER=ipv4first
# Leave empty for direct connections, or set one global proxy:
# HOZAMO_PROXY_URL=https://username:password@proxy.example.com:8443
# Optional SafeTrade pool address book used by --deposits-by-source:
# HOZAMO_DEPOSIT_SOURCES='{"My Pool":"prl1..."}'

COINEX_API_KEY=your-access-id
COINEX_API_SECRET=your-secret-key

SAFETRADE_API_KEY=your-api-key
SAFETRADE_API_SECRET=your-api-secret
```

Exchange selection uses this precedence:

1. the command's `--exchange safetrade|coinex` option;
2. `HOZAMO_EXCHANGE` from the environment or `.env`;
3. `safetrade` for backward compatibility.

The CLI loads `.env` itself; no `dotenv` package is needed. Existing shell
environment variables override values from the file.

`HOZAMO_DNS_RESULT_ORDER` controls DNS address ordering for every exchange,
not only SafeTrade. It defaults to `ipv4first`, which prefers IPv4 without
disabling IPv6 fallback. Use `ipv6first` to prefer IPv6 or `verbatim` to retain
the address order returned by the operating system's resolver.

`HOZAMO_PROXY_URL` is optional. When it is missing or empty, Hozamo
connects directly. When it is set, **all public and private API requests for
every exchange** use that HTTP(S) forward proxy. This includes prices, market
metadata, status, balances and order submission. Supported formats are:

```dotenv
HOZAMO_PROXY_URL=http://proxy.example.com:3128
HOZAMO_PROXY_URL=https://username:password@proxy.example.com:8443
```

Prefer an `https://` proxy when credentials cross the public internet. URL
encode special characters in the username or password. Proxy configuration is
global by design; it is not limited to SafeTrade.

Optional variables:

```dotenv
HOZAMO_BUY_RESERVE_PERCENT=0.5
HOZAMO_TIMEOUT_MS=15000
SAFETRADE_BASE_URL=https://safe.trade/api/v2
COINEX_BASE_URL=https://api.coinex.com/v2
COINEX_WINDOW_TIME_MS=5000
```

`SAFETRADE_TIMEOUT_MS` and `COINEX_TIMEOUT_MS` can be used instead of the shared
timeout. Do not pass secrets as command-line flags: they can appear in shell
history and process listings.

## Commands

The following examples select CoinEx explicitly. You can omit
`--exchange coinex` after setting `HOZAMO_EXCHANGE=coinex`.

### Price

```bash
node hozamo price --exchange coinex --pair BTC-USDT
```

The displayed price is the ticker's **last traded price**.

### Asset and deposit status

```bash
node hozamo status --exchange coinex --coin PEARL,USDT
node hozamo status --exchange safetrade --coin BTC,USDT
```

Deposit and withdrawal availability belongs to an asset and, on some
exchanges, to a specific blockchain network rather than to a trading pair.
`--coin` accepts one asset or a comma-separated list. The command prints:

- aggregate deposit and withdrawal availability for every requested asset;
- network-specific rows when the exchange returns them.

`ENABLED` and `DISABLED` are direct normalized API values. `UNKNOWN` means the
exchange omitted the relevant field; Hozamo does not guess. CoinEx status
requests require `COINEX_API_KEY` and `COINEX_API_SECRET`. SafeTrade's currency
and market status requests are public, but may still be affected by its
Cloudflare block.

### Balances

```bash
node hozamo balance --exchange coinex --coin QUAI,RVN
```

Output contains total, available and locked amounts. CoinEx's `frozen` balance
is exposed as `locked`, and `total` is calculated exactly as
`available + locked`. A requested asset missing from the API response is
displayed as zero.

### Asset statistics

Show the current UTC day and the preceding 29 UTC days:

```bash
node hozamo stats \
  --exchange coinex \
  --coin PEARL \
  --days 30
```

Or select an inclusive UTC date range and write CSV to a file:

```bash
node hozamo stats \
  --exchange safetrade \
  --coin PEARL \
  --from 2026-08-01 \
  --to 2026-08-31 \
  --format csv > pearl-2026-08.csv
```

The default output is an aligned table. CSV output contains no explanatory
text, so it can be redirected directly to a `.csv` file. In both formats the
first data row is `SUM`, followed by one row for every UTC date in the selected
period, including dates with no activity. Add `--hide-zero-days` to keep the
`SUM` row but omit dates where every reported value is zero. This option works
with both table and CSV output.

The report contains:

- credited deposits of the requested asset;
- successful withdrawals of the requested asset;
- completed spot executions that spend the requested asset;
- one gross `RECEIVED ...` column for every asset received by those swaps.

A swap can spend the requested asset either by selling it as the base asset or
by using it as the quote asset to buy another coin. Acquisitions of the
requested asset are not counted as outgoing swaps. Received values are kept in
their original assets instead of combining unlike units such as BTC and USDT.
They are gross execution values; trading fees are not deducted.

SafeTrade deposits can also be split into source columns:

```bash
node hozamo stats \
  --exchange safetrade \
  --coin PRL \
  --days 30 \
  --deposits-by-source
```

The total `DEPOSITED PRL` column remains in the report and is followed by one
`FROM ...` column for every source found in the selected period. Hozamo knows
the Kryptex, PearlHash and HeroMiners PRL payout addresses by default. An
unrecognized address is displayed using its first and last seven characters,
for example `prl1abc..3456789`. A deposit without an address is grouped under
`UNKNOWN`.

Additional pools can be configured in `.env` as a JSON object whose keys are
display names and whose values are either one address or an array of addresses:

```dotenv
HOZAMO_DEPOSIT_SOURCES='{"LuckyPool":"prl1...","My Pool":["prl1...","prl1..."]}'
```

Multiple addresses with the same name are combined into one column. A custom
entry can also rename a built-in address. The option is intentionally limited
to SafeTrade: CoinEx's authenticated deposit API exposes only the receiving
`to_address`, not the source address, so CoinEx rejects
`--deposits-by-source` with an explanatory error.

SafeTrade's transfer date filters apply to record updates rather than the
original transfer date. CoinEx does not provide transfer date filters. Hozamo
therefore paginates deposit and withdrawal histories on both exchanges and
applies the requested UTC period locally. Execution histories use each
exchange's server-side date filters.

### Market order

```bash
node hozamo order \
  --exchange coinex \
  --type market \
  --side sell \
  --pair BTC-USDT \
  --amount 0.001
```

`--amount` always means the base-asset amount: in `BTC-USDT`, `--amount 0.001`
means 0.001 BTC for both buys and sells. Hozamo explicitly sends this
denomination to CoinEx for market orders.

Every order requires exactly one sizing option: an exact base `--amount`, an
available `--balance-percent`, or a target sell `--receive` amount. They cannot
be used together.

Before a sell, Hozamo checks the base asset's available balance. It then
shows an order summary and asks for confirmation. Use `--yes` only for an
intentional non-interactive submission.

The original `--order sell` spelling is accepted as a compatibility alias, but
`--side sell` is the preferred terminology.

### Order from an available-balance percentage

Sell all available base asset:

```bash
node hozamo order \
  --exchange safetrade \
  --type market \
  --side sell \
  --pair BTC-USDT \
  --balance-percent 100
```

Use the available quote balance for a buy:

```bash
node hozamo order \
  --exchange safetrade \
  --type market \
  --side buy \
  --pair BTC-USDT \
  --balance-percent 100 \
  --dryrun
```

`--balance-percent` accepts a value greater than zero and at most 100. Its
meaning follows the order side:

| Side | Balance used |
| --- | --- |
| `sell` | Available base asset, such as BTC in `BTC-USDT` |
| `buy` | Available quote asset, such as USDT in `BTC-USDT` |

Buy orders keep 0.5% of the selected quote allocation by default as a visible
safety reserve for fees, rounding and market movement. Override it per command
with `--reserve-percent`, or set `HOZAMO_BUY_RESERVE_PERCENT` in `.env`.
Use `--reserve-percent 0` only when you intentionally want Hozamo to attempt
using the complete selected quote allocation.

The CLI fetches the market's amount and price precision before calculating an
order, then rounds the result down so it cannot exceed the selected budget. A
calculated base amount below the exchange's advertised minimum is rejected
locally. The confirmation summary shows the available balance, allocation,
reserve, final budget and calculated order amount.

For CoinEx market buys, Hozamo sends the calculated budget in the quote
asset directly. SafeTrade market buys and all limit buys are converted to a
base-asset amount using the last traded or selected limit price.

### Sell for target quote proceeds

To sell enough of the base asset for approximately 100 USDT of gross proceeds:

```bash
node hozamo order \
  --exchange coinex \
  --type market \
  --side sell \
  --pair BTC-USDT \
  --receive 100
```

`--receive` is available only for sell orders and denotes the pair's quote
asset. For `BTC-USDT`, `--receive 100` therefore targets 100 USDT. Hozamo
fetches the market's base-amount precision and calculates how much BTC must be
sold. The amount is rounded **up** to that precision so the estimated gross
proceeds do not fall below the target solely because of amount rounding.

For a market order, the calculation uses the last traded price. The actual
execution price may differ because the market can move and the order can fill
at multiple prices. For a limit order, the calculation uses `--price` or the
price produced by `--price-percent`:

```bash
node hozamo order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair BTC-USDT \
  --receive 100 \
  --price 60000
```

The target and displayed estimate are **gross** values. Trading fees are not
included, and market-order slippage cannot be known before execution. Therefore
`--receive 100` cannot guarantee that exactly 100 USDT will be credited after
fees. Hozamo prints the reference price, calculated base amount and estimated
gross proceeds before confirmation, and rejects the order if the available base
balance is insufficient.

### Limit order with an exact price

```bash
node hozamo order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair BTC-USDT \
  --amount 0.001 \
  --price 60000
```

Hungarian decimal commas are accepted for individual numeric arguments and
normalized to decimal points.

### Limit order relative to the current price

```bash
node hozamo order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair BTC-USDT \
  --amount 0.001 \
  --price-percent 10
```

This uses the last traded price and places the limit price 10% higher. The
calculation uses exact decimal arithmetic and rounds to the number of decimal
places present in the ticker response. `--price` and `--price-percent` are
mutually exclusive.

### Dryrun

```bash
node hozamo order \
  --exchange coinex \
  --type limit \
  --side sell \
  --pair BTC-USDT \
  --amount 0.001 \
  --price 60000 \
  --dryrun
```

A dryrun performs the required private, read-only balance call and all local
validations, including balance-percentage sizing and market-precision lookup,
but never submits an order. It therefore still needs API credentials.

For buy orders, Hozamo estimates the required quote balance from the limit
price or last traded price. The estimate excludes fees and market-order
slippage; the selected exchange remains the final authority when accepting an
order.

## Tests: what they do and do not prove

```bash
npm test
```

The test suite uses Node's built-in test runner. Tests inject fake `fetch`
functions or fake clients and verify:

- SafeTrade and CoinEx HMAC-SHA256 signatures and monotonic timestamps;
- exact URLs, authentication headers and JSON order bodies;
- exchange selection through the CLI and factory;
- asset/network deposit and withdrawal status normalization;
- the global IPv4-first default and DNS result-order override;
- optional global proxy routing for SafeTrade and CoinEx requests;
- market/limit validation and mutually exclusive price options;
- balance normalization and insufficient-balance rejection;
- exact decimal and percentage calculations without floating-point rounding;
- balance-percentage allocation, buy reserve and downward amount rounding;
- target quote proceeds and upward base-amount rounding for sell orders;
- CLI parsing, help, human-readable output, confirmation and dryrun behavior;
- concise handling of SafeTrade/Cloudflare HTTP 403 pages;
- structured SafeTrade and CoinEx API errors.

For a fast syntax-only check, run:

```bash
npm run check
```

This uses Node's `--check` mode to parse the CLI and source files. No output
means the syntax is valid. It does not execute the code, call an exchange,
perform type checking or replace `npm test`.

They deliberately do **not** contact either exchange or create a real order.
This is why they can pass even when a live API is unavailable. Use one of these
public, read-only smoke tests to check network access:

```bash
npm run smoke:coinex
npm run smoke:safetrade
```

## SafeTrade/Cloudflare HTTP 403

SafeTrade's Cloudflare configuration may block a legitimate API request before
it reaches the exchange. This affects even public ticker requests and has also
been reported against SafeTrade's official example client. Hozamo recognizes
this response and prints a short actionable error instead of the full HTML
page.

This is not an API-key or Node.js error. Try the public SafeTrade smoke test
from another normal network and contact SafeTrade support with the displayed
Cloudflare Ray ID if the block persists. Before choosing AWS Lambda, ask
SafeTrade whether requests from AWS IP ranges are supported.

Some hosts have both IPv4 and IPv6 connectivity while SafeTrade has allowlisted
only one of their public addresses. Hozamo therefore prefers IPv4 for all
exchange requests by default. To temporarily restore Node's resolver order:

```dotenv
HOZAMO_DNS_RESULT_ORDER=verbatim
```

## Optional HTTPS CONNECT proxy

A standard forward proxy can provide a stable outbound IP address without
receiving exchange API credentials in plaintext. Hozamo sends an HTTP
`CONNECT` request to the proxy and then establishes the exchange's normal TLS
session through that tunnel. The proxy can see the destination hostname,
connection time and transferred byte counts, but not the exchange request
path, headers, API key, signature, body or response.

Hozamo does not install a custom certificate authority and does not disable
TLS certificate verification. A proxy attempting to impersonate an exchange
therefore causes certificate validation to fail instead of silently exposing
credentials.

An authenticated, TLS-protected Squid configuration restricted to the current
SafeTrade and CoinEx API hosts is included in
[`deploy/proxy/squid.conf.example`](deploy/proxy/squid.conf.example). See
[`docs/proxy.md`](docs/proxy.md) for Ubuntu installation, certificate renewal,
IPv4 enforcement and verification steps. Add each future exchange API hostname
to the proxy allowlist when a new integration is introduced.

## Node.js library usage

Use the exchange factory when application configuration chooses the provider:

```js
import {
  configureDnsResultOrder,
  createExchangeClient,
} from './src/index.js';

configureDnsResultOrder(process.env.HOZAMO_DNS_RESULT_ORDER);

const client = createExchangeClient({
  exchange: process.env.HOZAMO_EXCHANGE ?? 'coinex',
  env: process.env,
});

const { price } = await client.getPrice('BTC-USDT');
const status = await client.getAssetStatuses('PEARL,USDT');
const balances = await client.getBalances({ coins: 'BTC,USDT' });

await client.createOrder({
  pair: 'BTC-USDT',
  side: 'sell',
  type: 'market',
  amount: '0.001',
});
```

CoinEx market orders may also explicitly use the quote asset as their amount
denomination:

```js
await client.createOrder({
  pair: 'BTC-USDT',
  side: 'buy',
  type: 'market',
  amount: '100',
  amountAsset: 'USDT',
});
```

`SafeTradeClient` and `CoinExClient` can also be instantiated directly.
`configureDnsResultOrder()` uses the same global IPv4-first default for library
and future Lambda entry points. `createExchangeClient()` reads
`HOZAMO_PROXY_URL` from its `env` object and applies it to either provider.
All financial values stay as decimal strings.

## API mapping

| Capability | SafeTrade | CoinEx |
| --- | --- | --- |
| Markets | `GET /trade/public/markets` | `GET /spot/market` |
| Deposit/withdraw status | `GET /trade/public/currencies` | `GET /assets/deposit-withdraw-config?ccy={asset}` |
| Ticker | `GET /trade/public/tickers/{market}` | `GET /spot/ticker?market={market}` |
| Spot balances | `GET /trade/account/balances/spot` | `GET /assets/spot/balance` |
| Pending orders | `GET /trade/market/orders` | `GET /spot/pending-order` |
| Create order | `POST /trade/market/orders` | `POST /spot/order` |

Default base URLs:

- SafeTrade: `https://safe.trade/api/v2`
- CoinEx: `https://api.coinex.com/v2`

CoinEx private requests sign the exact HTTP method, `/v2` request path including
its query string, optional JSON body, and millisecond timestamp. Authentication
uses `X-COINEX-KEY`, `X-COINEX-SIGN`, `X-COINEX-TIMESTAMP` and
`X-COINEX-WINDOWTIME` headers.

## Security

- Use a dedicated API key with spot-trading permission only; disable withdrawals.
- IP-lock the API key if the selected exchange supports it for your account.
- Keep `.env` out of version control.
- Use a unique proxy account per user and rotate or revoke it independently.
- Never install a proxy CA or disable TLS verification on a Hozamo host.
- For Lambda, use AWS Secrets Manager or encrypted SSM Parameter Store.
- Start with `--dryrun`, then test the smallest permitted real amount.
- A successfully created limit order may remain open or fill only partially.

## Sources

- [CoinEx API v2 introduction](https://docs.coinex.com/api/v2/)
- [CoinEx authentication](https://docs.coinex.com/api/v2/authorization)
- [CoinEx ticker endpoint](https://docs.coinex.com/api/v2/spot/market/http/list-market-ticker)
- [CoinEx spot balance endpoint](https://docs.coinex.com/api/v2/assets/balance/http/get-spot-balance)
- [CoinEx deposit/withdrawal configuration](https://docs.coinex.com/api/v2/assets/deposit-withdrawal/http/get-deposit-withdrawal-config)
- [CoinEx create-order endpoint](https://docs.coinex.com/api/v2/spot/order/http/put-order)
- [SafeTrade API documentation](https://safetrade.com/api)
- [SafeTrade official example client](https://github.com/safetrade-exchange/example-client)
- [Reported SafeTrade Cloudflare block](https://github.com/safetrade-exchange/example-client/issues/1)
- [Undici ProxyAgent documentation](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)
- [Squid HTTPS CONNECT documentation](https://wiki.squid-cache.org/Features/HTTPS)
