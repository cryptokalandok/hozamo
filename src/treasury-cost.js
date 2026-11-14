import { addDecimals, compareDecimals, divideDecimals, multiplyDecimals, subtractDecimals } from './decimal.js';
import { HozamoValidationError } from './errors.js';
import { aggregateAssetStatistics } from './statistics.js';
import { treasuryBalance } from './treasury.js';

// Replay a validated ledger in append order, not timestamp order (clocks can move).
// A release consumes the oldest still-held addition; a reset consumes all of them.
export function remainingTreasuryLots(state, exchange, coin) {
  const lots = [];
  let head = 0;
  for (const entry of state.ledger) {
    if (entry.exchange !== exchange || entry.coin !== coin) continue;
    if (entry.action === 'add') {
      if (compareDecimals(entry.amount, '0') > 0) {
        const timestamp = Date.parse(entry.at);
        lots.push({ timestamp, date: new Date(timestamp).toISOString().slice(0, 10), amount: entry.amount });
      }
    } else {
      let remaining = entry.amount;
      while (compareDecimals(remaining, '0') > 0) {
        const lot = lots[head];
        if (!lot) throw new HozamoValidationError('Treasury releases exceed additions');
        const consumed = compareDecimals(lot.amount, remaining) > 0 ? remaining : lot.amount;
        lot.amount = subtractDecimals(lot.amount, consumed);
        remaining = subtractDecimals(remaining, consumed);
        if (compareDecimals(lot.amount, '0') === 0) head += 1;
      }
    }
  }
  const remaining = lots.slice(head);
  const total = remaining.reduce((sum, lot) => addDecimals(sum, lot.amount), '0');
  if (compareDecimals(total, treasuryBalance(state, exchange, coin)) !== 0) {
    throw new HozamoValidationError('Remaining treasury lots do not match the current balance');
  }
  return remaining;
}

export function estimateTreasuryCost({ coin, lots, activity, startTime, endTime }) {
  // Reuse the stats trade weighting and local time filters. Transfers are irrelevant.
  const statistics = aggregateAssetStatistics({
    coin, startTime, endTime, activity: { swaps: activity.swaps ?? [] },
  });
  const salesByDate = new Map(statistics.rows.map((row) => [row.date, row]));
  const amounts = new Map();
  for (const lot of lots) {
    amounts.set(lot.date, addDecimals(amounts.get(lot.date) ?? '0', lot.amount));
  }
  let pricedAmount = '0', unpricedAmount = '0', knownValue = '0';
  const rows = [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => {
    const sales = salesByDate.get(date);
    const spent = sales?.swappedByReceivedAsset.get('USDT') ?? '0';
    if (compareDecimals(spent, '0') === 0) {
      unpricedAmount = addDecimals(unpricedAmount, amount);
      return { date, amount, price: null, value: null };
    }
    const gross = sales.received.get('USDT') ?? '0';
    const price = divideDecimals(gross, spent, 100);
    // Multiply before dividing: never multiply by an already rounded daily price.
    const value = divideDecimals(multiplyDecimals(amount, gross), spent, 100);
    pricedAmount = addDecimals(pricedAmount, amount);
    knownValue = addDecimals(knownValue, value);
    return { date, amount, price, value };
  });
  const amount = addDecimals(pricedAmount, unpricedAmount);
  const complete = compareDecimals(unpricedAmount, '0') === 0;
  const sum = {
    date: 'SUM', amount,
    price: complete && compareDecimals(amount, '0') > 0 ? divideDecimals(knownValue, amount, 100) : null,
    value: complete ? knownValue : null,
  };
  return { rows, sum, pricedAmount, unpricedAmount, knownValue };
}
