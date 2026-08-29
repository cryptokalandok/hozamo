import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  CoinExClient,
  HozamoApiError,
  HozamoConfigError,
  createCoinExSignature,
  createExchangeClient,
  normalizeCoinExMarket,
} from '../src/index.js';

const FIXED_TIME = 1_700_490_703_564;

test('CoinEx market normalization uses uppercase concatenated symbols', () => {
  assert.equal(normalizeCoinExMarket('BTC-USDT'), 'BTCUSDT');
  assert.equal(normalizeCoinExMarket('btc/usdt'), 'BTCUSDT');
});

test('CoinEx signature follows METHOD + request_path + body + timestamp', () => {
  const prepared =
    'GET' +
    '/v2/spot/pending-order?market=BTCUSDT&market_type=SPOT&side=buy&page=1&limit=10' +
    String(FIXED_TIME);
  const expected = createHmac('sha256', 'secret')
    .update(prepared)
    .digest('hex');

  assert.equal(createCoinExSignature({
    method: 'GET',
    requestPath: '/v2/spot/pending-order?market=BTCUSDT&market_type=SPOT&side=buy&page=1&limit=10',
    timestamp: String(FIXED_TIME),
    apiSecret: 'secret',
  }), expected);
});

test('CoinEx getPrice uses the public v2 ticker without authentication', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse([
    { market: 'BTCUSDT', last: '60000', open: '59000' },
  ]));

  const result = await client.getPrice('BTC-USDT');

  assert.equal(
    calls[0].url,
    'https://api.coinex.com/v2/spot/ticker?market=BTCUSDT',
  );
  assert.equal(calls[0].options.headers['X-COINEX-KEY'], undefined);
  assert.equal(result.market, 'BTCUSDT');
  assert.equal(result.price, '60000');
});

test('CoinEx getMarketInfo exposes precision and quote market-buy support', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse([{
    market: 'BTCUSDT',
    min_amount: '0.0005',
    base_ccy: 'BTC',
    quote_ccy: 'USDT',
    base_ccy_precision: 8,
    quote_ccy_precision: 2,
  }]));

  const result = await client.getMarketInfo('BTC-USDT');

  assert.equal(
    calls[0].url,
    'https://api.coinex.com/v2/spot/market?market=BTCUSDT',
  );
  assert.equal(result.basePrecision, 8);
  assert.equal(result.quotePrecision, 2);
  assert.equal(result.minAmount, '0.0005');
  assert.equal(result.marketBuyAmountAsset, 'quote');
});

test('CoinEx balances are signed and normalized', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse([
    { ccy: 'QUAI', available: '10.5', frozen: '1.25' },
    { ccy: 'RVN', available: '20', frozen: '0' },
  ]));

  const balances = await client.getBalances({ coins: 'QUAI' });
  const { headers } = calls[0].options;
  const expectedSign = createHmac('sha256', 'secret')
    .update(`GET/v2/assets/spot/balance${FIXED_TIME}`)
    .digest('hex');

  assert.equal(
    calls[0].url,
    'https://api.coinex.com/v2/assets/spot/balance',
  );
  assert.equal(headers['X-COINEX-KEY'], 'key');
  assert.equal(headers['X-COINEX-TIMESTAMP'], String(FIXED_TIME));
  assert.equal(headers['X-COINEX-WINDOWTIME'], '5000');
  assert.equal(headers['X-COINEX-SIGN'], expectedSign);
  assert.deepEqual(
    balances.map(({ asset, total, available, locked }) => ({
      asset, total, available, locked,
    })),
    [{ asset: 'QUAI', total: '11.75', available: '10.5', locked: '1.25' }],
  );
});

test('CoinEx asset status supports multiple coins and chain-level status', async () => {
  const calls = [];
  const client = createClient(calls, (url) => {
    const asset = url.searchParams.get('ccy');
    return coinExResponse({
      asset: {
        ccy: asset,
        deposit_enabled: asset !== 'PEARL',
        withdraw_enabled: true,
      },
      chains: [{
        chain: asset === 'PEARL' ? 'PEARL' : 'TRC20',
        deposit_enabled: asset !== 'PEARL',
        withdraw_enabled: true,
      }],
    });
  });

  const result = await client.getAssetStatuses('PEARL,USDT');
  const configCalls = calls.filter(({ url }) => (
    new URL(url).pathname.endsWith('/assets/deposit-withdraw-config')
  ));

  assert.equal(result[0].asset, 'PEARL');
  assert.equal(result[0].depositEnabled, false);
  assert.equal(result[0].networks[0].network, 'PEARL');
  assert.equal(result[1].depositEnabled, true);
  assert.deepEqual(
    configCalls.map(({ url }) => new URL(url).searchParams.get('ccy')),
    ['PEARL', 'USDT'],
  );
  assert.equal(
    configCalls.every(({ options }) => options.headers['X-COINEX-SIGN']),
    true,
  );
});

test('CoinEx asset activity requests deposits, withdrawals and matching deals', async () => {
  const calls = [];
  const client = createClient(calls, (url) => {
    if (url.pathname.endsWith('/assets/deposit-history')) {
      const page = url.searchParams.get('page');
      return coinExPaginatedResponse(page === '1' ? [
        {
          deposit_id: 1,
          ccy: 'PEARL',
          amount: '10',
          actual_amount: '',
          status: 'finished',
          created_at: Date.parse('2026-08-28T08:00:00Z'),
        },
        {
          deposit_id: 5,
          ccy: 'PEARL',
          amount: '0.1',
          actual_amount: '0.1',
          status: 'finish',
          created_at: Date.parse('2026-08-28T08:30:00Z'),
        },
      ] : [], page === '1');
    }
    if (url.pathname.endsWith('/assets/withdraw')) {
      return coinExResponse([{
        withdraw_id: 2,
        ccy: 'PEARL',
        amount: '3',
        status: 'finished',
        created_at: Date.parse('2026-08-28T09:00:00Z'),
      }]);
    }
    if (url.pathname.endsWith('/spot/market')) {
      return coinExResponse([
        { market: 'PEARLUSDT', base_ccy: 'PEARL', quote_ccy: 'USDT' },
        { market: 'BTCPEARL', base_ccy: 'BTC', quote_ccy: 'PEARL' },
        { market: 'ETHUSDT', base_ccy: 'ETH', quote_ccy: 'USDT' },
      ]);
    }
    if (url.pathname.endsWith('/spot/user-deals')) {
      const market = url.searchParams.get('market');
      return coinExResponse(market === 'PEARLUSDT'
        ? [{
          deal_id: 3,
          market,
          side: 'sell',
          amount: '5',
          price: '0.25',
          created_at: Date.parse('2026-08-28T10:00:00Z'),
        }]
        : [{
          deal_id: 4,
          market,
          side: 'buy',
          amount: '0.01',
          price: '1000',
          created_at: Date.parse('2026-08-28T11:00:00Z'),
        }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const startTime = Date.parse('2026-08-01T00:00:00Z');
  const endTime = Date.parse('2026-09-01T00:00:00Z');
  const result = await client.getAssetActivity({
    coin: 'PEARL',
    startTime,
    endTime,
  });

  assert.deepEqual(result.deposits.map(({ amount }) => amount), ['10', '0.1']);
  assert.equal(result.withdrawals[0].amount, '3');
  assert.deepEqual(
    result.swaps.map(({ spentAmount, receivedAsset, receivedAmount }) => ({
      spentAmount, receivedAsset, receivedAmount,
    })),
    [
      { spentAmount: '5', receivedAsset: 'USDT', receivedAmount: '1.25' },
      { spentAmount: '10', receivedAsset: 'BTC', receivedAmount: '0.01' },
    ],
  );
  const depositUrl = new URL(calls.find(({ url }) => (
    url.includes('/assets/deposit-history')
  )).url);
  assert.equal(depositUrl.searchParams.get('ccy'), 'PEARL');
  assert.equal(depositUrl.searchParams.has('coin'), false);
  assert.equal(depositUrl.searchParams.has('status'), false);
  assert.equal(depositUrl.searchParams.get('limit'), '100');
  const withdrawalUrl = new URL(calls.find(({ url }) => (
    url.includes('/assets/withdraw')
  )).url);
  assert.equal(withdrawalUrl.searchParams.get('ccy'), 'PEARL');
  assert.equal(withdrawalUrl.searchParams.has('coin'), false);
  assert.equal(withdrawalUrl.searchParams.has('status'), false);
  assert.deepEqual(
    calls
      .filter(({ url }) => url.includes('/assets/deposit-history'))
      .map(({ url }) => new URL(url).searchParams.get('page')),
    ['1', '2'],
  );
  const dealUrls = calls
    .filter(({ url }) => url.includes('/spot/user-deals'))
    .map(({ url }) => new URL(url));
  assert.deepEqual(
    dealUrls.map((url) => url.searchParams.get('market')),
    ['PEARLUSDT', 'BTCPEARL'],
  );
  assert.equal(dealUrls[0].searchParams.get('market_type'), 'SPOT');
  assert.equal(dealUrls[0].searchParams.get('start_time'), String(startTime));
  assert.equal(dealUrls[0].searchParams.get('end_time'), String(endTime - 1));
});

test('CoinEx limit order sends the documented v2 request body and signature', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse({
    order_id: 123,
    state: 'pending',
  }));

  const order = await client.createOrder({
    pair: 'BTC-USDT',
    side: 'sell',
    type: 'limit',
    amount: '10',
    price: '0,33',
  });
  const body = calls[0].options.body;
  const expectedBody = JSON.stringify({
    market: 'BTCUSDT',
    market_type: 'SPOT',
    side: 'sell',
    type: 'limit',
    amount: '10',
    price: '0.33',
  });
  const expectedSign = createHmac('sha256', 'secret')
    .update(`POST/v2/spot/order${expectedBody}${FIXED_TIME}`)
    .digest('hex');

  assert.equal(calls[0].url, 'https://api.coinex.com/v2/spot/order');
  assert.equal(body, expectedBody);
  assert.equal(calls[0].options.headers['X-COINEX-SIGN'], expectedSign);
  assert.equal(order.order_id, 123);
});

test('CoinEx market order explicitly denominates amount in the base asset', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse({ order_id: 124 }));

  await client.createOrder({
    pair: 'BTC-USDT',
    side: 'buy',
    type: 'market',
    amount: '10',
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'BTCUSDT',
    market_type: 'SPOT',
    side: 'buy',
    type: 'market',
    amount: '10',
    ccy: 'BTC',
  });
});

test('CoinEx market buy can denominate amount in the quote asset', async () => {
  const calls = [];
  const client = createClient(calls, () => coinExResponse({ order_id: 125 }));

  await client.createOrder({
    pair: 'BTC-USDT',
    side: 'buy',
    type: 'market',
    amount: '100',
    amountAsset: 'USDT',
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'BTCUSDT',
    market_type: 'SPOT',
    side: 'buy',
    type: 'market',
    amount: '100',
    ccy: 'USDT',
  });
});

test('CoinEx non-zero API code becomes a structured error', async () => {
  const client = createClient([], () => new Response(JSON.stringify({
    code: 4006,
    data: null,
    message: 'Signature verification failed',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  await assert.rejects(client.getBalances(), (error) => {
    assert.ok(error instanceof HozamoApiError);
    assert.equal(error.exchange, 'coinex');
    assert.equal(error.code, 'COINEX_API_ERROR');
    assert.equal(error.apiCode, 4006);
    return true;
  });
});

test('CoinEx private calls require CoinEx credentials', async () => {
  const client = new CoinExClient({
    fetchImpl: () => {
      throw new Error('fetch should not be called');
    },
  });
  await assert.rejects(client.getBalances(), HozamoConfigError);
});

test('exchange factory builds a CoinEx client from CoinEx environment keys', () => {
  const client = createExchangeClient({
    exchange: 'coinex',
    env: {
      COINEX_API_KEY: 'key',
      COINEX_API_SECRET: 'secret',
    },
    fetchImpl: async () => coinExResponse([]),
  });
  assert.ok(client instanceof CoinExClient);
  assert.equal(client.exchange, 'coinex');
});

test('exchange factory proxies CoinEx requests when globally configured', async () => {
  const calls = [];
  const client = createExchangeClient({
    exchange: 'coinex',
    env: {
      COINEX_API_KEY: 'key',
      COINEX_API_SECRET: 'secret',
      HOZAMO_PROXY_URL: 'http://proxy.example.com:3128',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return coinExResponse([{ market: 'BTCUSDT', last: '60000' }]);
    },
  });

  await client.getPrice('BTC-USDT');

  assert.equal(typeof calls[0].options.dispatcher?.dispatch, 'function');
});

function createClient(calls, responder) {
  return new CoinExClient({
    apiKey: 'key',
    apiSecret: 'secret',
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responder(url, options);
    },
  });
}

function coinExResponse(data) {
  return new Response(JSON.stringify({ code: 0, data, message: 'OK' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function coinExPaginatedResponse(data, hasNext) {
  return new Response(JSON.stringify({
    code: 0,
    data,
    pagination: { has_next: hasNext },
    message: 'OK',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
