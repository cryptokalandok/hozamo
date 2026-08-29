import { createHmac } from 'node:crypto';
import {
  HozamoApiError,
  HozamoConfigError,
  HozamoValidationError,
} from '../errors.js';
import {
  normalizeAsset,
  normalizeBalancesPayload,
  normalizeMarket,
  normalizePositiveDecimal,
  splitPair,
} from '../normalizers.js';
import {
  normalizeAssetTransferStatus,
} from '../status.js';
import { normalizeCoinExActivity } from '../statistics.js';

export const DEFAULT_COINEX_BASE_URL = 'https://api.coinex.com/v2';

export function normalizeCoinExMarket(pair) {
  return normalizeMarket(pair).toUpperCase();
}

export function createCoinExSignature({
  method,
  requestPath,
  body = '',
  timestamp,
  apiSecret,
}) {
  const prepared = `${method.toUpperCase()}${requestPath}${body}${timestamp}`;
  return createHmac('sha256', Buffer.from(apiSecret, 'latin1'))
    .update(Buffer.from(prepared, 'latin1'))
    .digest('hex');
}

export class CoinExClient {
  exchange = 'coinex';
  displayName = 'CoinEx';

  #apiKey;
  #apiSecret;
  #baseUrl;
  #fetch;
  #timeoutMs;
  #windowTimeMs;
  #nextTimestamp;

  constructor({
    apiKey,
    apiSecret,
    baseUrl = DEFAULT_COINEX_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    windowTimeMs = 5_000,
    now = Date.now,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new HozamoConfigError(
        'A fetch implementation is required (Node.js 20 or newer is recommended)',
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new HozamoConfigError('timeoutMs must be a positive integer');
    }
    if (!Number.isInteger(windowTimeMs) || windowTimeMs <= 0) {
      throw new HozamoConfigError('windowTimeMs must be a positive integer');
    }

    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#windowTimeMs = windowTimeMs;
    this.#nextTimestamp = createMonotonicTimestamp(now);
  }

  async getMarkets({ pairs, signal } = {}) {
    const values = pairs === undefined
      ? undefined
      : (Array.isArray(pairs) ? pairs : String(pairs).split(','))
        .map(normalizeCoinExMarket)
        .join(',');
    const payload = await this.#request('/spot/market', {
      query: { market: values },
      signal,
    });
    return payload.data;
  }

  async getMarketInfo(pair, options = {}) {
    const market = normalizeCoinExMarket(pair);
    const markets = await this.getMarkets({
      pairs: [pair],
      signal: options.signal,
    });
    const raw = markets?.find?.((item) => item.market === market);

    if (!raw) {
      throw new HozamoApiError(
        `CoinEx returned no market metadata for ${pair}`,
        {
          exchange: 'coinex',
          response: markets,
          code: 'MARKET_NOT_FOUND',
        },
      );
    }

    return {
      pair,
      market,
      basePrecision: normalizePrecision(
        raw.base_ccy_precision,
        'CoinEx base_ccy_precision',
      ),
      quotePrecision: normalizePrecision(
        raw.quote_ccy_precision,
        'CoinEx quote_ccy_precision',
      ),
      minAmount: optionalPositiveDecimal(raw.min_amount, 'CoinEx min_amount'),
      marketBuyAmountAsset: 'quote',
      raw,
    };
  }

  async getDepositWithdrawalConfig(coin, options = {}) {
    const asset = normalizeAsset(coin);
    const payload = await this.#request('/assets/deposit-withdraw-config', {
      auth: true,
      query: { ccy: asset },
      signal: options.signal,
    });

    if (!payload.data?.asset) {
      throw new HozamoApiError(
        `CoinEx returned no deposit/withdrawal status for ${asset}`,
        {
          exchange: 'coinex',
          response: payload,
          code: 'CURRENCY_NOT_FOUND',
        },
      );
    }

    return normalizeAssetTransferStatus(asset, {
      ...payload.data.asset,
      chains: payload.data.chains,
    });
  }

  async getAssetStatuses(coins, options = {}) {
    if (coins === undefined) {
      throw new HozamoValidationError('coins is required');
    }
    return Promise.all(normalizeCoinList(coins).map((asset) => (
      this.getDepositWithdrawalConfig(asset, { signal: options.signal })
    )));
  }

  async getTicker(pair, options = {}) {
    const market = normalizeCoinExMarket(pair);
    const payload = await this.#request('/spot/ticker', {
      query: { market },
      signal: options.signal,
    });
    const ticker = payload.data?.find?.((item) => item.market === market);

    if (!ticker) {
      throw new HozamoApiError(`CoinEx returned no ticker for ${market}`, {
        exchange: 'coinex',
        response: payload,
        code: 'TICKER_NOT_FOUND',
      });
    }

    return ticker;
  }

  async getPrice(pair, options = {}) {
    const ticker = await this.getTicker(pair, options);
    if (ticker.last === undefined || ticker.last === null) {
      throw new HozamoApiError('CoinEx ticker response has no last price', {
        exchange: 'coinex',
        response: ticker,
        code: 'INVALID_TICKER_RESPONSE',
      });
    }
    return {
      pair,
      market: normalizeCoinExMarket(pair),
      price: String(ticker.last),
      ticker,
    };
  }

  async getBalances({ coins, signal } = {}) {
    const payload = await this.#request('/assets/spot/balance', {
      auth: true,
      signal,
    });
    const balances = normalizeBalancesPayload(
      payload.data.map((balance) => ({
        currency: balance.ccy,
        available: balance.available,
        locked: balance.frozen,
        raw: balance,
      })),
    ).map((balance, index) => Object.freeze({
      ...balance,
      raw: payload.data[index],
    }));

    if (coins === undefined) {
      return balances;
    }

    const requested = new Set(normalizeCoinList(coins));
    return balances.filter(({ asset }) => requested.has(asset));
  }

  async getBalance(coin, options = {}) {
    const asset = normalizeAsset(coin);
    const balances = await this.getBalances({
      coins: [asset],
      signal: options.signal,
    });
    return balances.find((balance) => balance.asset === asset) ?? null;
  }

  async getAssetActivity({ coin, startTime, endTime, signal } = {}) {
    const asset = normalizeAsset(coin);
    const range = normalizeHistoryRange(startTime, endTime);
    const deposits = await collectCoinExPages((page, limit) => this.#request(
      '/assets/deposit-history',
      {
        auth: true,
        query: { ccy: asset, page, limit },
        signal,
      },
    ));
    const withdrawals = await collectCoinExPages((page, limit) => this.#request(
      '/assets/withdraw',
      {
        auth: true,
        query: { ccy: asset, page, limit },
        signal,
      },
    ));
    const markets = await this.getMarkets({ signal });
    const matchingMarkets = markets.filter((market) => (
      coinExMarketIncludesAsset(market, asset)
    ));
    const deals = [];

    for (const market of matchingMarkets) {
      const marketDeals = await collectCoinExPages((page, limit) => this.#request(
        '/spot/user-deals',
        {
          auth: true,
          query: {
            market: market.market,
            market_type: 'SPOT',
            start_time: range.startTime,
            end_time: range.endTime - 1,
            page,
            limit,
          },
          signal,
        },
      ));
      deals.push(...marketDeals);
    }

    return normalizeCoinExActivity({
      coin: asset,
      deposits,
      withdrawals,
      deals,
      markets: matchingMarkets,
    });
  }

  async getOrders({ pair, side, signal } = {}) {
    const payload = await this.#request('/spot/pending-order', {
      auth: true,
      query: {
        market: pair === undefined ? undefined : normalizeCoinExMarket(pair),
        market_type: 'SPOT',
        side: side === undefined ? undefined : normalizeChoice(
          side,
          'side',
          ['buy', 'sell'],
        ),
      },
      signal,
    });
    return payload.data;
  }

  async createOrder({
    pair,
    side,
    type,
    amount,
    amountAsset,
    price,
    clientId,
    signal,
  }) {
    const market = normalizeCoinExMarket(pair);
    const normalizedSide = normalizeChoice(side, 'side', ['buy', 'sell']);
    const normalizedType = normalizeChoice(type, 'type', ['market', 'limit']);
    const normalizedAmount = normalizePositiveDecimal(amount, 'amount');
    const { base, quote } = splitPair(pair);
    const normalizedAmountAsset = normalizeAsset(amountAsset ?? base);

    if (![base, quote].includes(normalizedAmountAsset)) {
      throw new HozamoValidationError(
        `amountAsset must be ${base} or ${quote}`,
      );
    }
    if (normalizedType === 'limit' && normalizedAmountAsset !== base) {
      throw new HozamoValidationError(
        `CoinEx limit-order amount must be denominated in ${base}`,
      );
    }

    if (normalizedType === 'limit' && price === undefined) {
      throw new HozamoValidationError('price is required for a limit order');
    }
    if (normalizedType === 'market' && price !== undefined) {
      throw new HozamoValidationError(
        'price must not be provided for a market order',
      );
    }
    if (
      clientId !== undefined &&
      (!/^[A-Za-z0-9_-]+$/.test(clientId) || Buffer.byteLength(clientId) > 32)
    ) {
      throw new HozamoValidationError(
        'clientId may contain letters, numbers, hyphens and underscores up to 32 bytes',
      );
    }

    const body = {
      market,
      market_type: 'SPOT',
      side: normalizedSide,
      type: normalizedType,
      amount: normalizedAmount,
    };

    if (normalizedType === 'market') {
      body.ccy = normalizedAmountAsset;
    } else {
      body.price = normalizePositiveDecimal(price, 'price');
    }
    if (clientId !== undefined) {
      body.client_id = clientId;
    }

    const payload = await this.#request('/spot/order', {
      method: 'POST',
      auth: true,
      body,
      signal,
    });
    return payload.data;
  }

  async #request(path, {
    method = 'GET',
    query,
    body,
    auth = false,
    signal,
  } = {}) {
    const url = new URL(path.replace(/^\//, ''), `${this.#baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth) {
      Object.assign(
        headers,
        this.#authenticationHeaders(method, url, bodyText),
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), this.#timeoutMs);
    const abortFromCaller = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        abortFromCaller();
      } else {
        signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : bodyText,
        signal: controller.signal,
      });
      const payload = await parseResponse(response);

      if (!response.ok) {
        throw new HozamoApiError(
          `CoinEx gateway returned HTTP ${response.status}${errorDetail(payload)}`,
          {
            exchange: 'coinex',
            status: response.status,
            method,
            url: url.toString(),
            response: payload,
            code: 'HTTP_ERROR',
          },
        );
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HozamoApiError('CoinEx returned an invalid response', {
          exchange: 'coinex',
          status: response.status,
          method,
          url: url.toString(),
          response: payload,
          code: 'INVALID_RESPONSE',
        });
      }
      if (Number(payload.code) !== 0) {
        throw new HozamoApiError(
          `CoinEx API error ${payload.code}: ${payload.message || 'Unknown error'}`,
          {
            exchange: 'coinex',
            status: response.status,
            method,
            url: url.toString(),
            response: payload,
            code: 'COINEX_API_ERROR',
            apiCode: payload.code,
          },
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof HozamoApiError) {
        throw error;
      }
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'timeout';
        throw new HozamoApiError(
          timedOut ? 'CoinEx request timed out' : 'CoinEx request was aborted',
          {
            exchange: 'coinex',
            method,
            url: url.toString(),
            code: timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED',
            cause: error,
          },
        );
      }
      throw new HozamoApiError('CoinEx request failed', {
        exchange: 'coinex',
        method,
        url: url.toString(),
        code: 'NETWORK_ERROR',
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  #authenticationHeaders(method, url, bodyText) {
    if (!this.#apiKey || !this.#apiSecret) {
      throw new HozamoConfigError(
        'COINEX_API_KEY and COINEX_API_SECRET are required for private CoinEx endpoints',
      );
    }
    const timestamp = this.#nextTimestamp();
    const requestPath = `${url.pathname}${url.search}`;
    return {
      'X-COINEX-KEY': this.#apiKey,
      'X-COINEX-SIGN': createCoinExSignature({
        method,
        requestPath,
        body: bodyText,
        timestamp,
        apiSecret: this.#apiSecret,
      }),
      'X-COINEX-TIMESTAMP': timestamp,
      'X-COINEX-WINDOWTIME': String(this.#windowTimeMs),
    };
  }
}

function createMonotonicTimestamp(now) {
  let previous = 0n;
  return () => {
    const current = BigInt(now());
    previous = current > previous ? current : previous + 1n;
    return previous.toString();
  };
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new HozamoConfigError('baseUrl must be a non-empty URL');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new HozamoConfigError('baseUrl must be a valid URL', { cause });
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeChoice(value, name, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new HozamoValidationError(
      `${name} must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function normalizePrecision(value, name) {
  const precision = Number(value);
  if (!Number.isInteger(precision) || precision < 0 || precision > 100) {
    throw new HozamoApiError(`${name} is missing or invalid`, {
      exchange: 'coinex',
      response: value,
      code: 'INVALID_MARKET_METADATA',
    });
  }
  return precision;
}

function optionalPositiveDecimal(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  try {
    return normalizePositiveDecimal(value, name);
  } catch (cause) {
    throw new HozamoApiError(`${name} is invalid`, {
      exchange: 'coinex',
      response: value,
      code: 'INVALID_MARKET_METADATA',
      cause,
    });
  }
}

function normalizeCoinList(coins) {
  const values = Array.isArray(coins) ? coins : String(coins).split(',');
  return values.map(normalizeAsset);
}

function normalizeHistoryRange(startTime, endTime) {
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime >= endTime
  ) {
    throw new HozamoValidationError(
      'startTime and endTime must define a valid history period',
    );
  }
  return { startTime: Math.trunc(startTime), endTime: Math.trunc(endTime) };
}

async function collectCoinExPages(fetchPage) {
  const result = [];
  const limit = 100;
  for (let page = 1; ; page += 1) {
    const payload = await fetchPage(page, limit);
    const items = Array.isArray(payload?.data) ? payload.data : [];
    result.push(...items);
    const hasNext = payload?.pagination?.has_next;
    if (hasNext !== true && (hasNext === false || items.length < limit)) {
      return result;
    }
  }
}

function coinExMarketIncludesAsset(market, asset) {
  try {
    return [market?.base_ccy, market?.quote_ccy]
      .some((value) => value !== undefined && normalizeAsset(String(value)) === asset);
  } catch {
    return false;
  }
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorDetail(payload) {
  const detail = typeof payload === 'string'
    ? payload
    : payload?.message ?? payload?.error;
  return detail ? `: ${String(detail).slice(0, 500)}` : '';
}
