import { addDecimals } from './decimal.js';
import { HozamoValidationError } from './errors.js';

export const BUILT_IN_DEPOSIT_SOURCES = Object.freeze([
  Object.freeze({
    name: 'Kryptex',
    address: 'prl1puv0gqv4x0wd0ylwz086y3sqrg4a6umza9r08aecehjrmdqq7mctsmqaqsh',
  }),
  Object.freeze({
    name: 'PearlHash',
    address: 'prl1p50ltku2jjcwdxh4nzjrw98nwdswdn25qdkr2fdtw8hsq3qu9cdhscchnnm',
  }),
  Object.freeze({
    name: 'HeroMiners',
    address: 'prl1pksfzrn8g760gmcqy65a4tl30eyv25eksl5sf8y332kes6fwx9pjszgymmz',
  }),
]);

export function parseDepositSourceBook(value) {
  const sources = new Map(BUILT_IN_DEPOSIT_SOURCES.map(({ name, address }) => (
    [address, name]
  )));
  if (value === undefined || String(value).trim() === '') {
    return sources;
  }

  let configured;
  try {
    configured = JSON.parse(String(value));
  } catch {
    throw new HozamoValidationError(
      'HOZAMO_DEPOSIT_SOURCES must be a valid JSON object',
    );
  }
  if (
    configured === null ||
    typeof configured !== 'object' ||
    Array.isArray(configured)
  ) {
    throw new HozamoValidationError(
      'HOZAMO_DEPOSIT_SOURCES must map pool names to an address or address array',
    );
  }

  const customAddresses = new Map();
  for (const [rawName, rawAddresses] of Object.entries(configured)) {
    const name = String(rawName).trim();
    if (!name) {
      throw new HozamoValidationError(
        'HOZAMO_DEPOSIT_SOURCES contains an empty pool name',
      );
    }
    const addresses = Array.isArray(rawAddresses) ? rawAddresses : [rawAddresses];
    if (addresses.length === 0) {
      throw new HozamoValidationError(
        `HOZAMO_DEPOSIT_SOURCES has no address for ${name}`,
      );
    }
    for (const rawAddress of addresses) {
      if (typeof rawAddress !== 'string' || rawAddress.trim() === '') {
        throw new HozamoValidationError(
          `HOZAMO_DEPOSIT_SOURCES contains an invalid address for ${name}`,
        );
      }
      const address = rawAddress.trim();
      const existingName = customAddresses.get(address);
      if (existingName !== undefined && existingName !== name) {
        throw new HozamoValidationError(
          `Deposit source address ${address} is assigned to both ${existingName} and ${name}`,
        );
      }
      customAddresses.set(address, name);
      sources.set(address, name);
    }
  }
  return sources;
}

export function buildDepositSourceColumns(rows, sourceBook) {
  const observed = new Set(rows.flatMap((row) => (
    [...row.depositedBySource.keys()]
  )));
  const columns = [];
  const byName = new Map();

  for (const [address, name] of sourceBook) {
    if (!observed.has(address)) {
      continue;
    }
    let column = byName.get(name);
    if (!column) {
      column = { label: name, addresses: [] };
      byName.set(name, column);
      columns.push(column);
    }
    column.addresses.push(address);
    observed.delete(address);
  }

  const unknownAddresses = [...observed]
    .filter((address) => address !== null)
    .sort((left, right) => left.localeCompare(right));
  for (const address of unknownAddresses) {
    columns.push({
      label: shortenDepositSourceAddress(address),
      addresses: [address],
    });
  }
  if (observed.has(null)) {
    columns.push({ label: 'UNKNOWN', addresses: [null] });
  }
  return columns;
}

export function depositSourceAmount(row, column) {
  return column.addresses.reduce((total, address) => (
    addDecimals(total, row.depositedBySource.get(address) ?? '0')
  ), '0');
}

export function shortenDepositSourceAddress(value) {
  const address = String(value).trim();
  if (address.length <= 16) {
    return address;
  }
  return `${address.slice(0, 7)}..${address.slice(-7)}`;
}
