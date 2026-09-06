import {
  addDecimals,
  multiplyDecimals,
} from './decimal.js';
import { HozamoValidationError } from './errors.js';
import { normalizeAsset } from './normalizers.js';

const DAY_MS = 86_400_000;
const MAX_STATISTICS_DAYS = 10_000;
const SAFE_TRADE_DEPOSIT_SUCCESS = new Set([
  'accepted',
  'processing',
  'skipped',
  'collecting',
  'collected',
  'fee_collecting',
  'fee_processing',
  'fee_collected',
  'errored',
]);
const SAFE_TRADE_WITHDRAWAL_SUCCESS = new Set(['succeed']);
const COINEX_SUCCESS = new Set(['finish', 'finished']);

export function resolveStatisticsPeriod({ days, from, to, now = Date.now() }) {
  const hasDays = days !== undefined;
  const hasFrom = from !== undefined;
  const hasTo = to !== undefined;

  if (hasDays && (hasFrom || hasTo)) {
    throw new HozamoValidationError(
      'Use either --days or the --from/--to date range, not both',
    );
  }
  if (!hasDays && !hasFrom && !hasTo) {
    throw new HozamoValidationError(
      'Use --days or both --from and --to',
    );
  }
  if (hasFrom !== hasTo) {
    throw new HozamoValidationError(
      '--from and --to must be provided together',
    );
  }

  if (hasDays) {
    const normalizedDays = String(days).trim();
    if (!/^[1-9]\d*$/.test(normalizedDays)) {
      throw new HozamoValidationError('--days must be a positive integer');
    }
    const count = Number(normalizedDays);
    if (!Number.isSafeInteger(count)) {
      throw new HozamoValidationError('--days is too large');
    }
    if (count > MAX_STATISTICS_DAYS) {
      throw new HozamoValidationError(
        `--days must not exceed ${MAX_STATISTICS_DAYS}`,
      );
    }
    const nowMs = Number(typeof now === 'function' ? now() : now);
    if (!Number.isFinite(nowMs)) {
      throw new HozamoValidationError('Current time is invalid');
    }
    const current = new Date(nowMs);
    const todayStart = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate(),
    );
    const startTime = todayStart - ((count - 1) * DAY_MS);
    const endTime = nowMs + 1;
    return {
      startTime,
      endTime,
      from: formatUtcDate(startTime),
      to: formatUtcDate(nowMs),
    };
  }

  const startTime = parseUtcDate(from, '--from');
  const toStart = parseUtcDate(to, '--to');
  if (startTime > toStart) {
    throw new HozamoValidationError('--from must not be later than --to');
  }
  if (((toStart - startTime) / DAY_MS) + 1 > MAX_STATISTICS_DAYS) {
    throw new HozamoValidationError(
      `The statistics period must not exceed ${MAX_STATISTICS_DAYS} days`,
    );
  }
  return {
    startTime,
    endTime: toStart + DAY_MS,
    from: formatUtcDate(startTime),
    to: formatUtcDate(toStart),
  };
}

export function normalizeSafeTradeActivity({
  coin,
  deposits = [],
  withdrawals = [],
  trades = [],
  markets = [],
}) {
  const asset = normalizeAsset(coin);
  const marketMap = new Map(markets.map((market) => [
    normalizeMarketId(market.id ?? market.market),
    normalizeMarketAssets(market, ['base_unit', 'base_ccy'], ['quote_unit', 'quote_ccy']),
  ]));

  return {
    deposits: deposits
      .filter((item) => transferMatchesAsset(item, asset))
      .filter((item) => statusIn(item.status, SAFE_TRADE_DEPOSIT_SUCCESS))
      .map((item) => normalizeTransfer(
        item,
        'deposit',
        undefined,
        item.source_address ?? item.from_address ?? item.address,
      )),
    withdrawals: withdrawals
      .filter((item) => transferMatchesAsset(item, asset))
      .filter((item) => statusIn(item.status, SAFE_TRADE_WITHDRAWAL_SUCCESS))
      .map((item) => normalizeTransfer(item, 'withdrawal')),
    swaps: trades.map((trade) => normalizeSwap({
      trade,
      asset,
      market: marketMap.get(normalizeMarketId(trade.market)),
      side: trade.order_side ?? trade.side,
      timestamp: trade.created_at,
      amount: trade.amount,
      value: trade.total,
    })).filter(Boolean),
  };
}

export function normalizeCoinExActivity({
  coin,
  deposits = [],
  withdrawals = [],
  deals = [],
  markets = [],
}) {
  const asset = normalizeAsset(coin);
  const marketMap = new Map(markets.map((market) => [
    normalizeMarketId(market.market ?? market.id),
    normalizeMarketAssets(market, ['base_ccy', 'base_unit'], ['quote_ccy', 'quote_unit']),
  ]));

  return {
    deposits: deposits
      .filter((item) => transferMatchesAsset(item, asset))
      .filter((item) => statusIn(item.status, COINEX_SUCCESS))
      .map((item) => normalizeTransfer(item, 'deposit', item.actual_amount)),
    withdrawals: withdrawals
      .filter((item) => transferMatchesAsset(item, asset))
      .filter((item) => statusIn(item.status, COINEX_SUCCESS))
      .map((item) => normalizeTransfer(item, 'withdrawal')),
    swaps: deals.map((deal) => normalizeSwap({
      trade: deal,
      asset,
      market: marketMap.get(normalizeMarketId(deal.market)),
      side: deal.side,
      timestamp: deal.created_at,
      amount: deal.amount,
      value: deal.value ?? deal.filled_value,
    })).filter(Boolean),
  };
}

export function aggregateAssetStatistics({
  coin,
  startTime,
  endTime,
  activity,
}) {
  const asset = normalizeAsset(coin);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new HozamoValidationError('Statistics period is invalid');
  }

  const rowsByDate = new Map();
  const firstDay = Date.parse(`${formatUtcDate(startTime)}T00:00:00.000Z`);
  const lastIncluded = endTime - 1;
  const lastDay = Date.parse(`${formatUtcDate(lastIncluded)}T00:00:00.000Z`);
  for (let timestamp = firstDay; timestamp <= lastDay; timestamp += DAY_MS) {
    const date = formatUtcDate(timestamp);
    rowsByDate.set(date, emptyRow(date));
  }

  for (const deposit of activity.deposits ?? []) {
    addDeposit(rowsByDate, deposit, startTime, endTime);
  }
  for (const withdrawal of activity.withdrawals ?? []) {
    addEventAmount(rowsByDate, withdrawal, startTime, endTime, 'withdrawn');
  }
  for (const swap of activity.swaps ?? []) {
    if (!isInPeriod(swap.timestamp, startTime, endTime)) {
      continue;
    }
    const row = rowsByDate.get(formatUtcDate(swap.timestamp));
    if (!row) {
      continue;
    }
    row.swapped = addDecimals(row.swapped, swap.spentAmount);
    row.swappedByReceivedAsset.set(
      swap.receivedAsset,
      addDecimals(
        row.swappedByReceivedAsset.get(swap.receivedAsset) ?? '0',
        swap.spentAmount,
      ),
    );
    row.received.set(
      swap.receivedAsset,
      addDecimals(row.received.get(swap.receivedAsset) ?? '0', swap.receivedAmount),
    );
  }

  const rows = [...rowsByDate.values()];
  const receivedAssets = [...new Set(rows.flatMap((row) => (
    [...row.received.keys()]
  )))].sort();
  const sum = emptyRow('SUM');
  for (const row of rows) {
    sum.deposited = addDecimals(sum.deposited, row.deposited);
    sum.withdrawn = addDecimals(sum.withdrawn, row.withdrawn);
    sum.swapped = addDecimals(sum.swapped, row.swapped);
    for (const [receivedAsset, amount] of row.swappedByReceivedAsset) {
      sum.swappedByReceivedAsset.set(
        receivedAsset,
        addDecimals(sum.swappedByReceivedAsset.get(receivedAsset) ?? '0', amount),
      );
    }
    for (const [sourceAddress, amount] of row.depositedBySource) {
      sum.depositedBySource.set(
        sourceAddress,
        addDecimals(sum.depositedBySource.get(sourceAddress) ?? '0', amount),
      );
    }
    for (const receivedAsset of receivedAssets) {
      sum.received.set(
        receivedAsset,
        addDecimals(
          sum.received.get(receivedAsset) ?? '0',
          row.received.get(receivedAsset) ?? '0',
        ),
      );
    }
  }

  return { coin: asset, receivedAssets, sum, rows };
}

function normalizeTransfer(item, kind, preferredAmount, sourceAddress) {
  const amount = (
    preferredAmount === undefined ||
    preferredAmount === null ||
    String(preferredAmount).trim() === ''
  ) ? item.amount : preferredAmount;
  return {
    id: item.id ?? item.deposit_id ?? item.withdraw_id ?? null,
    timestamp: normalizeTimestamp(item.created_at, `${kind} created_at`),
    amount: normalizeDecimal(amount, `${kind} amount`),
    sourceAddress: normalizeOptionalAddress(sourceAddress),
  };
}

function normalizeOptionalAddress(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return String(value).trim();
}

function normalizeSwap({ trade, asset, market, side, timestamp, amount, value }) {
  if (!market) {
    return null;
  }
  const normalizedSide = String(side ?? '').trim().toLowerCase();
  const baseAmount = normalizeDecimal(amount, 'trade amount');
  const quoteAmount = value === undefined || value === null
    ? multiplyDecimals(baseAmount, normalizeDecimal(trade.price, 'trade price'))
    : normalizeDecimal(value, 'trade value');

  if (market.base === asset && normalizedSide === 'sell') {
    return {
      id: trade.id ?? trade.deal_id ?? null,
      timestamp: normalizeTimestamp(timestamp, 'trade created_at'),
      spentAmount: baseAmount,
      receivedAsset: market.quote,
      receivedAmount: quoteAmount,
    };
  }
  if (market.quote === asset && normalizedSide === 'buy') {
    return {
      id: trade.id ?? trade.deal_id ?? null,
      timestamp: normalizeTimestamp(timestamp, 'trade created_at'),
      spentAmount: quoteAmount,
      receivedAsset: market.base,
      receivedAmount: baseAmount,
    };
  }
  return null;
}

function normalizeMarketAssets(market, baseKeys, quoteKeys) {
  const base = firstValue(market, baseKeys);
  const quote = firstValue(market, quoteKeys);
  if (base === undefined || quote === undefined) {
    return null;
  }
  return { base: normalizeAsset(String(base)), quote: normalizeAsset(String(quote)) };
}

function firstValue(object, keys) {
  return keys.map((key) => object?.[key]).find(
    (value) => value !== undefined && value !== null,
  );
}

function normalizeMarketId(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[-_/\s]/g, '');
}

function normalizeTimestamp(value, name) {
  let timestamp;
  if (typeof value === 'number' || /^\d+$/.test(String(value ?? '').trim())) {
    const digits = String(value).trim();
    timestamp = Number(digits);
    if (digits.length <= 10) {
      timestamp *= 1000;
    } else if (digits.length > 13) {
      timestamp /= 10 ** (digits.length - 13);
    }
  } else {
    timestamp = Date.parse(String(value ?? ''));
  }
  if (!Number.isFinite(timestamp)) {
    throw new HozamoValidationError(`Invalid ${name}: ${value}`);
  }
  return Math.trunc(timestamp);
}

function normalizeDecimal(value, name) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new HozamoValidationError(`Invalid ${name}: ${value}`);
  }
  return normalized;
}

function statusIn(value, allowed) {
  return allowed.has(String(value ?? '').trim().toLowerCase());
}

function transferMatchesAsset(item, asset) {
  const value = item?.currency ?? item?.currency_id ?? item?.ccy ?? item?.asset;
  if (value === undefined || value === null) {
    return true;
  }
  try {
    return normalizeAsset(String(value)) === asset;
  } catch {
    return false;
  }
}

function parseUtcDate(value, option) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new HozamoValidationError(`${option} must use YYYY-MM-DD format`);
  }
  const timestamp = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || formatUtcDate(timestamp) !== normalized) {
    throw new HozamoValidationError(`${option} is not a valid calendar date`);
  }
  return timestamp;
}

function emptyRow(date) {
  return {
    date,
    deposited: '0',
    depositedBySource: new Map(),
    withdrawn: '0',
    swapped: '0',
    swappedByReceivedAsset: new Map(),
    received: new Map(),
  };
}

function addDeposit(rowsByDate, event, startTime, endTime) {
  if (!isInPeriod(event.timestamp, startTime, endTime)) {
    return;
  }
  const row = rowsByDate.get(formatUtcDate(event.timestamp));
  if (!row) {
    return;
  }
  const sourceAddress = normalizeOptionalAddress(event.sourceAddress);
  row.deposited = addDecimals(row.deposited, event.amount);
  row.depositedBySource.set(
    sourceAddress,
    addDecimals(row.depositedBySource.get(sourceAddress) ?? '0', event.amount),
  );
}

function addEventAmount(rowsByDate, event, startTime, endTime, field) {
  if (!isInPeriod(event.timestamp, startTime, endTime)) {
    return;
  }
  const row = rowsByDate.get(formatUtcDate(event.timestamp));
  if (row) {
    row[field] = addDecimals(row[field], event.amount);
  }
}

function isInPeriod(timestamp, startTime, endTime) {
  return timestamp >= startTime && timestamp < endTime;
}

function formatUtcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
