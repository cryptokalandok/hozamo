import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { recordTreasury, withTreasury } from '../src/treasury.js';
import { treasuryDailyChanges } from '../src/treasury-cost.js';
import { normalizeSafeTradeActivity, normalizeCoinExActivity } from '../src/statistics.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');

function swap(at, spentAmount, receivedAmount, receivedAsset = 'USDT') {
  return { timestamp: Date.parse(at), spentAmount, receivedAmount, receivedAsset };
}

function fixture(t, exchange = 'safetrade') {
  const root = mkdtempSync(join(tmpdir(), 'hozamo-cost-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'treasury.json');
  const queries = [];
  let activity = { swaps: [] };
  async function seed(entries) {
    await withTreasury(path, async (state, save) => {
      for (const entry of entries) {
        recordTreasury(state, { exchange, coin: 'PEARL', action: 'add', ...entry });
      }
      await save();
    });
  }
  async function invoke(args, overrides = {}) {
    const output = [], errors = [];
    const code = await runCli(args, {
      cwd: root, instanceDir: root, env: {}, now: () => NOW, setDnsResultOrder: () => {},
      clientFactory: () => ({
        getAssetActivity: async (query) => { queries.push(query); return activity; },
        createOrder: async () => { throw new Error('Must never trade'); },
        getBalance: async () => { throw new Error('Must not require funding'); },
        getPrice: async () => { throw new Error('Must not fall back to ticker price'); },
      }),
      stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
      ...overrides,
    });
    return { code, output: output.join('\n'), error: errors.join('\n') };
  }
  const run = (args = [], overrides = {}) => invoke(['treasury', 'cost', '--exchange', exchange, '--coin', 'PEARL', ...args], overrides);
  return { root, path, queries, seed, run, invoke, activity: (value) => { activity = value; } };
}

const HEADER = 'DATE,PEARL CHANGE,AVG PRICE (USDT/PEARL),EST. COST USDT (GROSS),EST. REVENUE USDT (GROSS),EST. NET COST USDT (GROSS)';
const csvRows = (result) => result.output.split('\n').slice(1).map((line) => line.split(','));
const summaries = (result) => csvRows(result).slice(0, 3);

// Same sequence and UTC dates as the reported 16 PEARL ledger; IDs do not affect accounting.
const reportedEntries = [
  ['2026-11-07T19:19:55.580Z', 'add', '2'],
  ['2026-11-07T19:20:30.837Z', 'free', '2'],
  ['2026-11-07T19:20:39.413Z', 'add', '2'],
  ['2026-11-07T23:00:03.449Z', 'add', '2'],
  ['2026-11-09T10:02:57.681Z', 'add', '2'],
  ['2026-11-09T10:03:12.615Z', 'free', '2'],
  ['2026-11-09T10:35:16.930Z', 'add', '2'],
  ['2026-11-09T10:36:02.740Z', 'add', '2'],
  ['2026-11-09T10:36:11.083Z', 'free', '2'],
  ['2026-11-10T06:43:46.842Z', 'add', '2'],
  ['2026-11-10T23:05:01.995Z', 'add', '2'],
  ['2026-11-11T23:05:02.433Z', 'add', '2'],
  ['2026-11-12T23:05:02.222Z', 'add', '2'],
  ['2026-11-13T23:05:02.504Z', 'add', '2'],
].map(([at, action, amount]) => ({ at, action, amount }));

for (const exchange of ['safetrade', 'coinex']) {
  test(`${exchange}: reported ledger matches stats daily changes, not FIFO remaining lots`, async (t) => {
    const f = fixture(t, exchange);
    await f.seed([...reportedEntries,
      { at: '2026-11-01T00:00:00Z', coin: 'BTC', amount: '999' },
      { at: '2026-11-01T00:00:00Z', exchange: exchange === 'coinex' ? 'safetrade' : 'coinex', amount: '999' },
    ]);
    f.activity({ swaps: [
      swap('2026-11-07T12:00:00Z', '20', '35.28'),
      swap('2026-11-09T12:00:00Z', '22', '35.4'),
      swap('2026-11-10T12:00:00Z', '12', '18.18'),
      swap('2026-11-11T12:00:00Z', '16', '23.36'),
      swap('2026-11-12T12:00:00Z', '14', '19.26'),
      swap('2026-11-13T12:00:00Z', '14', '19.8202'),
    ] });
    const before = readFileSync(f.path, 'utf8');
    writeFileSync(`${f.path}.lock`, 'another process');
    const result = await f.run(['--format', 'csv']);
    assert.equal(result.code, 0, result.error);
    assert.equal(result.output.split('\n')[0], HEADER);
    assert.deepEqual(summaries(result), [
      ['SUM', '16', '1.55232', '24.83707', '0', '24.83707'],
      ['ADDED', '16', '1.55232', '24.83707', '0', '24.83707'],
      ['RELEASED', '0', 'N/A', '0', '0', '0'],
    ]);
    const expected = [
      ['2026-11-07', '4'], ['2026-11-09', '2'], ['2026-11-10', '4'],
      ['2026-11-11', '2'], ['2026-11-12', '2'], ['2026-11-13', '2'],
    ];
    assert.deepEqual(csvRows(result).slice(3).map((row) => row.slice(0, 2)), expected);
    const stats = await f.invoke(['stats', '--exchange', exchange, '--coin', 'PEARL',
      '--from', '2026-11-06', '--to', '2026-11-30', '--treasury', '--hide-zero-days', '--format', 'csv']);
    assert.equal(stats.code, 0, stats.error);
    assert.deepEqual(csvRows(stats).slice(1).map((row) => [row[0], row.at(-1)]), expected);
    assert.deepEqual(f.queries[0], {
      coin: 'PEARL', startTime: Date.parse('2026-11-07T00:00:00Z'), endTime: Date.parse('2026-11-14T00:00:00Z'),
    });
    const table = await f.run();
    assert.equal(table.code, 0, table.error);
    assert.match(table.output, /SUM\s+16\s+1\.55232\s+24\.83707\s+0\s+24\.83707/);
    assert.match(table.output, /RELEASED\s+0\s+N\/A\s+0\s+0\s+0/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
    assert.equal(readFileSync(`${f.path}.lock`, 'utf8'), 'another process');
  });
}

test('negative days use their own sale price and separate weighted release averages from addition averages', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-06T08:00:00Z', amount: '10' },
    { at: '2026-11-07T08:00:00Z', amount: '10' },
    { at: '2026-11-08T08:00:00Z', action: 'free', amount: '4' },
    { at: '2026-11-09T08:00:00Z', action: 'free', amount: '2' },
  ]);
  f.activity({ swaps: [
    swap('2026-11-05T23:59:59Z', '1', '999'), // outside range
    swap('2026-11-06T00:00:00Z', '1', '1'),
    swap('2026-11-06T23:59:59Z', '3', '7'), // weighted price = 2
    swap('2026-11-06T12:00:00Z', '100', '1', 'BTC'),
    swap('2026-11-07T12:00:00Z', '2', '6'),
    swap('2026-11-08T12:00:00Z', '1', '4'),
    swap('2026-11-09T12:00:00Z', '1', '5'),
    swap('2026-11-10T00:00:00Z', '1', '999'), // outside range
  ] });
  const result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result), [
    ['SUM', '14', '1.71429', '50', '26', '24'],
    ['ADDED', '20', '2.5', '50', '0', '50'],
    ['RELEASED', '-6', '4.33333', '0', '26', '-26'],
  ]);
  assert.deepEqual(csvRows(result).slice(-2), [
    ['2026-11-08', '-4', '4', '0', '16', '-16'],
    ['2026-11-09', '-2', '5', '0', '10', '-10'],
  ]);
});

test('same-day cancellations and ignore/re-add are netted first; net cost and average may be negative', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-06T00:00:00Z', amount: '10' },
    { at: '2026-11-06T01:00:00Z', action: 'free', amount: '3' },
    { at: '2026-11-07T00:00:00Z', action: 'free', amount: '2' },
    { at: '2026-11-07T01:00:00Z', amount: '2' },
    { at: '2026-11-08T00:00:00Z', action: 'ignore', amount: '7' },
    { at: '2026-11-08T01:00:00Z', amount: '2' },
  ]);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '1', '2'), swap('2026-11-08T12:00:00Z', '1', '3')] });
  const result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result), [
    ['SUM', '2', '-0.5', '14', '15', '-1'],
    ['ADDED', '7', '2', '14', '0', '14'],
    ['RELEASED', '-5', '3', '0', '15', '-15'],
  ]);
  assert.deepEqual(csvRows(result).slice(3).map((row) => row.slice(0, 2)), [['2026-11-06', '7'], ['2026-11-08', '-5']]);
});

for (const action of ['free', 'ignore']) {
  test(`${action}: zero current balance retains historical costs/revenue and has no average`, async (t) => {
    const f = fixture(t);
    await f.seed([
      { at: '2026-11-06T00:00:00Z', amount: '6' },
      { at: '2026-11-07T00:00:00Z', action, amount: '6' },
    ]);
    f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '1', '2'), swap('2026-11-07T12:00:00Z', '1', '3')] });
    const result = await f.run(['--format', 'csv']);
    assert.equal(result.code, 0, result.error);
    assert.deepEqual(summaries(result), [
      ['SUM', '0', 'N/A', '12', '18', '-6'],
      ['ADDED', '6', '2', '12', '0', '12'],
      ['RELEASED', '-6', '3', '0', '18', '-18'],
    ]);
    assert.equal(f.queries.length, 1);
  });
}

test('missing prices invalidate only affected totals; net/average are N/A and known subtotals stay explicit', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-06T00:00:00Z', amount: '10' },
    { at: '2026-11-07T00:00:00Z', action: 'free', amount: '4' },
  ]);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '1', '2'), swap('2026-11-07T12:00:00Z', '4', '1', 'BTC')] });
  let result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result), [
    ['SUM', '6', 'N/A', '20', 'N/A', 'N/A'],
    ['ADDED', '10', '2', '20', '0', '20'],
    ['RELEASED', '-4', 'N/A', '0', 'N/A', 'N/A'],
  ]);
  const table = await f.run();
  assert.match(table.output, /Released: priced 0 PEARL; unpriced 4 PEARL; known subtotal: 0 USDT/);
  f.activity({ swaps: [swap('2026-11-07T12:00:00Z', '1', '3')] });
  result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result), [
    ['SUM', '6', 'N/A', 'N/A', '12', 'N/A'],
    ['ADDED', '10', 'N/A', 'N/A', '0', 'N/A'],
    ['RELEASED', '-4', '3', '0', '12', '-12'],
  ]);
  f.activity({ swaps: [] });
  result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result)[0], ['SUM', '6', 'N/A', 'N/A', 'N/A', 'N/A']);
});

test('UTC dates and today cutoff match stats, including negative days', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-14T00:30:00+01:00', amount: '3' }, // Nov 13 UTC
    { at: '2026-11-13T23:45:00Z', action: 'free', amount: '1' },
    { at: '2026-11-14T01:00:00Z', action: 'free', amount: '1' },
  ]);
  f.activity({ swaps: [
    swap('2026-11-13T12:00:00Z', '1', '2'),
    swap('2026-11-14T12:00:00Z', '1', '3'),
    swap('2026-11-14T12:00:00.001Z', '1', '999'),
  ] });
  const result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result)[0], ['SUM', '1', '1', '4', '3', '1']);
  assert.deepEqual(csvRows(result).slice(3), [
    ['2026-11-13', '2', '2', '4', '0', '4'],
    ['2026-11-14', '-1', '3', '0', '3', '-3'],
  ]);
  assert.equal(f.queries[0].endTime, NOW + 1);
});

test('signed values round only for display; amounts and percentages remain exact', async (t) => {
  const f = fixture(t);
  await f.seed([{ at: '2026-11-06T00:00:00Z', amount: '3' }]);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '3', '2')] });
  for (const [args, price] of [[[], '0.66667'], [['--decimals', '8'], '0.66666667'], [['--decimals', '0'], '1']]) {
    const result = await f.run(['--format', 'csv', ...args]);
    assert.equal(result.code, 0, result.error);
    assert.deepEqual(summaries(result)[0], ['SUM', '3', price, '2', '0', '2']);
  }
  const freed = await f.invoke(['treasury', 'free', '--coin', 'PEARL', '--amount-percentage', '50'], {
    now: () => Date.parse('2026-11-07T00:00:00Z'),
  });
  assert.equal(freed.code, 0, freed.error);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '3', '2'), swap('2026-11-07T12:00:00Z', '1', '2')] });
  const negative = await f.run(['--format', 'csv']);
  assert.equal(negative.code, 0, negative.error);
  assert.deepEqual(summaries(negative)[0], ['SUM', '1.5', '-0.66667', '2', '3', '-1']);
});

test('daily netting uses exact decimals even for tiny releases and zero-net days', () => {
  const state = { version: 1, balances: {}, ledger: [] };
  const entries = [
    ['2026-11-06', 'add', '0.1'], ['2026-11-06', 'add', '0.2'], ['2026-11-06', 'free', '0.3'],
    ['2026-11-07', 'add', '0.000000000000000003'], ['2026-11-08', 'free', '0.000000000000000001'],
  ];
  for (const [date, action, amount] of entries) {
    recordTreasury(state, { exchange: 'safetrade', coin: 'PEARL', at: `${date}T00:00:00Z`, action, amount });
  }
  const before = JSON.stringify(state);
  assert.deepEqual(treasuryDailyChanges(state, 'safetrade', 'PEARL', NOW), [
    { date: '2026-11-07', amount: '0.000000000000000003', direction: 'added' },
    { date: '2026-11-08', amount: '-0.000000000000000001', direction: 'released' },
  ]);
  assert.equal(JSON.stringify(state), before);
});

test('no ledger or only zero-net days reports zero without constructing an API client', async (t) => {
  const f = fixture(t);
  const offline = { clientFactory: () => { throw new Error('Must not create a client'); } };
  let result = await f.run(['--format', 'csv'], offline);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(summaries(result)[0], ['SUM', '0', 'N/A', '0', '0', '0']);
  assert.equal(existsSync(f.path), false);
  await f.seed([
    { at: '2026-11-06T00:00:00Z', amount: '2' },
    { at: '2026-11-06T01:00:00Z', action: 'free', amount: '2' },
    { at: '2026-11-07T00:00:00Z', amount: '4' },
    { at: '2026-11-07T01:00:00Z', action: 'ignore', amount: '4' },
  ]);
  const before = readFileSync(f.path, 'utf8');
  result = await f.run(['--format', 'csv'], offline);
  assert.equal(result.code, 0, result.error);
  assert.equal(csvRows(result).length, 3);
  assert.deepEqual(summaries(result)[0], ['SUM', '0', 'N/A', '0', '0', '0']);
  assert.equal(readFileSync(f.path, 'utf8'), before);
});

test('bad options, corrupt ledger, future entry and API failure do not produce misleading reports or mutate state', async (t) => {
  const f = fixture(t);
  await f.seed([{ at: '2026-11-06T00:00:00Z', amount: '2' }]);
  const before = readFileSync(f.path, 'utf8');
  for (const args of [
    ['--decimals', '-1'], ['--decimals', '101'], ['--decimals', '1.5'], ['--decimals', 'NaN'],
    ['--format', 'json'], ['--amount', '2'], ['--from', '2026-11-01'], ['--days', '30'],
  ]) {
    const result = await f.run(args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.output, '');
  }
  const failure = await f.run([], {
    clientFactory: () => ({ getAssetActivity: async () => { throw new Error('History API failed'); } }),
  });
  assert.equal(failure.code, 1);
  assert.match(failure.error, /History API failed/);
  assert.equal(failure.output, '');
  const future = await f.run([], { now: () => Date.parse('2026-11-05T00:00:00Z') });
  assert.equal(future.code, 1);
  assert.match(future.error, /future-dated/);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  writeFileSync(f.path, '{broken');
  const corrupt = await f.run();
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.error, /Invalid treasury file/);
  assert.equal(readFileSync(f.path, 'utf8'), '{broken');
  assert.equal(f.queries.length, 0);
});

for (const exchange of ['safetrade', 'coinex']) {
  test(`${exchange} executed sales use existing normalization, excluding purchases and non-USDT swaps`, async (t) => {
    const f = fixture(t, exchange);
    await f.seed([{ at: '2026-11-06T00:00:00Z', amount: '2' }]);
    const trades = [
      { id: 1, market: 'PEARLUSDT', side: 'sell', created_at: Date.parse('2026-11-06T12:00:00Z'), amount: '4', total: '8', value: '8' },
      { id: 2, market: 'PEARLUSDT', side: 'buy', created_at: Date.parse('2026-11-06T13:00:00Z'), amount: '100', total: '900', value: '900' },
      { id: 3, market: 'PEARLBTC', side: 'sell', created_at: Date.parse('2026-11-06T14:00:00Z'), amount: '100', total: '1', value: '1' },
    ];
    const markets = ['USDT', 'BTC'].map((quote) => ({
      id: `PEARL${quote}`, market: `PEARL${quote}`, base_unit: 'PEARL', quote_unit: quote, base_ccy: 'PEARL', quote_ccy: quote,
    }));
    f.activity(exchange === 'safetrade'
      ? normalizeSafeTradeActivity({ coin: 'PEARL', trades, markets })
      : normalizeCoinExActivity({ coin: 'PEARL', deals: trades, markets }));
    const result = await f.run(['--format', 'csv']);
    assert.equal(result.code, 0, result.error);
    assert.deepEqual(summaries(result)[0], ['SUM', '2', '2', '4', '0', '4']);
  });
}
