import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { addDecimals, compareDecimals, subtractDecimals } from './decimal.js';
import { HozamoValidationError } from './errors.js';

const EXCHANGES = new Set(['safetrade', 'coinex']);
const ACTIONS = new Set(['add', 'free', 'ignore']);

function emptyTreasury() {
  return { version: 1, balances: {}, ledger: [] };
}

function assertDecimal(value) {
  if (typeof value !== 'string' || !/^\d{1,100}(?:\.\d{1,100})?$/.test(value)) {
    throw new Error('Amounts must be non-negative decimal strings (up to 100 decimal places)');
  }
}

function assertKey(exchange, coin) {
  if (!EXCHANGES.has(exchange) || typeof coin !== 'string' || !/^[A-Z0-9]+$/.test(coin)) {
    throw new Error('Invalid treasury exchange or coin');
  }
}

export function treasuryBalance(state, exchange, coin) {
  return state.balances[exchange]?.[coin] ?? '0';
}

// Verify the snapshot against the entire ledger. A corrupt file must never
// silently turn a protected balance into zero.
function validate(state) {
  if (state?.version !== 1 || !state.balances || Array.isArray(state.balances) ||
      typeof state.balances !== 'object' || !Array.isArray(state.ledger)) {
    throw new Error('Unsupported treasury format');
  }
  const computed = emptyTreasury();
  const ids = new Set();
  for (const entry of state.ledger) {
    assertKey(entry.exchange, entry.coin);
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        !ACTIONS.has(entry.action) || typeof entry.at !== 'string' ||
        !Number.isFinite(Date.parse(entry.at))) {
      throw new Error('Invalid treasury ledger entry');
    }
    ids.add(entry.id);
    for (const value of [entry.amount, entry.before, entry.after]) assertDecimal(value);
    const before = treasuryBalance(computed, entry.exchange, entry.coin);
    const after = entry.action === 'add'
      ? addDecimals(before, entry.amount)
      : subtractDecimals(before, entry.amount);
    if (compareDecimals(before, entry.before) !== 0 ||
        compareDecimals(after, '0') < 0 ||
        compareDecimals(after, entry.after) !== 0 ||
        (entry.action === 'ignore' && compareDecimals(after, '0') !== 0)) {
      throw new Error('Inconsistent treasury ledger');
    }
    computed.balances[entry.exchange] ??= {};
    computed.balances[entry.exchange][entry.coin] = after;
  }
  for (const [exchange, coins] of Object.entries(state.balances)) {
    if (!EXCHANGES.has(exchange) || !coins || typeof coins !== 'object' || Array.isArray(coins)) {
      throw new Error('Invalid treasury balances');
    }
    for (const [coin, amount] of Object.entries(coins)) {
      assertKey(exchange, coin);
      assertDecimal(amount);
      if (compareDecimals(amount, treasuryBalance(computed, exchange, coin)) !== 0) {
        throw new Error('Treasury balance does not match its ledger');
      }
    }
  }
  for (const [exchange, coins] of Object.entries(computed.balances)) {
    for (const [coin, amount] of Object.entries(coins)) {
      if (state.balances[exchange]?.[coin] === undefined ||
          compareDecimals(amount, state.balances[exchange][coin]) !== 0) {
        throw new Error('Treasury ledger balance is missing from the snapshot');
      }
    }
  }
  return state;
}

export async function readTreasury(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyTreasury();
    throw new HozamoValidationError(`Cannot read treasury ${path}: ${error.message}`);
  }
  try {
    return validate(JSON.parse(contents));
  } catch (error) {
    throw new HozamoValidationError(
      `Invalid treasury file ${path}: ${error.message}. Restore a valid backup before trading.`,
    );
  }
}

export function recordTreasury(state, {
  exchange, coin, action, amount, at = new Date().toISOString(), orderId,
}) {
  assertKey(exchange, coin);
  assertDecimal(amount);
  if (!ACTIONS.has(action)) throw new Error('Invalid treasury action');
  const before = treasuryBalance(state, exchange, coin);
  if (action !== 'add' && compareDecimals(amount, before) > 0) {
    throw new HozamoValidationError(`Cannot free ${amount} ${coin}: treasury contains ${before}`);
  }
  const after = action === 'add'
    ? addDecimals(before, amount)
    : subtractDecimals(before, amount);
  state.balances[exchange] ??= {};
  state.balances[exchange][coin] = after;
  state.ledger.push({
    id: randomUUID(), at, exchange, coin, action, amount, before, after,
    ...(orderId === undefined ? {} : { orderId: String(orderId) }),
  });
  return after;
}

async function writeTreasury(path, state) {
  validate(state);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

// Hold the lock through balance lookup, confirmation and order submission too.
// Never steal a lock based on its age: a slow API call may still be in flight.
export async function withTreasury(path, operation) {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new HozamoValidationError(
        `Treasury is locked: ${lockPath}. Another command may be running. ` +
        'If a previous process crashed, verify it has stopped before removing the lock.',
      );
    }
    throw new HozamoValidationError(`Cannot lock treasury ${path}: ${error.message}`);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const state = await readTreasury(path);
    return await operation(state, () => writeTreasury(path, state));
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
