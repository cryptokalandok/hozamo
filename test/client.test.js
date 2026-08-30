import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  SafeTradeApiError,
  SafeTradeClient,
  SafeTradeConfigError,
  SafeTradeValidationError,
  createExchangeClient,
  createSignature,
} from '../src/index.js';

const FIXED_TIME = 1_700_000_000_000;

test('createSignature implements HMAC-SHA256(secret, nonce + apiKey)', () => {
  const expected = createHmac('sha256', 'secret')
    .update(`${FIXED_TIME}key`)
    .digest('hex');

  assert.equal(
    createSignature({
      nonce: String(FIXED_TIME),
      apiKey: 'key',
      apiSecret: 'secret',
    }),
    expected,
  );
});

test('getPrice calls the public ticker endpoint and extracts last price', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({
    at: FIXED_TIME,
    ticker: { last: '0.28000000', buy: '0.27', sell: '0.29' },
  }));

  const result = await client.getPrice('BTC-USDT');

  assert.equal(calls[0].url, 'https://safe.trade/api/v2/trade/public/tickers/btcusdt');
  assert.equal(calls[0].options.headers['X-Auth-Apikey'], undefined);
  assert.equal(result.market, 'btcusdt');
  assert.equal(result.price, '0.28000000');
});

test('getMarketInfo normalizes SafeTrade amount and price precision', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({
    data: [{
      id: 'btcusdt',
      base_unit: 'btc',
      quote_unit: 'usdt',
      amount_precision: 8,
      price_precision: 2,
      min_amount: '0.0005',
    }],
  }));

  const result = await client.getMarketInfo('BTC-USDT');

  assert.equal(calls[0].url, 'https://safe.trade/api/v2/trade/public/markets');
  assert.equal(result.basePrecision, 8);
  assert.equal(result.quotePrecision, 2);
  assert.equal(result.minAmount, '0.0005');
  assert.equal(result.marketBuyAmountAsset, 'base');
});

test('getAssetStatuses normalizes multiple SafeTrade currencies', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({
    data: [
      {
        id: 'pearl',
        deposit_enabled: false,
        withdrawal_enabled: true,
        networks: [{
          code: 'pearl',
          deposit_enabled: false,
          withdrawal_enabled: true,
        }],
      },
      { code: 'USDT', can_deposit: true, can_withdraw: true },
    ],
  }));

  const result = await client.getAssetStatuses('PEARL,USDT');

  assert.equal(
    calls[0].url,
    'https://safe.trade/api/v2/trade/public/currencies',
  );
  assert.equal(
    calls.some(({ options }) => options.headers['X-Auth-Apikey'] !== undefined),
    false,
  );
  assert.equal(result[0].asset, 'PEARL');
  assert.equal(result[0].depositEnabled, false);
  assert.equal(result[0].withdrawalEnabled, true);
  assert.equal(result[0].networks[0].network, 'pearl');
  assert.equal(result[1].depositEnabled, true);
});

test('getBalances authenticates, normalizes and filters balances', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse([
    { currency: 'quai', balance: '10.5', locked: '1.25' },
    { currency: 'rvn', balance: '22', locked: '0' },
    { currency: 'btc', balance: '0.1', locked: '0' },
  ]));

  const result = await client.getBalances({ coins: 'QUAI,RVN' });
  const headers = calls[0].options.headers;

  assert.equal(calls[0].url, 'https://safe.trade/api/v2/trade/account/balances/spot');
  assert.equal(headers['X-Auth-Apikey'], 'key');
  assert.equal(headers['Content-Type'], 'application/json;charset=utf-8');
  assert.equal(headers['X-Auth-Nonce'], String(FIXED_TIME));
  assert.equal(
    headers['X-Auth-Signature'],
    createSignature({
      nonce: String(FIXED_TIME),
      apiKey: 'key',
      apiSecret: 'secret',
    }),
  );
  assert.deepEqual(
    result.map(({ asset, total, available, locked }) => ({
      asset,
      total,
      available,
      locked,
    })),
    [
      { asset: 'QUAI', total: '11.75', available: '10.5', locked: '1.25' },
      { asset: 'RVN', total: '22', available: '22', locked: '0' },
    ],
  );
});

test('SafeTrade asset activity requests and normalizes credited history', async () => {
  const calls = [];
  const client = createClient(calls, (url) => {
    if (url.pathname.endsWith('/trade/account/deposits')) {
      const page = url.searchParams.get('page');
      return jsonResponse(page === '1' ? [
        {
          id: 1,
          currency: 'pearl',
          amount: '12.5',
          address: 'prl1psourceaddress',
          status: 'accepted',
          created_at: '2026-08-28T08:00:00Z',
        },
        ...Array.from({ length: 99 }, (_, index) => ({
          id: 2,
          currency: 'pearl',
          amount: '99',
          status: 'rejected',
          created_at: '2026-08-28T09:00:00Z',
          pageItem: index,
        })),
      ] : []);
    }
    if (url.pathname.endsWith('/trade/account/withdraws')) {
      return jsonResponse([{
        id: 3,
        currency_id: 'pearl',
        amount: '2',
        status: 'succeed',
        created_at: '2026-08-28T10:00:00Z',
      }]);
    }
    if (url.pathname.endsWith('/trade/market/trades')) {
      return jsonResponse([
        {
          id: 4,
          market: 'pearlusdt',
          order_side: 'sell',
          amount: '5',
          price: '0.3',
          total: '1.5',
          created_at: '2026-08-28T11:00:00Z',
        },
        {
          id: 5,
          market: 'btcpearl',
          order_side: 'buy',
          amount: '0.01',
          price: '1000',
          total: '10',
          created_at: '2026-08-28T12:00:00Z',
        },
        {
          id: 6,
          market: 'pearlusdt',
          order_side: 'buy',
          amount: '5',
          total: '1.5',
          created_at: '2026-08-28T13:00:00Z',
        },
      ]);
    }
    if (url.pathname.endsWith('/trade/public/markets')) {
      return jsonResponse({ data: [
        { id: 'pearlusdt', base_unit: 'pearl', quote_unit: 'usdt' },
        { id: 'btcpearl', base_unit: 'btc', quote_unit: 'pearl' },
      ] });
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

  assert.deepEqual(
    result.deposits.map(({ amount, sourceAddress }) => ({
      amount, sourceAddress,
    })),
    [{ amount: '12.5', sourceAddress: 'prl1psourceaddress' }],
  );
  assert.deepEqual(
    result.withdrawals.map(({ amount }) => amount),
    ['2'],
  );
  assert.deepEqual(
    result.swaps.map(({ spentAmount, receivedAsset, receivedAmount }) => ({
      spentAmount, receivedAsset, receivedAmount,
    })),
    [
      { spentAmount: '5', receivedAsset: 'USDT', receivedAmount: '1.5' },
      { spentAmount: '10', receivedAsset: 'BTC', receivedAmount: '0.01' },
    ],
  );
  const depositUrl = new URL(calls.find(({ url }) => (
    url.includes('/trade/account/deposits')
  )).url);
  assert.equal(depositUrl.searchParams.get('currency'), 'pearl');
  assert.equal(depositUrl.searchParams.has('time_from'), false);
  assert.equal(depositUrl.searchParams.has('time_to'), false);
  assert.equal(depositUrl.searchParams.get('limit'), '100');
  assert.equal(depositUrl.searchParams.get('page'), '1');
  assert.deepEqual(
    calls
      .filter(({ url }) => url.includes('/trade/account/deposits'))
      .map(({ url }) => new URL(url).searchParams.get('page')),
    ['1', '2'],
  );
  const tradeUrl = new URL(calls.find(({ url }) => (
    url.includes('/trade/market/trades')
  )).url);
  assert.equal(tradeUrl.searchParams.get('time_from'), '1785542400');
  assert.equal(tradeUrl.searchParams.get('time_to'), '1788220800');
});

test('createOrder sends a market sell without price', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({ id: 123 }, 201));

  const order = await client.createOrder({
    pair: 'BTC-USDT',
    side: 'sell',
    type: 'market',
    amount: 10,
  });

  assert.equal(order.id, 123);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'btcusdt',
    side: 'sell',
    amount: '10',
    type: 'market',
  });
});

test('SafeTrade rejects a quote-denominated order amount', async () => {
  const client = createClient([], () => jsonResponse({ id: 123 }, 201));

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'buy',
      type: 'market',
      amount: '100',
      amountAsset: 'USDT',
    }),
    /must be denominated in BTC/,
  );
});

test('createOrder sends a normalized decimal price for a limit order', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse({ id: 124 }, 201));

  await client.createOrder({
    pair: 'BTC/USDT',
    side: 'SELL',
    type: 'LIMIT',
    amount: '10.0',
    price: '0,28',
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    market: 'btcusdt',
    side: 'sell',
    amount: '10.0',
    type: 'limit',
    price: '0.28',
  });
});

test('private calls require API credentials', async () => {
  const client = new SafeTradeClient({
    fetchImpl: () => {
      throw new Error('fetch should not be called');
    },
  });

  await assert.rejects(
    client.getBalances(),
    SafeTradeConfigError,
  );
});

test('market order rejects price and limit order requires it', async () => {
  const client = createClient([], () => jsonResponse({}));

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'market',
      amount: '10',
      price: '0.28',
    }),
    SafeTradeValidationError,
  );

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'limit',
      amount: '10',
    }),
    SafeTradeValidationError,
  );
});

test('API failures preserve status and parsed response', async () => {
  const client = createClient([], () => jsonResponse({ error: 'insufficient balance' }, 422));

  await assert.rejects(
    client.createOrder({
      pair: 'BTC-USDT',
      side: 'sell',
      type: 'market',
      amount: '1000',
    }),
    (error) => {
      assert.ok(error instanceof SafeTradeApiError);
      assert.equal(error.status, 422);
      assert.equal(error.response.error, 'insufficient balance');
      return true;
    },
  );
});

test('Cloudflare HTML block is converted to a concise structured error', async () => {
  const client = createClient([], () => new Response(
    '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>',
    {
      status: 403,
      headers: {
        'Content-Type': 'text/html',
        'CF-Ray': 'test-ray-id',
      },
    },
  ));

  await assert.rejects(
    client.getPrice('BTC-USDT'),
    (error) => {
      assert.ok(error instanceof SafeTradeApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'CLOUDFLARE_BLOCKED');
      assert.equal(error.rayId, 'test-ray-id');
      assert.doesNotMatch(error.message, /<!DOCTYPE html>/);
      return true;
    },
  );
});

test('nonces remain strictly increasing when requests share a millisecond', async () => {
  const calls = [];
  const client = createClient(calls, () => jsonResponse([]));

  await client.getBalances();
  await client.getBalances();

  assert.deepEqual(
    calls.map(({ options }) => options.headers['X-Auth-Nonce']),
    [String(FIXED_TIME), String(FIXED_TIME + 1)],
  );
});

test('exchange factory proxies SafeTrade requests when globally configured', async () => {
  const calls = [];
  const client = createExchangeClient({
    exchange: 'safetrade',
    env: {
      HOZAMO_PROXY_URL: 'https://proxy.example.com:8443',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ticker: { last: '60000' } });
    },
  });

  await client.getPrice('BTC-USDT');

  assert.equal(typeof calls[0].options.dispatcher?.dispatch, 'function');
});

function createClient(calls, responder) {
  return new SafeTradeClient({
    apiKey: 'key',
    apiSecret: 'secret',
    now: () => FIXED_TIME,
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responder(url, options);
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
