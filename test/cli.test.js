import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/cli.js';

test('no command prints help instead of doing nothing', async () => {
  const result = await runWithClient([], {});
  assert.equal(result.code, 0);
  assert.match(result.output, /Hozamo 0\.11\.0/);
  assert.match(result.output, /node hozamo price/);
});

test('--exchange coinex selects the CoinEx client', async () => {
  const factoryCalls = [];
  const stdout = [];
  const stderr = [];
  const code = await runCli(
    ['price', '--exchange', 'coinex', '--pair', 'BTC-USDT'],
    {
      clientFactory: (options) => {
        factoryCalls.push(options);
        return {
          exchange: 'coinex',
          displayName: 'CoinEx',
          getPrice: async () => ({ price: '0.30' }),
        };
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      setDnsResultOrder: () => {},
      env: {},
      cwd: '/directory-that-does-not-exist',
    },
  );

  assert.equal(code, 0);
  assert.equal(factoryCalls[0].exchange, 'coinex');
  assert.match(stdout.join('\n'), /\[CoinEx\].*0\.30 USDT/);
  assert.deepEqual(stderr, []);
});

test('CLI prefers IPv4 by default for every exchange', async () => {
  const dnsOrders = [];
  const result = await runWithClient(
    ['price', '--exchange', 'coinex', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
    { setDnsResultOrder: (value) => dnsOrders.push(value) },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(dnsOrders, ['ipv4first']);
});

test('CLI DNS result order can be overridden from the environment', async () => {
  const dnsOrders = [];
  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
    {
      env: { HOZAMO_DNS_RESULT_ORDER: 'verbatim' },
      setDnsResultOrder: (value) => dnsOrders.push(value),
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(dnsOrders, ['verbatim']);
});

test('price prints a human-readable last traded price', async () => {
  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => ({ price: '60000' }) },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /1 BTC = 60000 USDT/);
});

test('commands require an explicit pair or coin selector', async () => {
  const price = await runWithClient(['price'], {});
  const status = await runWithClient(['status'], {});
  const balance = await runWithClient(['balance'], {});

  assert.match(price.error, /--pair is required/);
  assert.match(status.error, /--coin is required/);
  assert.match(balance.error, /--coin is required/);
});

test('status accepts comma-separated assets and prints an aligned table', async () => {
  const result = await runWithClient(
    ['status', '--coin', 'PEARL,USDT'],
    {
      displayName: 'CoinEx',
      getAssetStatuses: async () => ([
        {
          asset: 'PEARL',
          depositEnabled: false,
          withdrawalEnabled: true,
          networks: [{
            network: 'PEARL',
            depositEnabled: false,
            withdrawalEnabled: true,
          }],
        },
        {
          asset: 'USDT',
          depositEnabled: true,
          withdrawalEnabled: true,
          networks: [],
        },
      ]),
    },
  );

  assert.equal(result.code, 0);
  assert.match(result.output, /ASSET  NETWORK  DEPOSIT   WITHDRAWAL/);
  assert.match(result.output, /PEARL  ALL      DISABLED  ENABLED/);
  assert.match(result.output, /PEARL  PEARL    DISABLED  ENABLED/);
  assert.match(result.output, /USDT   ALL      ENABLED   ENABLED/);
  assert.doesNotMatch(result.output, /\t/);
});

test('balance prints requested assets including a missing zero balance', async () => {
  const result = await runWithClient(
    ['balance', '--coin', 'QUAI,RVN'],
    {
      getBalances: async () => [{
        asset: 'QUAI', total: '282.85705135', available: '282.85705135', locked: '0',
      }],
    },
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /ASSET  TOTAL         AVAILABLE     LOCKED/);
  assert.match(result.output, /QUAI   282\.85705135  282\.85705135  0/);
  assert.match(result.output, /RVN    0             0             0/);
  assert.doesNotMatch(result.output, /\t/);
});

test('stats prints SUM first and one UTC row for every requested day', async () => {
  const fixedNow = Date.parse('2026-08-29T12:00:00Z');
  const requested = [];
  const result = await runWithClient(
    ['stats', '--coin', 'PEARL', '--days', '3'],
    {
      displayName: 'CoinEx',
      getAssetActivity: async (options) => {
        requested.push(options);
        return {
          deposits: [
            { timestamp: Date.parse('2026-08-28T01:00:00Z'), amount: '2.75' },
            { timestamp: Date.parse('2026-08-29T01:00:00Z'), amount: '1.25' },
          ],
          withdrawals: [
            { timestamp: Date.parse('2026-08-28T02:00:00Z'), amount: '0.5' },
          ],
          swaps: [
            {
              timestamp: Date.parse('2026-08-28T03:00:00Z'),
              spentAmount: '1.5',
              receivedAsset: 'USDT',
              receivedAmount: '0.375',
            },
            {
              timestamp: Date.parse('2026-08-29T03:00:00Z'),
              spentAmount: '2',
              receivedAsset: 'BTC',
              receivedAmount: '0.00001',
            },
          ],
        };
      },
    },
    { now: () => fixedNow },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(requested, [{
    coin: 'PEARL',
    startTime: Date.parse('2026-08-27T00:00:00Z'),
    endTime: fixedNow + 1,
  }]);
  const lines = result.output.split('\n');
  const headerIndex = lines.findIndex((line) => line.startsWith('DATE'));
  assert.ok(headerIndex >= 0);
  assert.match(lines[headerIndex], /RECEIVED BTC \(GROSS\).*RECEIVED USDT \(GROSS\)/);
  assert.match(lines[headerIndex + 1], /^SUM\s+4\s+0\.5\s+3\.5\s+0\.00001\s+0\.375/);
  assert.match(lines[headerIndex + 2], /^2026-08-27\s+0\s+0\s+0/);
  assert.match(lines[headerIndex + 3], /^2026-08-28\s+2\.75\s+0\.5\s+1\.5/);
  assert.match(lines[headerIndex + 4], /^2026-08-29\s+1\.25\s+0\s+2/);
});

test('stats CSV contains only CSV with header, SUM and daily rows', async () => {
  const result = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--from', '2026-08-28',
      '--to', '2026-08-29', '--format', 'csv',
    ],
    {
      getAssetActivity: async () => ({
        deposits: [],
        withdrawals: [],
        swaps: [{
          timestamp: Date.parse('2026-08-29T03:00:00Z'),
          spentAmount: '2',
          receivedAsset: 'USDT',
          receivedAmount: '0.5',
        }],
      }),
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.output, [
    'DATE,DEPOSITED PEARL,WITHDRAWN PEARL,SWAPPED PEARL,RECEIVED USDT (GROSS)',
    'SUM,0,0,2,0.5',
    '2026-08-28,0,0,0,0',
    '2026-08-29,0,0,2,0.5',
  ].join('\n'));
  assert.doesNotMatch(result.output, /Exchange:/);
});

test('stats --average-price adds daily and weighted-period USDT sell prices', async () => {
  const result = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--from', '2026-08-27',
      '--to', '2026-08-29', '--average-price', '--format', 'csv',
    ],
    {
      getAssetActivity: async () => ({
        deposits: [],
        withdrawals: [],
        swaps: [
          {
            timestamp: Date.parse('2026-08-28T01:00:00Z'),
            spentAmount: '2',
            receivedAsset: 'USDT',
            receivedAmount: '0.54',
          },
          {
            timestamp: Date.parse('2026-08-28T02:00:00Z'),
            spentAmount: '3',
            receivedAsset: 'USDT',
            receivedAmount: '0.9',
          },
          {
            timestamp: Date.parse('2026-08-28T03:00:00Z'),
            spentAmount: '10',
            receivedAsset: 'BTC',
            receivedAmount: '0.0001',
          },
          {
            timestamp: Date.parse('2026-08-29T01:00:00Z'),
            spentAmount: '4',
            receivedAsset: 'USDT',
            receivedAmount: '1.4',
          },
        ],
      }),
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.output, [
    'DATE,DEPOSITED PEARL,WITHDRAWN PEARL,SWAPPED PEARL,RECEIVED BTC (GROSS),RECEIVED USDT (GROSS),AVG SELL PRICE (USDT/PEARL)',
    'SUM,0,0,19,0.0001,2.84,0.31555',
    '2026-08-27,0,0,0,0,0,N/A',
    '2026-08-28,0,0,15,0.0001,1.44,0.288',
    '2026-08-29,0,0,4,0,1.4,0.35',
  ].join('\n'));
});

test('stats --average-price-decimals overrides the default precision', async () => {
  const result = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--days', '1', '--average-price',
      '--average-price-decimals', '8', '--format', 'csv',
    ],
    {
      getAssetActivity: async () => ({
        deposits: [],
        withdrawals: [],
        swaps: [{
          timestamp: 1,
          spentAmount: '9',
          receivedAsset: 'USDT',
          receivedAmount: '2.84',
        }],
      }),
    },
    { now: () => Date.parse('1970-01-01T00:00:01Z') },
  );

  assert.equal(result.code, 0);
  assert.match(result.output, /^SUM,0,0,9,2\.84,0\.31555555$/m);
});

test('stats validates --average-price-decimals before requesting history', async () => {
  let requested = false;
  const client = {
    getAssetActivity: async () => { requested = true; },
  };
  const withoutAveragePrice = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--days', '1',
      '--average-price-decimals', '8',
    ],
    client,
  );
  const invalidPrecision = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--days', '1', '--average-price',
      '--average-price-decimals', '101',
    ],
    client,
  );

  assert.equal(withoutAveragePrice.code, 1);
  assert.match(
    withoutAveragePrice.error,
    /--average-price-decimals can only be used with --average-price/,
  );
  assert.equal(invalidPrecision.code, 1);
  assert.match(
    invalidPrecision.error,
    /--average-price-decimals must be an integer between 0 and 100/,
  );
  assert.equal(requested, false);
});

test('stats --hide-zero-days omits inactive dates from table and CSV', async () => {
  const client = {
    displayName: 'CoinEx',
    getAssetActivity: async () => ({
      deposits: [],
      withdrawals: [],
      swaps: [{
        timestamp: Date.parse('2026-08-29T03:00:00Z'),
        spentAmount: '2',
        receivedAsset: 'USDT',
        receivedAmount: '0.5',
      }],
    }),
  };
  const baseArgs = [
    'stats', '--coin', 'PEARL', '--from', '2026-08-28',
    '--to', '2026-08-29', '--hide-zero-days',
  ];
  const table = await runWithClient(baseArgs, client);
  const csv = await runWithClient([...baseArgs, '--format', 'csv'], client);

  assert.equal(table.code, 0);
  assert.equal(
    table.output.split('\n').some((line) => line.startsWith('2026-08-28')),
    false,
  );
  assert.match(table.output, /^SUM\s+0\s+0\s+2\s+0\.5/m);
  assert.match(table.output, /^2026-08-29\s+0\s+0\s+2\s+0\.5/m);
  assert.equal(csv.code, 0);
  assert.equal(csv.output, [
    'DATE,DEPOSITED PEARL,WITHDRAWN PEARL,SWAPPED PEARL,RECEIVED USDT (GROSS)',
    'SUM,0,0,2,0.5',
    '2026-08-29,0,0,2,0.5',
  ].join('\n'));
});

test('stats --deposits-by-source splits SafeTrade deposits by known and unknown sources', async () => {
  const result = await runWithClient(
    [
      'stats', '--exchange', 'safetrade', '--coin', 'PRL',
      '--from', '2026-08-28', '--to', '2026-08-29',
      '--deposits-by-source', '--format', 'csv',
    ],
    {
      getAssetActivity: async () => ({
        deposits: [
          {
            timestamp: Date.parse('2026-08-28T01:00:00Z'),
            amount: '2',
            sourceAddress: 'prl1puv0gqv4x0wd0ylwz086y3sqrg4a6umza9r08aecehjrmdqq7mctsmqaqsh',
          },
          {
            timestamp: Date.parse('2026-08-28T02:00:00Z'),
            amount: '0.5',
            sourceAddress: 'prl1abcdefghijklmnopqrstuvwxyz0123456789',
          },
          {
            timestamp: Date.parse('2026-08-29T01:00:00Z'),
            amount: '3',
            sourceAddress: 'prl1pksfzrn8g760gmcqy65a4tl30eyv25eksl5sf8y332kes6fwx9pjszgymmz',
          },
          {
            timestamp: Date.parse('2026-08-29T02:00:00Z'),
            amount: '1',
            sourceAddress: null,
          },
        ],
        withdrawals: [],
        swaps: [],
      }),
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.output, [
    'DATE,DEPOSITED PRL,FROM Kryptex,FROM HeroMiners,FROM prl1abc..3456789,FROM UNKNOWN,WITHDRAWN PRL,SWAPPED PRL',
    'SUM,6.5,2,3,0.5,1,0,0',
    '2026-08-28,2.5,2,0,0.5,0,0,0',
    '2026-08-29,4,0,3,0,1,0,0',
  ].join('\n'));
});

test('stats --deposits-by-source supports custom pool names and multiple addresses', async () => {
  const result = await runWithClient(
    [
      'stats', '--coin', 'PRL', '--days', '1',
      '--deposits-by-source', '--format', 'csv',
    ],
    {
      getAssetActivity: async () => ({
        deposits: [
          { timestamp: 1, amount: '1', sourceAddress: 'pool-address-1' },
          { timestamp: 2, amount: '2', sourceAddress: 'pool-address-2' },
        ],
        withdrawals: [],
        swaps: [],
      }),
    },
    {
      now: () => Date.parse('1970-01-01T00:00:01Z'),
      env: {
        HOZAMO_DEPOSIT_SOURCES: JSON.stringify({
          'My Pool': ['pool-address-1', 'pool-address-2'],
        }),
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.output, [
    'DATE,DEPOSITED PRL,FROM My Pool,WITHDRAWN PRL,SWAPPED PRL',
    'SUM,3,3,0,0',
    '1970-01-01,3,3,0,0',
  ].join('\n'));
});

test('stats rejects --deposits-by-source on CoinEx before requesting history', async () => {
  let requested = false;
  const result = await runWithClient(
    [
      'stats', '--exchange', 'coinex', '--coin', 'PEARL', '--days', '7',
      '--deposits-by-source',
    ],
    {
      getAssetActivity: async () => { requested = true; },
    },
  );

  assert.equal(result.code, 1);
  assert.equal(requested, false);
  assert.match(
    result.error,
    /CoinEx API does not provide deposit source addresses.*--deposits-by-source cannot be used with CoinEx/,
  );
});

test('stats validates custom deposit source configuration only when requested', async () => {
  const client = {
    getAssetActivity: async () => ({ deposits: [], withdrawals: [], swaps: [] }),
  };
  const withoutFlag = await runWithClient(
    ['stats', '--coin', 'PRL', '--days', '1'],
    client,
    { env: { HOZAMO_DEPOSIT_SOURCES: 'not-json' } },
  );
  const withFlag = await runWithClient(
    ['stats', '--coin', 'PRL', '--days', '1', '--deposits-by-source'],
    client,
    { env: { HOZAMO_DEPOSIT_SOURCES: 'not-json' } },
  );

  assert.equal(withoutFlag.code, 0);
  assert.equal(withFlag.code, 1);
  assert.match(withFlag.error, /HOZAMO_DEPOSIT_SOURCES must be a valid JSON object/);
});

test('stats validates period and output format options', async () => {
  const missingTo = await runWithClient(
    ['stats', '--coin', 'PEARL', '--from', '2026-08-01'],
    {},
  );
  const mixed = await runWithClient(
    [
      'stats', '--coin', 'PEARL', '--days', '7',
      '--from', '2026-08-01', '--to', '2026-08-02',
    ],
    {},
  );
  const invalidFormat = await runWithClient(
    ['stats', '--coin', 'PEARL', '--days', '7', '--format', 'json'],
    {},
  );

  assert.match(missingTo.error, /--from and --to must be provided together/);
  assert.match(mixed.error, /either --days or the --from\/--to date range/);
  assert.match(invalidFormat.error, /--format is required and must be one of: table, csv/);
});

test('market sell checks available balance and submits after --yes', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '10', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        pair: 'BTC-USDT',
        minAmount: '10',
      }),
      getBalance: async () => ({ available: '10.5' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { order_id: 42, state: 'wait' };
      },
    },
  );
  assert.equal(result.code, 0);
  assert.deepEqual(submitted, [{
    pair: 'BTC-USDT', side: 'sell', type: 'market', amount: '10', price: undefined,
  }]);
  assert.match(result.output, /Order submitted successfully: id=42/);
});

test('insufficient sell balance prevents submission', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '10', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        pair: 'BTC-USDT',
        minAmount: '0.0005',
      }),
      getBalance: async () => ({ available: '9.99' }),
      createOrder: async () => { submitted = true; },
    },
  );
  assert.equal(result.code, 1);
  assert.equal(submitted, false);
  assert.match(result.error, /Insufficient BTC balance/);
});

for (const exchange of [
  {
    id: 'safetrade',
    name: 'SafeTrade',
    pair: 'BTC-USDT',
    amount: '0.0001',
    minimum: '0.0005',
    base: 'BTC',
  },
  {
    id: 'coinex',
    name: 'CoinEx',
    pair: 'PEARL-USDT',
    amount: '2',
    minimum: '5',
    base: 'PEARL',
  },
]) {
  test(`explicit amount honors the ${exchange.name} market minimum`, async () => {
    let priceRequested = false;
    let balanceRequested = false;
    const result = await runWithClient(
      [
        'order', '--exchange', exchange.id, '--type', 'limit', '--side', 'sell',
        '--pair', exchange.pair, '--amount', exchange.amount,
        '--price-percent', '8', '--dryrun',
      ],
      {
        getMarketInfo: async (pair) => {
          assert.equal(pair, exchange.pair);
          return {
            pair,
            minAmount: exchange.minimum,
          };
        },
        getPrice: async () => {
          priceRequested = true;
          return { price: '0.26557237' };
        },
        getBalance: async () => {
          balanceRequested = true;
          return { available: '100' };
        },
      },
    );

    assert.equal(result.code, 1);
    assert.equal(priceRequested, false);
    assert.equal(balanceRequested, false);
    assert.ok(
      result.error.includes(
        `Order amount ${exchange.amount} ${exchange.base} is below the ` +
        `${exchange.pair} market minimum of ${exchange.minimum} ${exchange.base}`,
      ),
    );
  });
}

test('market sell derives a base amount from the target quote proceeds', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--receive', '5', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getPrice: async () => ({ price: '0.28' }),
      getBalance: async (asset) => {
        assert.equal(asset, 'BTC');
        return { available: '20' };
      },
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 46 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.deepEqual(submitted, [{
    pair: 'BTC-USDT',
    side: 'sell',
    type: 'market',
    amount: '17.85714286',
    price: undefined,
  }]);
  assert.match(result.output, /Receive target: 5 USDT gross/);
  assert.match(result.output, /Calculated order amount: 17\.85714286 BTC/);
  assert.match(result.output, /Estimated gross proceeds: 5\.0000000008 USDT/);
  assert.match(result.output, /fees and market-order slippage excluded/);
});

test('limit sell uses its limit price for target quote sizing', async () => {
  let priceRequested = false;
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--side', 'sell', '--pair', 'BTC-USDT',
      '--receive', '5', '--price', '3', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 2,
        quotePrecision: 2,
        minAmount: '0.01',
        marketBuyAmountAsset: 'base',
      }),
      getPrice: async () => {
        priceRequested = true;
        return { price: '2.5' };
      },
      getBalance: async () => ({ available: '2' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 47 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(priceRequested, false);
  assert.equal(submitted[0].amount, '1.67');
  assert.equal(submitted[0].price, '3');
  assert.match(result.output, /Estimated gross proceeds: 5\.01 USDT/);
  assert.match(result.output, /limit price, rounded up to 2 decimal places/);
});

test('balance-percent 100 sells the available base balance rounded down', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getBalance: async (asset) => {
        assert.equal(asset, 'BTC');
        return { available: '1.234567899' };
      },
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 43 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '1.23456789');
  assert.equal(submitted[0].amountAsset, undefined);
  assert.match(result.output, /100% of 1\.234567899 BTC = 1\.23456789 BTC/);
});

test('SafeTrade-style market buy calculates base amount with the buy reserve', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 4,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'base',
      }),
      getBalance: async (asset) => {
        assert.equal(asset, 'USDT');
        return { available: '100' };
      },
      getPrice: async () => ({ price: '20' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { id: 44 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '4.975');
  assert.equal(submitted[0].amountAsset, undefined);
  assert.match(result.output, /Buy reserve: 0\.5%.*order budget 99\.5 USDT/);
  assert.match(result.output, /Calculated order amount: 4\.975 BTC/);
});

test('CoinEx-style market buy submits a quote-denominated balance allocation', async () => {
  const submitted = [];
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy',
      '--pair', 'BTC-USDT', '--balance-percent', '100', '--yes',
    ],
    {
      getMarketInfo: async () => ({
        basePrecision: 8,
        quotePrecision: 2,
        minAmount: '0.0005',
        marketBuyAmountAsset: 'quote',
      }),
      getBalance: async () => ({ available: '100.129' }),
      createOrder: async (order) => {
        submitted.push(order);
        return { order_id: 45 };
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(submitted[0].amount, '99.61');
  assert.equal(submitted[0].amountAsset, 'USDT');
  assert.match(result.output, /quote-denominated by the exchange/);
  assert.match(result.output, /Order: BUY BTC-USDT MARKET using 99\.61 USDT/);
});

test('order sizing options are mutually exclusive and percentage is capped', async () => {
  const both = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--amount', '1', '--balance-percent', '100', '--dryrun',
    ],
    {},
  );
  const tooHigh = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--balance-percent', '100.01', '--dryrun',
    ],
    {},
  );
  const receiveWithAmount = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell', '--pair', 'BTC-USDT',
      '--amount', '1', '--receive', '5', '--dryrun',
    ],
    {},
  );
  const receiveBuy = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'buy', '--pair', 'BTC-USDT',
      '--receive', '5', '--dryrun',
    ],
    {},
  );

  assert.equal(both.code, 1);
  assert.match(
    both.error,
    /exactly one of --amount, --balance-percent or --receive/,
  );
  assert.equal(tooHigh.code, 1);
  assert.match(tooHigh.error, /at most 100/);
  assert.equal(receiveWithAmount.code, 1);
  assert.match(receiveWithAmount.error, /exactly one/);
  assert.equal(receiveBuy.code, 1);
  assert.match(receiveBuy.error, /--receive can only be used with sell orders/);
});

test('limit price-percent is calculated and dryrun never submits', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--order', 'sell', '--amount', '10',
      '--pair', 'BTC-USDT', '--price-percent', '10', '--dryrun',
    ],
    {
      getMarketInfo: async () => ({
        pair: 'BTC-USDT',
        minAmount: '0.0005',
      }),
      getPrice: async () => ({ price: '0.28000000' }),
      getBalance: async () => ({ available: '100' }),
      createOrder: async () => { submitted = true; },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(submitted, false);
  assert.match(result.output, /0\.30800000 USDT/);
  assert.match(result.output, /Dry run complete/);
});

test('limit order rejects simultaneous price options', async () => {
  const result = await runWithClient(
    [
      'order', '--type', 'limit', '--side', 'sell', '--amount', '10',
      '--pair', 'BTC-USDT', '--price', '0.28', '--price-percent', '10', '--dryrun',
    ],
    {},
  );
  assert.equal(result.code, 1);
  assert.match(result.error, /mutually exclusive/);
});

test('interactive rejection cancels without submission', async () => {
  let submitted = false;
  const result = await runWithClient(
    [
      'order', '--type', 'market', '--side', 'sell',
      '--pair', 'BTC-USDT', '--amount', '1',
    ],
    {
      getMarketInfo: async () => ({
        pair: 'BTC-USDT',
        minAmount: '0.0005',
      }),
      getBalance: async () => ({ available: '2' }),
      createOrder: async () => { submitted = true; },
    },
    { confirm: async () => false },
  );
  assert.equal(result.code, 0);
  assert.equal(submitted, false);
  assert.match(result.output, /Order cancelled/);
});

test('Cloudflare API error is concise and actionable', async () => {
  const error = Object.assign(new Error('blocked'), {
    code: 'CLOUDFLARE_BLOCKED',
    status: 403,
    rayId: 'abc123',
  });
  Object.setPrototypeOf(error, (await import('../src/errors.js')).SafeTradeApiError.prototype);

  const result = await runWithClient(
    ['price', '--pair', 'BTC-USDT'],
    { getPrice: async () => { throw error; } },
  );
  assert.equal(result.code, 1);
  assert.match(result.error, /blocked the API request through Cloudflare/);
  assert.doesNotMatch(result.error, /<!DOCTYPE html>/);
});

test('--debug prints the failed API request without authentication headers', async () => {
  const error = Object.assign(new Error('CoinEx API error 10001: Invalid Parameter'), {
    exchange: 'coinex',
    code: 'COINEX_API_ERROR',
    method: 'GET',
    url: 'https://api.coinex.com/v2/assets/deposit-history?coin=PEARL&page=1&limit=100',
  });
  Object.setPrototypeOf(error, (await import('../src/errors.js')).HozamoApiError.prototype);

  const result = await runWithClient(
    ['stats', '--coin', 'PEARL', '--days', '4', '--debug'],
    { getAssetActivity: async () => { throw error; } },
  );
  assert.equal(result.code, 1);
  assert.match(result.error, /CoinEx API error 10001: Invalid Parameter/);
  assert.match(result.error, /Request: GET https:\/\/api\.coinex\.com\/v2\/assets\/deposit-history\?coin=PEARL/);
  assert.doesNotMatch(result.error, /X-COINEX-(?:KEY|SIGN)/);
});

async function runWithClient(args, client, extra = {}) {
  const stdout = [];
  const stderr = [];
  const code = await runCli(args, {
    clientFactory: () => client,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    env: {},
    setDnsResultOrder: () => {},
    cwd: '/directory-that-does-not-exist',
    ...extra,
  });
  return {
    code,
    output: stdout.join('\n'),
    error: stderr.join('\n'),
  };
}
