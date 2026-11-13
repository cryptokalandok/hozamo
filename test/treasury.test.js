import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { readTreasury, recordTreasury, treasuryBalance, withTreasury } from '../src/treasury.js';

const execFileAsync = promisify(execFile);
const NOW = Date.parse('2026-11-07T12:00:00Z');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hozamo-treasury-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'treasury.json');
  const orders = [];
  const client = {
    displayName: 'Test exchange',
    getBalance: async () => ({ available: '10', locked: '0', total: '10' }),
    getPrice: async () => ({ price: '2' }),
    getMarketInfo: async () => ({ basePrecision: 4, quotePrecision: 8, minAmount: '0.0001' }),
    getAssetActivity: async () => ({ deposits: [], withdrawals: [], swaps: [] }),
    createOrder: async (order) => { orders.push(order); return { id: 123, state: 'pending' }; },
    ...overrides,
  };
  async function run(args, extra = {}) {
    const output = [], errors = [];
    const code = await runCli(args, {
      env: {}, cwd: root, instanceDir: root, now: () => NOW,
      clientFactory: () => client, setDnsResultOrder: () => {},
      stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
      confirm: async () => { throw new Error('Unexpected confirmation'); },
      ...extra,
    });
    return { code, output: output.join('\n'), error: errors.join('\n') };
  }
  async function reserve(amount = '2', exchange = 'safetrade', coin = 'PEARL') {
    const result = await run(['treasury', 'add', '--exchange', exchange, '--coin', coin, '--amount', amount]);
    assert.equal(result.code, 0, result.error);
  }
  function sell(sizing = ['--balance-percent', '100'], extra = []) {
    return ['order', '--exchange', 'safetrade', '--pair', 'PEARL-USDT', '--type', 'market',
      '--side', 'sell', ...sizing, ...extra];
  }
  return { root, path, orders, client, run, reserve, sell, state: () => readTreasury(path) };
}

test('treasury add accumulates exact decimals and UTC ledger entries; free supports amount and percent', async (t) => {
  const f = fixture(t);
  await f.reserve('0.1');
  await f.reserve('0.2');
  let state = await f.state();
  assert.equal(state.balances.safetrade.PEARL, '0.3');
  assert.deepEqual(state.ledger.map((e) => [e.action, e.amount, e.before, e.after, e.at]), [
    ['add', '0.1', '0', '0.1', '2026-11-07T12:00:00.000Z'],
    ['add', '0.2', '0.1', '0.3', '2026-11-07T12:00:00.000Z'],
  ]);
  assert.notEqual(state.ledger[0].id, state.ledger[1].id);
  const offline = { clientFactory: () => { throw new Error('Must not create an API client'); } };
  const free = ['treasury', 'free', '--coin', 'PEARL'];
  assert.equal((await f.run([...free, '--amount', '0.1'], offline)).code, 0);
  assert.equal((await f.run([...free, '--amount-percentage', '12.5'], offline)).code, 0);
  state = await f.state();
  assert.equal(state.balances.safetrade.PEARL, '0.175');
  assert.equal(state.ledger.at(-1).amount, '0.025');
  assert.equal((await f.run([...free, '--amount-percentage', '100'], offline)).code, 0);
  assert.equal((await f.state()).balances.safetrade.PEARL, '0');
  assert.equal((await f.state()).ledger.length, 5);
});

test('exchange and coin reserves are independent', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  await f.reserve('3', 'coinex');
  await f.reserve('4', 'safetrade', 'BTC');
  const result = await f.run(['treasury', 'free', '--coin', 'PEARL', '--amount-percentage', '100']);
  assert.equal(result.code, 0);
  assert.deepEqual((await f.state()).balances, {
    safetrade: { PEARL: '0', BTC: '4' }, coinex: { PEARL: '3' },
  });
});

test('add accumulates an unfunded target offline without creating an API client', async (t) => {
  const f = fixture(t);
  const offline = { clientFactory: () => { throw new Error('Must not create an API client'); } };
  for (const exchange of ['safetrade', 'coinex']) {
    for (let i = 0; i < 2; i += 1) {
      const result = await f.run(['treasury', 'add', '--exchange', exchange,
        '--coin', 'PEARL', '--amount', '2'], offline);
      assert.equal(result.code, 0, result.error);
    }
    assert.equal(treasuryBalance(await f.state(), exchange, 'PEARL'), '4');
  }
  assert.equal((await f.state()).ledger.length, 4);
});

for (const exchange of ['safetrade', 'coinex']) {
  for (const type of ['market', 'limit']) {
    test(`${exchange} ${type} order protects an unfunded target until deposits exceed it`, async (t) => {
      let available = '1.9921177';
      const f = fixture(t, { getBalance: async () => ({ available }) });
      await f.reserve('2', exchange);
      const args = ['order', '--exchange', exchange, '--type', type, '--side', 'sell',
        '--pair', 'PEARL-USDT', '--balance-percent', '100', '--yes',
        ...(type === 'limit' ? ['--price-percent', '0'] : [])];
      for (const balance of ['1.9921177', '0', '2']) {
        available = balance;
        assert.equal((await f.run(args)).code, 1);
        assert.equal(f.orders.length, 0);
      }
      available = '5';
      const result = await f.run(args);
      assert.equal(result.code, 0, result.error);
      assert.equal(f.orders.length, 1);
      assert.equal(f.orders[0].amount, '3');
      assert.equal(treasuryBalance(await f.state(), exchange, 'PEARL'), '2');
      assert.equal((await f.state()).ledger.length, 1);
    });
  }
}

test('invalid selectors and over-release leave the ledger unchanged', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const before = readFileSync(f.path, 'utf8');
  const cases = [
    ['add'], ['add', '--amount', '-1'], ['add', '--amount', '0'], ['add', '--amount', 'NaN'],
    ['add', '--amount-percentage', '10'],
    ['free'], ['free', '--amount', '3'], ['free', '--amount-percentage', '101'],
    ['free', '--amount-percentage', '0'], ['free', '--amount-percentage', '-1'],
    ['free', '--amount', '1', '--amount-percentage', '50'], ['show', '--amount', '1'],
  ];
  for (const [action, ...options] of cases) {
    const result = await f.run(['treasury', action, '--coin', 'PEARL', ...options]);
    assert.equal(result.code, 1, JSON.stringify([action, options]));
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('show and freeing an empty treasury work offline without creating a state file', async (t) => {
  const f = fixture(t);
  const offline = { clientFactory: () => { throw new Error('No network'); } };
  const result = await f.run(['treasury', 'show', '--coin', 'PEARL'], offline);
  assert.equal(result.code, 0);
  assert.match(result.output, /safetrade\s+PEARL\s+0/);
  assert.equal((await f.run(['treasury', 'free', '--coin', 'PEARL', '--amount-percentage', '100'], offline)).code, 0);
  assert.equal(existsSync(f.path), false);
});

for (const exchange of ['safetrade', 'coinex']) {
  for (const type of ['market', 'limit']) {
    test(`${exchange} ${type} sell sizes from spendable balance and preserves the treasury`, async (t) => {
      const f = fixture(t);
      await f.reserve('2', exchange);
      const result = await f.run([
        'order', '--exchange', exchange, '--type', type, '--side', 'sell', '--pair', 'PEARL-USDT',
        '--balance-percent', '50', '--yes', ...(type === 'limit' ? ['--price-percent', '0'] : []),
      ]);
      assert.equal(result.code, 0, result.error);
      assert.equal(f.orders[0].amount, '4');
      assert.equal(treasuryBalance(await f.state(), exchange, 'PEARL'), '2');
      assert.equal((await f.state()).ledger.length, 1);
      assert.match(result.output, /10 - 2 treasury = 8 PEARL/);
    });
  }
}

test('exact amount and target proceeds cannot consume treasury, while the spendable boundary is allowed', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  for (const sizing of [['--amount', '8.0001'], ['--receive', '17']]) {
    const result = await f.run(f.sell(sizing, ['--yes']));
    assert.equal(result.code, 1);
    assert.match(result.error, /Insufficient PEARL balance: 8/);
  }
  assert.equal(f.orders.length, 0);
  assert.equal((await f.run(f.sell(['--amount', '8'], ['--yes']))).code, 0);
  assert.equal(f.orders[0].amount, '8');
});

test('fully reserved or externally depleted balances do not result in orders', async (t) => {
  const f = fixture(t);
  await f.reserve('10');
  for (const available of ['10', '5']) {
    f.client.getBalance = async () => ({ available });
    assert.equal((await f.run(f.sell(undefined, ['--yes']))).code, 1);
  }
  assert.equal(f.orders.length, 0);
  assert.equal((await f.state()).balances.safetrade.PEARL, '10');
});

test('--ignore-treasury warns with --yes, resets all of the spent reserve after acceptance and records the ID', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  await f.reserve('3', 'coinex');
  const result = await f.run(f.sell(['--amount', '1'], ['--ignore-treasury', '--yes']));
  assert.equal(result.code, 0, result.error);
  assert.match(result.output, /WARNING: --ignore-treasury/);
  assert.match(result.output, /will be reset to 0/);
  assert.equal(f.orders[0].amount, '1');
  const state = await f.state();
  assert.equal(state.balances.safetrade.PEARL, '0');
  assert.equal(state.balances.coinex.PEARL, '3');
  assert.deepEqual([state.ledger.at(-1).action, state.ledger.at(-1).amount, state.ledger.at(-1).orderId],
    ['ignore', '2', '123']);
});

test('ignore can spend all funds, but never suppresses confirmation', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  let asked = 0;
  const result = await f.run(f.sell(undefined, ['--ignore-treasury']), {
    confirm: async () => { asked++; return true; },
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(asked, 1);
  assert.equal(f.orders[0].amount, '10');
});

test('dryrun and declined confirmation do not change treasury or submit orders', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const before = readFileSync(f.path, 'utf8');
  for (const flags of [['--ignore-treasury', '--dryrun', '--yes'], ['--ignore-treasury']]) {
    const result = await f.run(f.sell(undefined, flags), { confirm: async () => false });
    assert.equal(result.code, 0, result.error);
    assert.match(result.output, /WARNING/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
  assert.equal(f.orders.length, 0);
});

test('API errors, rejected responses and ambiguous acceptance never reset the treasury', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const before = readFileSync(f.path, 'utf8');
  for (const createOrder of [
    async () => { throw new Error('HTTP 422'); },
    async () => { throw new Error('Request timed out'); },
    async () => ({ id: 123, state: 'rejected' }),
    async () => ({ id: 123, state: 'cancel' }),
    async () => ({}),
  ]) {
    f.client.createOrder = createOrder;
    const result = await f.run(f.sell(undefined, ['--ignore-treasury', '--yes']));
    assert.equal(result.code, 1);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('a reset save failure reports the already accepted order and does not silently erase the old file', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const original = readFileSync(f.path, 'utf8');
  f.client.createOrder = async () => {
    // Make rename fail even when tests run with elevated filesystem permissions.
    rmSync(f.path);
    mkdirSync(f.path);
    writeFileSync(join(f.path, 'original-backup.json'), original);
    return { id: 123, state: 'pending' };
  };
  const result = await f.run(f.sell(undefined, ['--ignore-treasury', '--yes']));
  assert.equal(result.code, 1);
  assert.match(result.error, /Order 123 was accepted, but treasury reset failed/);
  assert.match(result.error, /Do NOT resubmit/);
  assert.equal(readFileSync(join(f.path, 'original-backup.json'), 'utf8'), original);
});

test('buy orders protect the spent quote reserve without freeing the purchased coin reserve', async (t) => {
  const f = fixture(t);
  await f.reserve('2', 'safetrade', 'USDT');
  await f.reserve('3');
  const buy = ['order', '--type', 'limit', '--side', 'buy', '--pair', 'PEARL-USDT', '--price', '2'];
  let result = await f.run([...buy, '--balance-percent', '100', '--reserve-percent', '0', '--yes']);
  assert.equal(result.code, 0, result.error);
  assert.equal(f.orders[0].amount, '4');
  result = await f.run([...buy, '--amount', '4.1', '--yes']);
  assert.equal(result.code, 1);
  assert.equal(f.orders.length, 1);
  result = await f.run([...buy, '--amount', '1', '--ignore-treasury', '--yes']);
  assert.equal(result.code, 0, result.error);
  assert.equal((await f.state()).balances.safetrade.USDT, '0');
  assert.equal((await f.state()).balances.safetrade.PEARL, '3');
});

test('market buys with a quote treasury require a bounded quote-denominated budget', async (t) => {
  const f = fixture(t);
  await f.reserve('2', 'safetrade', 'USDT');
  const buy = ['order', '--type', ' MARKET ', '--side', 'buy', '--pair', 'PEARL-USDT', '--balance-percent', '100', '--yes'];
  const unsafe = await f.run(buy);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.error, /base-denominated market buy/);
  assert.equal(f.orders.length, 0);
  await f.reserve('2', 'coinex', 'USDT');
  f.client.getMarketInfo = async () => ({ basePrecision: 4, quotePrecision: 8, marketBuyAmountAsset: 'quote' });
  const bounded = await f.run([...buy, '--exchange', 'coinex']);
  assert.equal(bounded.code, 0, bounded.error);
  assert.equal(f.orders[0].amountAsset, 'USDT');
  assert.equal(f.orders[0].amount, '7.96');
});

test('stats shows current treasury only in SUM, independently of date filters/grouping/zero hiding', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  for (const group of ['day', 'week', 'month']) {
    const result = await f.run(['stats', '--coin', 'PEARL', '--from', '2026-01-01', '--to', '2026-01-02',
      '--group-by', group, '--treasury', '--format', 'csv', '--hide-withdrawals', '--average-price']);
    assert.equal(result.code, 0, result.error);
    const [header, sum, ...rows] = result.output.split('\n');
    assert.match(header, /PEARL TREASURY$/);
    assert.match(sum, /^SUM,.*?,2$/);
    for (const row of rows) {
      assert.equal(row.split(',').at(-1), '0');
      assert.equal(row.split(',').length, header.split(',').length);
    }
  }
  const hidden = await f.run(['stats', '--coin', 'PEARL', '--days', '3', '--treasury', '--hide-zero-days', '--format', 'csv']);
  assert.equal(hidden.output.split('\n').length, 3);
  assert.match(hidden.output, /2026-11-07,0,0,0,2$/);
  const table = await f.run(['stats', '--coin', 'PEARL', '--days', '1', '--treasury']);
  assert.match(table.output, /PEARL TREASURY/);
  assert.match(table.output, /SUM\s+0\s+0\s+0\s+2/);
});

test('malformed or inconsistent treasury fails closed for orders, including ignore, and for modifications', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const valid = await f.state();
  const bad = structuredClone(valid);
  bad.balances.safetrade.PEARL = '1';
  const missing = structuredClone(valid);
  delete missing.balances.safetrade.PEARL;
  const duplicate = structuredClone(valid);
  duplicate.ledger.push(duplicate.ledger[0]);
  for (const contents of ['{', JSON.stringify({ version: 99 }), JSON.stringify(bad), JSON.stringify(missing), JSON.stringify(duplicate)]) {
    writeFileSync(f.path, contents);
    for (const args of [f.sell(undefined, ['--yes']), f.sell(undefined, ['--ignore-treasury', '--yes']),
      ['treasury', 'add', '--coin', 'PEARL', '--amount', '1']]) {
      const result = await f.run(args);
      assert.equal(result.code, 1);
      assert.match(result.error, /Invalid treasury file/);
      assert.equal(readFileSync(f.path, 'utf8'), contents);
    }
  }
  assert.equal(f.orders.length, 0);
});

test('treasury path is stable across working directories and can be overridden', async (t) => {
  const f = fixture(t);
  const cwd = join(f.root, 'other-working-directory');
  mkdirSync(cwd);
  await f.reserve('2');
  const result = await f.run(f.sell(undefined, ['--yes']), { cwd });
  assert.equal(result.code, 0, result.error);
  assert.equal(f.orders[0].amount, '8');
  const alternate = join(f.root, 'alternate.json');
  const show = await f.run(['treasury', 'show', '--coin', 'PEARL'], {
    env: { HOZAMO_TREASURY_FILE: alternate },
  });
  assert.match(show.output, /PEARL\s+0/);
  assert.match(show.output, /alternate.json/);
  const standalone = await f.run(['treasury', 'show', '--coin', 'PEARL'], {
    instanceDir: undefined, executableDir: f.root, cwd,
  });
  assert.match(standalone.output, /PEARL\s+2/);
});

test('lock is held across order submission; concurrent add/free/order cannot race', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  f.client.createOrder = async () => { signalStarted(); await wait; return { id: 123 }; };
  const running = f.run(f.sell(undefined, ['--ignore-treasury', '--yes']));
  await started;
  try {
    for (const args of [f.sell(undefined, ['--yes']),
      ['treasury', 'add', '--coin', 'PEARL', '--amount', '1'],
      ['treasury', 'free', '--coin', 'PEARL', '--amount', '1']]) {
      const result = await f.run(args);
      assert.equal(result.code, 1);
      assert.match(result.error, /Treasury is locked/);
    }
  } finally {
    finish();
  }
  assert.equal((await running).code, 0);
  assert.equal((await f.state()).balances.safetrade.PEARL, '0');
  assert.equal(existsSync(`${f.path}.lock`), false);
});

test('lock excludes another OS process and never automatically removes a stale lock', async (t) => {
  const f = fixture(t);
  await f.reserve('2');
  const moduleUrl = new URL('../src/treasury.js', import.meta.url).href;
  await withTreasury(f.path, async () => {
    const script = `import { withTreasury } from ${JSON.stringify(moduleUrl)};
      try { await withTreasury(process.argv[1], async () => {}); process.exitCode = 2; }
      catch (e) { if (!e.message.includes('Treasury is locked')) throw e; console.log('LOCKED'); }`;
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, f.path]);
    assert.equal(result.stdout.trim(), 'LOCKED');
  });
  writeFileSync(`${f.path}.lock`, '{"pid":99999999,"at":"2000-01-01T00:00:00Z"}');
  const result = await f.run(f.sell(undefined, ['--yes']));
  assert.equal(result.code, 1);
  assert.match(result.error, /verify it has stopped/);
  assert.equal(existsSync(`${f.path}.lock`), true);
});

test('100% free is exact for sub-satoshi reserves and ledger round-trips', async (t) => {
  const f = fixture(t);
  await f.reserve('0.0000000000000000000000000001');
  const result = await f.run(['treasury', 'free', '--coin', 'PEARL', '--amount-percentage', '100']);
  assert.equal(result.code, 0, result.error);
  const state = await f.state();
  assert.equal(state.balances.safetrade.PEARL, '0');
  assert.equal(state.ledger.at(-1).amount, '0.0000000000000000000000000001');
});

async function seedTreasury(f, entries) {
  await withTreasury(f.path, async (state, save) => {
    for (const entry of entries) {
      recordTreasury(state, { exchange: 'safetrade', coin: 'PEARL', action: 'add', ...entry });
    }
    await save();
  });
}

function csvObjects(output) {
  const [header, ...rows] = output.split('\n').map(line => line.split(','));
  return rows.map(row => Object.fromEntries(header.map((key, i) => [key, row[i]])));
}

test('treasury net changes include releases and resets within UTC period boundaries across all groupings', async (t) => {
  const f = fixture(t, {
    getAssetActivity: async () => ({
      deposits: [], swaps: [],
      withdrawals: [{ timestamp: Date.parse('2026-11-04T10:00:00Z'), amount: '1' }],
    }),
  });
  await seedTreasury(f, [
    { at: '2026-10-30T23:59:59.999Z', amount: '4' }, // outside requested range
    { at: '2026-10-31T00:00:00.000Z', amount: '0.1' },
    { at: '2026-11-01T00:30:00+01:00', amount: '0.2' }, // still October in UTC
    { at: '2026-11-01T00:00:00.000Z', amount: '0.4' },
    { at: '2026-11-02T23:59:59.999Z', amount: '2' },
    { at: '2026-11-03T10:00:00Z', action: 'free', amount: '0.2' },
    { at: '2026-11-04T10:00:00Z', action: 'ignore', amount: '6.5', orderId: '42' },
    { at: '2026-11-05T00:00:00.000Z', amount: '9' }, // outside; current balance is 9
    { at: '2026-11-01T12:00:00Z', amount: '100', coin: 'BTC' },
    { at: '2026-11-01T12:00:00Z', amount: '100', exchange: 'coinex' },
  ]);
  const before = readFileSync(f.path, 'utf8');
  const base = ['stats', '--exchange', 'safetrade', '--coin', 'PEARL', '--from', '2026-10-31',
    '--to', '2026-11-04', '--hide-zero-days', '--average-price', '--hide-withdrawals'];
  const expected = {
    day: [['2026-10-31', '0.3'], ['2026-11-01', '0.4'], ['2026-11-02', '2'],
      ['2026-11-03', '-0.2'], ['2026-11-04', '-6.5']],
    week: [['2026-W44', '0.7'], ['2026-W45', '-4.7']],
    month: [['2026-10', '0.3'], ['2026-11', '-4.3']],
  };
  for (const [group, pairs] of Object.entries(expected)) {
    const result = await f.run([...base, '--treasury', '--group-by', group, '--format', 'csv']);
    assert.equal(result.code, 0, result.error);
    const rows = csvObjects(result.output);
    const label = { day: 'DATE', week: 'ISO WEEK', month: 'MONTH' }[group];
    assert.equal(rows[0][label], 'SUM');
    assert.equal(rows[0]['PEARL TREASURY'], '9');
    assert.deepEqual(rows.slice(1).map(row => [row[label], row['PEARL TREASURY']]), pairs);
    assert.equal(result.output.split('\n')[0].split(',').filter(h => h.includes('TREASURY')).length, 1);
  }
  const table = await f.run([...base, '--treasury']);
  assert.equal(table.code, 0, table.error);
  assert.match(table.output, /PEARL TREASURY/);
  assert.match(table.output, /2026-10-31\s+0\s+0\s+[^\n]*0\.3/);
  assert.match(table.output, /^2026-11-03\s+[^\n]*-0\.2\s*$/m);
  assert.match(table.output, /^2026-11-04\s+[^\n]*-6\.5\s*$/m);
  const noTreasury = await f.run([...base, '--format', 'csv']);
  assert.equal(noTreasury.code, 0, noTreasury.error);
  assert.doesNotMatch(noTreasury.output, /TREASURY/);
  assert.equal(noTreasury.output.split('\n').length, 2);
  assert.equal(readFileSync(f.path, 'utf8'), before);
});

test('treasury additions work on CoinEx and --days excludes events beyond now', async (t) => {
  const f = fixture(t);
  await seedTreasury(f, [
    { exchange: 'coinex', at: '2026-11-05T23:59:59.999Z', amount: '3' },
    { exchange: 'coinex', at: '2026-11-06T00:00:00.000Z', amount: '0.000000000000000001' },
    { exchange: 'coinex', at: '2026-11-07T12:00:00.000Z', amount: '0.000000000000000002' },
    { exchange: 'coinex', at: '2026-11-07T12:00:00.001Z', amount: '1' },
  ]);
  const result = await f.run(['stats', '--exchange', 'coinex', '--coin', 'PEARL', '--days', '2',
    '--treasury', '--format', 'csv', '--hide-zero-days']);
  assert.equal(result.code, 0, result.error);
  const rows = csvObjects(result.output);
  assert.equal(rows[0]['PEARL TREASURY'], '4.000000000000000003');
  assert.deepEqual(rows.slice(1).map(r => [r.DATE, r['PEARL TREASURY']]), [
    ['2026-11-06', '0.000000000000000001'], ['2026-11-07', '0.000000000000000002'],
  ]);
});

test('stats handles missing treasury and rejects a corrupt ledger only when requested', async (t) => {
  const f = fixture(t);
  const args = ['stats', '--coin', 'PEARL', '--days', '2', '--format', 'csv'];
  let result = await f.run([...args, '--treasury']);
  assert.equal(result.code, 0, result.error);
  let rows = csvObjects(result.output);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['PEARL TREASURY'], '0');
  for (const row of rows) assert.equal(row['PEARL TREASURY'], '0');
  result = await f.run([...args, '--treasury', '--hide-zero-days']);
  assert.equal(csvObjects(result.output).length, 1);
  assert.equal(existsSync(f.path), false);
  writeFileSync(f.path, '{broken');
  result = await f.run([...args, '--treasury']);
  assert.equal(result.code, 1);
  assert.match(result.error, /Invalid treasury file/);
  assert.equal((await f.run(args)).code, 0);
});

for (const exchange of ['safetrade', 'coinex']) {
  test(`${exchange} daily, weekly and monthly net treasury reconciles 20 added minus 6 freed to 14`, async (t) => {
    const f = fixture(t);
    await seedTreasury(f, [
      { exchange, at: '2026-11-07T06:00:00Z', amount: '6' },
      { exchange, at: '2026-11-08T06:00:00Z', action: 'free', amount: '2' },
      { exchange, at: '2026-11-09T06:00:00Z', amount: '6' },
      { exchange, at: '2026-11-09T07:00:00Z', action: 'free', amount: '4' },
      { exchange, at: '2026-11-10T06:00:00Z', amount: '4' },
      { exchange, at: '2026-11-11T06:00:00Z', amount: '2' },
      { exchange, at: '2026-11-12T06:00:00Z', amount: '2' },
    ]);
    const expected = {
      day: [['2026-11-07', '6'], ['2026-11-08', '-2'], ['2026-11-09', '2'],
        ['2026-11-10', '4'], ['2026-11-11', '2'], ['2026-11-12', '2']],
      week: [['2026-W45', '4'], ['2026-W46', '10']],
      month: [['2026-11', '14']],
    };
    const before = readFileSync(f.path, 'utf8');
    for (const [group, pairs] of Object.entries(expected)) {
      const result = await f.run(['stats', '--exchange', exchange, '--coin', 'PEARL',
        '--from', '2026-11-06', '--to', '2026-11-30', '--hide-zero-days', '--average-price',
        '--hide-withdrawals', '--treasury', '--group-by', group, '--format', 'csv']);
      assert.equal(result.code, 0, result.error);
      const rows = csvObjects(result.output);
      const label = { day: 'DATE', week: 'ISO WEEK', month: 'MONTH' }[group];
      assert.equal(rows[0]['PEARL TREASURY'], '14');
      assert.deepEqual(rows.slice(1).map(row => [row[label], row['PEARL TREASURY']]), pairs);
      // The test fixture uses whole coins, so BigInt independently checks reconciliation.
      assert.equal(rows.slice(1).reduce((total, row) => total + BigInt(row['PEARL TREASURY']), 0n), 14n);
    }
    assert.equal(readFileSync(f.path, 'utf8'), before);
  });
}

test('same-day release/reset and re-add use exact decimals and zero-net periods can be hidden', async (t) => {
  const f = fixture(t);
  await seedTreasury(f, [
    { at: '2026-11-01T00:00:00Z', amount: '1' },
    { at: '2026-11-07T08:00:00Z', amount: '0.1' },
    { at: '2026-11-07T09:00:00Z', action: 'free', amount: '0.3' },
    { at: '2026-11-07T10:00:00Z', amount: '0.200000000000000001' },
    { at: '2026-11-08T08:00:00Z', action: 'ignore', amount: '1.000000000000000001', orderId: '9' },
    { at: '2026-11-08T09:00:00Z', amount: '0.1' },
    { at: '2026-11-09T08:00:00Z', amount: '2' },
    { at: '2026-11-09T09:00:00Z', action: 'free', amount: '2' },
  ]);
  const args = ['stats', '--coin', 'PEARL', '--from', '2026-11-07', '--to', '2026-11-09',
    '--treasury', '--format', 'csv'];
  let result = await f.run(args);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(csvObjects(result.output).map(row => [row.DATE, row['PEARL TREASURY']]), [
    ['SUM', '0.1'], ['2026-11-07', '0.000000000000000001'],
    ['2026-11-08', '-0.900000000000000001'], ['2026-11-09', '0'],
  ]);
  result = await f.run([...args, '--hide-zero-days']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(csvObjects(result.output).map(row => row.DATE), ['SUM', '2026-11-07', '2026-11-08']);
  result = await f.run([...args, '--hide-zero-days', '--group-by', 'week']);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(csvObjects(result.output).map(row => [row['ISO WEEK'], row['PEARL TREASURY']]), [
    ['SUM', '0.1'], ['2026-W45', '-0.9'],
  ]);
});
