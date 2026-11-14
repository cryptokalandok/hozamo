import { addDecimals, compareDecimals, divideDecimals, multiplyDecimals, subtractDecimals } from './decimal.js';
import { HozamoValidationError } from './errors.js';
import { aggregateAssetStatistics } from './statistics.js';
import { treasuryBalance } from './treasury.js';

// Net every UTC day before pricing it, just like stats --treasury. No lot matching.
export function treasuryDailyChanges(state, exchange, coin, asOf) {
  const days = new Map();
  let added = '0', released = '0';
  for (const entry of state.ledger) {
    if (entry.exchange !== exchange || entry.coin !== coin) continue;
    const timestamp = Date.parse(entry.at);
    if (timestamp > asOf) {
      throw new HozamoValidationError('Treasury has a future-dated entry; check the ledger timestamps and system clock');
    }
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const day = days.get(date) ?? { added: '0', released: '0' };
    if (entry.action === 'add') {
      day.added = addDecimals(day.added, entry.amount);
      added = addDecimals(added, entry.amount);
    } else {
      day.released = addDecimals(day.released, entry.amount);
      released = addDecimals(released, entry.amount);
    }
    days.set(date, day);
  }
  if (compareDecimals(subtractDecimals(added, released), treasuryBalance(state, exchange, coin)) !== 0) {
    throw new HozamoValidationError('Daily treasury changes do not match the current balance');
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, day]) => compareDecimals(day.added, day.released) !== 0)
    .map(([date, day]) => {
      const amount = subtractDecimals(day.added, day.released);
      return { date, amount, direction: amount.startsWith('-') ? 'released' : 'added' };
    });
}

function signedDivide(value, amount) {
  const negative = value.startsWith('-');
  const result = divideDecimals(negative ? value.slice(1) : value, amount, 100);
  return negative && result !== '0' ? `-${result}` : result;
}

export function estimateTreasuryCost({ coin, changes, activity, startTime, endTime }) {
  // Reuse stats' executed-trade weighting and local time filters; ignore transfers.
  const statistics = aggregateAssetStatistics({
    coin, startTime, endTime, activity: { swaps: activity.swaps ?? [] },
  });
  const salesByDate = new Map(statistics.rows.map((row) => [row.date, row]));
  const totals = {
    added: { amount: '0', knownValue: '0', unpricedAmount: '0' },
    released: { amount: '0', knownValue: '0', unpricedAmount: '0' },
  };
  const rows = changes.map(({ date, amount, direction }) => {
    const magnitude = amount.startsWith('-') ? amount.slice(1) : amount;
    const total = totals[direction];
    total.amount = addDecimals(total.amount, magnitude);
    const sales = salesByDate.get(date);
    const spent = sales?.swappedByReceivedAsset.get('USDT') ?? '0';
    let price = null, value = null;
    if (compareDecimals(spent, '0') === 0) {
      total.unpricedAmount = addDecimals(total.unpricedAmount, magnitude);
    } else {
      const gross = sales.received.get('USDT') ?? '0';
      price = divideDecimals(gross, spent, 100);
      // Multiply before dividing, so the displayed daily price is never used as input.
      value = divideDecimals(multiplyDecimals(magnitude, gross), spent, 100);
      total.knownValue = addDecimals(total.knownValue, value);
    }
    const cost = direction === 'added' ? value : '0';
    const revenue = direction === 'released' ? value : '0';
    return { date, amount, price, cost, revenue,
      netCost: value === null ? null : subtractDecimals(cost, revenue) };
  });
  for (const total of Object.values(totals)) {
    total.pricedAmount = subtractDecimals(total.amount, total.unpricedAmount);
    total.value = total.unpricedAmount === '0' ? total.knownValue : null;
    total.price = total.value !== null && total.amount !== '0'
      ? divideDecimals(total.value, total.amount, 100) : null;
  }
  const { added, released } = totals;
  const amount = subtractDecimals(added.amount, released.amount);
  const netCost = added.value === null || released.value === null
    ? null : subtractDecimals(added.value, released.value);
  const sum = {
    date: 'SUM', amount, cost: added.value, revenue: released.value, netCost,
    price: netCost !== null && amount !== '0' ? signedDivide(netCost, amount) : null,
  };
  const summaries = [sum,
    { date: 'ADDED', amount: added.amount, price: added.price,
      cost: added.value, revenue: '0', netCost: added.value },
    { date: 'RELEASED', amount: subtractDecimals('0', released.amount), price: released.price,
      cost: '0', revenue: released.value,
      netCost: released.value === null ? null : subtractDecimals('0', released.value) },
  ];
  return { rows, summaries, sum, added, released };
}
