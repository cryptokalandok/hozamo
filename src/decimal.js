import { HozamoValidationError } from './errors.js';

export function compareDecimals(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const aScaled = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bScaled = b.coefficient * 10n ** BigInt(scale - b.scale);

  return aScaled < bScaled ? -1 : aScaled > bScaled ? 1 : 0;
}

export function multiplyDecimals(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return formatDecimal(a.coefficient * b.coefficient, a.scale + b.scale, true);
}

export function addDecimals(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const aScaled = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bScaled = b.coefficient * 10n ** BigInt(scale - b.scale);

  return formatDecimal(aScaled + bScaled, scale, true);
}

export function subtractDecimals(left, right) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const aScaled = a.coefficient * 10n ** BigInt(scale - a.scale);
  const bScaled = b.coefficient * 10n ** BigInt(scale - b.scale);

  return formatDecimal(aScaled - bScaled, scale, true);
}

export function divideDecimals(left, right, scale) {
  const { numerator, denominator } = prepareDivision(left, right, scale);

  // Integer division intentionally rounds down for the positive financial
  // values accepted here, so a calculated order never exceeds its budget.
  return formatDecimal(numerator / denominator, scale, true);
}

export function divideDecimalsCeil(left, right, scale) {
  const { numerator, denominator } = prepareDivision(left, right, scale);
  const quotient = numerator / denominator;
  const roundedUp = numerator % denominator === 0n
    ? quotient
    : quotient + 1n;

  return formatDecimal(roundedUp, scale, true);
}

export function percentageOf(value, percent, scale) {
  const normalizedPercent = parseDecimal(percent);
  if (normalizedPercent.coefficient <= 0n) {
    throw new HozamoValidationError('percent must be greater than zero');
  }

  return divideDecimals(multiplyDecimals(value, percent), '100', scale);
}

export function applyPercent(value, percent) {
  const price = parseDecimal(value);
  const adjustment = parseDecimal(percent, { signed: true });
  const percentScale = 10n ** BigInt(adjustment.scale);
  const multiplier = 100n * percentScale + adjustment.coefficient;

  if (multiplier <= 0n) {
    throw new HozamoValidationError(
      'price-percent must result in a positive price',
    );
  }

  const denominator = 100n * percentScale;
  const numerator = price.coefficient * multiplier;
  const rounded = (numerator + denominator / 2n) / denominator;
  return formatDecimal(rounded, price.scale, false);
}

function parseDecimal(value, { signed = false } = {}) {
  const normalized = String(value).trim().replace(',', '.');
  const pattern = signed ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;

  if (!pattern.test(normalized)) {
    throw new HozamoValidationError(`Invalid decimal value: ${value}`);
  }

  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(integer + fraction) * (negative ? -1n : 1n);

  return { coefficient, scale: fraction.length };
}

function prepareDivision(left, right, scale) {
  const a = parseDecimal(left);
  const b = parseDecimal(right);

  if (!Number.isInteger(scale) || scale < 0 || scale > 100) {
    throw new HozamoValidationError(
      'Decimal division scale must be an integer between 0 and 100',
    );
  }
  if (b.coefficient === 0n) {
    throw new HozamoValidationError('Cannot divide by zero');
  }

  const exponent = b.scale + scale - a.scale;
  let numerator = a.coefficient;
  let denominator = b.coefficient;

  if (exponent >= 0) {
    numerator *= 10n ** BigInt(exponent);
  } else {
    denominator *= 10n ** BigInt(-exponent);
  }

  return { numerator, denominator };
}

function formatDecimal(coefficient, scale, trim) {
  const negative = coefficient < 0n;
  const unsigned = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, '0');

  if (scale === 0) {
    return `${negative ? '-' : ''}${unsigned}`;
  }

  const integer = unsigned.slice(0, -scale);
  let fraction = unsigned.slice(-scale);

  if (trim) {
    fraction = fraction.replace(/0+$/, '');
  }

  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}
