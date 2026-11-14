import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { recordTreasury, withTreasury } from '../src/treasury.js';
import { remainingTreasuryLots } from '../src/treasury-cost.js';
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
  async function run(args = [], overrides = {}) {
    const output = [], errors = [];
    const code = await runCli(['treasury', 'cost', '--exchange', exchange, '--coin', 'PEARL', ...args], {
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
  return { root, path, queries, seed, run, activity: (value) => { activity = value; } };
}

for (const exchange of ['safetrade', 'coinex']) {
  test(`${exchange} cost values the remaining 16 coins at weighted daily prices after a FIFO release`, async (t) => {
    const f = fixture(t, exchange);
    await f.seed([
      { at: '2026-11-06T08:00:00Z', amount: '10' },
      { at: '2026-11-07T08:00:00Z', amount: '10' },
      { at: '2026-11-08T08:00:00Z', action: 'free', amount: '4' },
      { at: '2026-11-06T00:00:00Z', coin: 'BTC', amount: '999' },
      { at: '2026-11-06T00:00:00Z', exchange: exchange === 'coinex' ? 'safetrade' : 'coinex', amount: '999' },
    ]);
    f.activity({
      deposits: [{ timestamp: NOW, amount: '99999' }], withdrawals: [],
      swaps: [
        swap('2026-11-05T23:59:59Z', '1', '999'),
        swap('2026-11-06T00:00:00Z', '1', '1'),
        swap('2026-11-06T23:59:59Z', '3', '7'), // (1 + 7) / (1 + 3) = 2, not 1.66667
        swap('2026-11-06T12:00:00Z', '100', '1', 'BTC'),
        swap('2026-11-07T12:00:00Z', '2', '6'),
        swap('2026-11-08T00:00:00Z', '1', '999'),
      ],
    });
    const before = readFileSync(f.path, 'utf8');
    // A read-only snapshot must also work while another operation holds the lock.
    writeFileSync(`${f.path}.lock`, 'another process');
    const csv = await f.run(['--format', 'csv']);
    assert.equal(csv.code, 0, csv.error);
    assert.equal(csv.output, [
      'DATE,PEARL TREASURY,AVG SELL PRICE (USDT/PEARL),EST. FOREGONE USDT (GROSS)',
      'SUM,16,2.625,42',
      '2026-11-06,6,2,12',
      '2026-11-07,10,3,30',
    ].join('\n'));
    assert.deepEqual(f.queries, [{
      coin: 'PEARL', startTime: Date.parse('2026-11-06T00:00:00Z'), endTime: Date.parse('2026-11-08T00:00:00Z'),
    }]);
    const table = await f.run();
    assert.equal(table.code, 0, table.error);
    assert.match(table.output, /SUM\s+16\s+2\.625\s+42/);
    assert.match(table.output, /Priced: 16 PEARL; unpriced: 0 PEARL; known subtotal: 42 USDT/);
    assert.match(table.output, /FIFO/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
    assert.equal(readFileSync(`${f.path}.lock`, 'utf8'), 'another process');
  });
}

test('FIFO follows ledger order despite clock changes; reset and re-add do not resurrect old lots', () => {
  const state = { version: 1, balances: {}, ledger: [] };
  const record = (entry) => recordTreasury(state, { exchange: 'safetrade', coin: 'PEARL', ...entry });
  record({ action: 'add', amount: '0.1', at: '2026-11-08T00:00:00Z' });
  record({ action: 'add', amount: '0.2', at: '2026-11-07T00:00:00Z' });
  record({ action: 'free', amount: '0.15', at: '2026-11-09T00:00:00Z' });
  const before = JSON.stringify(state);
  assert.deepEqual(remainingTreasuryLots(state, 'safetrade', 'PEARL').map(({ date, amount }) => ({ date, amount })), [
    { date: '2026-11-07', amount: '0.15' },
  ]);
  assert.equal(JSON.stringify(state), before);
  record({ action: 'ignore', amount: '0.15', at: '2026-11-10T00:00:00Z' });
  record({ action: 'add', amount: '0.000000000000000001', at: '2026-11-10T00:00:01Z' });
  assert.deepEqual(remainingTreasuryLots(state, 'safetrade', 'PEARL').map(({ date, amount }) => ({ date, amount })), [
    { date: '2026-11-10', amount: '0.000000000000000001' },
  ]);
});

test('a release spanning multiple additions leaves only the remaining day to price', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-01T00:00:00Z', amount: '2' },
    { at: '2026-11-02T00:00:00Z', amount: '3' },
    { at: '2026-11-03T00:00:00Z', amount: '4' },
    { at: '2026-11-04T00:00:00Z', action: 'free', amount: '6' },
  ]);
  f.activity({ swaps: [swap('2026-11-03T12:00:00Z', '1', '2')] });
  const result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.match(result.output, /\nSUM,3,2,6\n2026-11-03,3,2,6$/);
  assert.equal(f.queries[0].startTime, Date.parse('2026-11-03T00:00:00Z'));
});

test('missing USDT prices are N/A, and incomplete totals expose only a known subtotal', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-06T08:00:00Z', amount: '10' },
    { at: '2026-11-07T08:00:00Z', amount: '6' },
  ]);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '2', '4'), swap('2026-11-07T12:00:00Z', '5', '1', 'BTC')] });
  const table = await f.run();
  assert.equal(table.code, 0, table.error);
  assert.match(table.output, /SUM\s+16\s+N\/A\s+N\/A/);
  assert.match(table.output, /Priced: 10 PEARL; unpriced: 6 PEARL; known subtotal: 20 USDT/);
  const csv = await f.run(['--format', 'csv']);
  assert.equal(csv.code, 0, csv.error);
  assert.match(csv.output, /\nSUM,16,N\/A,N\/A\n2026-11-06,10,2,20\n2026-11-07,6,N\/A,N\/A$/);
  f.activity({ swaps: [] });
  const allMissing = await f.run();
  assert.equal(allMissing.code, 0, allMissing.error);
  assert.match(allMissing.output, /Priced: 0 PEARL; unpriced: 16 PEARL; known subtotal: 0 USDT/);
  assert.match(allMissing.output, /SUM\s+16\s+N\/A\s+N\/A/);
});

test('UTC dates group additions; today includes executed trades only up to the captured current time', async (t) => {
  const f = fixture(t);
  await f.seed([
    { at: '2026-11-14T00:30:00+01:00', amount: '1' }, // Nov 13 UTC
    { at: '2026-11-13T23:45:00Z', amount: '2' },
    { at: '2026-11-14T01:00:00Z', amount: '4' },
  ]);
  f.activity({ swaps: [
    swap('2026-11-13T12:00:00Z', '1', '2'),
    swap('2026-11-14T12:00:00Z', '1', '3'),
    swap('2026-11-14T12:00:00.001Z', '1', '999'),
  ] });
  const result = await f.run(['--format', 'csv']);
  assert.equal(result.code, 0, result.error);
  assert.match(result.output, /\nSUM,7,2\.57143,18\n2026-11-13,3,2,6\n2026-11-14,4,3,12$/);
  assert.equal(f.queries[0].endTime, NOW + 1);
});

test('precision is retained through weighting, then rounded for display without rounding coin amounts', async (t) => {
  const f = fixture(t);
  await f.seed([{ at: '2026-11-06T08:00:00Z', amount: '3' }]);
  f.activity({ swaps: [swap('2026-11-06T12:00:00Z', '3', '2')] });
  for (const [args, price] of [[[], '0.66667'], [['--decimals', '8'], '0.66666667'], [['--decimals', '0'], '1']]) {
    const result = await f.run(['--format', 'csv', ...args]);
    assert.equal(result.code, 0, result.error);
    assert.ok(result.output.endsWith(`\nSUM,3,${price},2\n2026-11-06,3,${price},2`));
  }
  await f.seed([
    { at: '2026-11-07T00:00:00Z', action: 'ignore', amount: '3' },
    { at: '2026-11-07T01:00:00Z', amount: '0.000000000000000001' },
  ]);
  f.activity({ swaps: [swap('2026-11-07T12:00:00Z', '1', '2')] });
  const tiny = await f.run(['--format', 'csv', '--decimals', '20']);
  assert.equal(tiny.code, 0, tiny.error);
  assert.match(tiny.output, /\nSUM,0\.000000000000000001,2,0\.000000000000000002\n/);
});

test('missing, fully freed and reset treasuries need no client, create no file, and cost nothing', async (t) => {
  const f = fixture(t);
  const offline = { clientFactory: () => { throw new Error('Must not create a client'); } };
  const empty = await f.run(['--format', 'csv'], offline);
  assert.equal(empty.code, 0, empty.error);
  assert.ok(empty.output.endsWith('\nSUM,0,N/A,0'));
  assert.equal(existsSync(f.path), false);
  for (const action of ['free', 'ignore']) {
    await f.seed([
      { at: '2026-11-06T00:00:00Z', amount: '2' },
      { at: '2026-11-07T00:00:00Z', action, amount: '2' },
    ]);
    const before = readFileSync(f.path, 'utf8');
    const result = await f.run(['--format', 'csv'], offline);
    assert.equal(result.code, 0, result.error);
    assert.ok(result.output.endsWith('\nSUM,0,N/A,0'));
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('bad options, corrupted ledgers, future additions and API failures produce no misleading report or mutations', async (t) => {
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
  assert.equal(f.queries.length, 0);
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
    assert.match(result.output, /\nSUM,2,2,4\n2026-11-06,2,2,4$/);
  });
}
