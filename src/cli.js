import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import {
  applyPercent,
  compareDecimals,
  divideDecimals,
  divideDecimalsCeil,
  multiplyDecimals,
  percentageOf,
  subtractDecimals,
} from './decimal.js';
import {
  buildDepositSourceColumns,
  depositSourceAmount,
  parseDepositSourceBook,
} from './deposit-sources.js';
import {
  HozamoApiError,
  HozamoValidationError,
} from './errors.js';
import {
  createExchangeClient,
  normalizeExchangeName,
} from './exchanges/index.js';
import {
  normalizeAsset,
  normalizePositiveDecimal,
  splitPair,
} from './normalizers.js';
import { configureDnsResultOrder } from './network.js';
import {
  aggregateAssetStatistics,
  resolveStatisticsPeriod,
} from './statistics.js';

const STANDALONE = (
  typeof __HOZAMO_STANDALONE__ !== 'undefined' &&
  __HOZAMO_STANDALONE__ === true
);
const VERSION = typeof __HOZAMO_VERSION__ === 'string'
  ? __HOZAMO_VERSION__
  : JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
const CLI_INVOCATION = STANDALONE
  ? (process.platform === 'win32' ? 'hozamo.exe' : './hozamo')
  : 'node hozamo';
const DEFAULT_BUY_RESERVE_PERCENT = '0.5';
const DEFAULT_AVERAGE_PRICE_DECIMALS = 5;
const MAX_AVERAGE_PRICE_DECIMALS = 100;
const BOOLEAN_OPTIONS = new Set([
  'help', 'yes', 'dryrun', 'debug', 'hide-zero-days', 'deposits-by-source',
  'average-price',
]);

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((line) => console.log(line));
  const stderr = dependencies.stderr ?? ((line) => console.error(line));
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  let debug = argv.includes('--debug');

  try {
    if (argv.length === 0) {
      stdout(helpText());
      return 0;
    }

    if (argv[0] === '--help' || argv[0] === '-h') {
      stdout(helpText());
      return 0;
    }

    if (argv[0] === '--version' || argv[0] === '-v') {
      stdout(VERSION);
      return 0;
    }

    const command = argv[0];
    const options = parseOptions(argv.slice(1));
    debug = debug || options.debug === true;

    if (options.help) {
      stdout(commandHelp(command));
      return 0;
    }

    const executableDir = dependencies.executableDir ?? (
      STANDALONE ? dirname(process.execPath) : undefined
    );
    const executableEnv = executableDir
      ? loadEnvFile(join(executableDir, '.env'))
      : {};
    const fileEnv = loadEnvFile(join(cwd, '.env'));
    const config = { ...executableEnv, ...fileEnv, ...env };
    configureDnsResultOrder(
      config.HOZAMO_DNS_RESULT_ORDER,
      dependencies.setDnsResultOrder,
    );
    const exchange = normalizeExchangeName(
      options.exchange ?? config.HOZAMO_EXCHANGE ?? 'safetrade',
    );
    const clientFactory = dependencies.clientFactory ?? ((clientOptions) => (
      createExchangeClient(clientOptions)
    ));
    const client = clientFactory({
      exchange,
      env: config,
      timeoutMs: parseTimeout(
        config.HOZAMO_TIMEOUT_MS ??
        (exchange === 'coinex'
          ? config.COINEX_TIMEOUT_MS
          : config.SAFETRADE_TIMEOUT_MS),
      ),
    });

    switch (command) {
      case 'price':
        assertKnownOptions(options, ['exchange', 'pair', 'debug']);
        await printPrice(client, options, stdout);
        return 0;
      case 'status':
        assertKnownOptions(options, ['exchange', 'coin', 'debug']);
        await printStatus(client, options, stdout);
        return 0;
      case 'balance':
        assertKnownOptions(options, ['exchange', 'coin', 'debug']);
        await printBalances(client, options, stdout);
        return 0;
      case 'stats':
        assertKnownOptions(options, [
          'exchange', 'coin', 'days', 'from', 'to', 'format',
          'hide-zero-days', 'deposits-by-source', 'average-price',
          'average-price-decimals', 'debug',
        ]);
        await printStatistics(client, options, {
          stdout,
          now: dependencies.now ?? Date.now,
          exchange,
          depositSources: config.HOZAMO_DEPOSIT_SOURCES,
        });
        return 0;
      case 'order':
        assertKnownOptions(options, [
          'exchange', 'type', 'side', 'order', 'pair', 'amount', 'price',
          'balance-percent', 'receive', 'reserve-percent', 'price-percent', 'yes',
          'dryrun', 'debug',
        ]);
        await submitOrder(client, options, {
          stdout,
          confirm: dependencies.confirm ?? defaultConfirm,
          buyReservePercent: config.HOZAMO_BUY_RESERVE_PERCENT,
        });
        return 0;
      default:
        throw new HozamoValidationError(
          `Unknown command: ${command}. Use "${CLI_INVOCATION} --help".`,
        );
    }
  } catch (error) {
    stderr(formatCliError(error));
    if (
      debug && error instanceof HozamoApiError &&
      error.method && error.url
    ) {
      stderr(`Request: ${error.method} ${error.url}`);
    }
    if (debug && error?.stack) {
      stderr(error.stack);
    }
    return 1;
  }
}

async function printPrice(client, options, stdout) {
  const pair = normalizeDisplayPair(options.pair);
  const { base, quote } = splitPair(pair);
  const result = await client.getPrice(pair);
  stdout(
    `[${client.displayName ?? client.exchange}] ${pair}: ` +
    `1 ${base} = ${result.price} ${quote} (last traded price)`,
  );
}

async function printStatus(client, options, stdout) {
  const assets = parseAssetList(options.coin);
  const statuses = await client.getAssetStatuses(assets);
  const rows = [];

  stdout(`Exchange: ${client.displayName ?? client.exchange}`);

  for (const asset of statuses) {
    rows.push([
      asset.asset,
      'ALL',
      formatAvailability(asset.depositEnabled),
      formatAvailability(asset.withdrawalEnabled),
    ]);

    for (const network of asset.networks ?? []) {
      rows.push([
        asset.asset,
        network.network,
        formatAvailability(network.depositEnabled),
        formatAvailability(network.withdrawalEnabled),
      ]);
    }
  }

  printTable(['ASSET', 'NETWORK', 'DEPOSIT', 'WITHDRAWAL'], rows, stdout);
}

async function printBalances(client, options, stdout) {
  const assets = parseAssetList(options.coin);
  const balances = await client.getBalances({ coins: assets });
  const byAsset = new Map(balances.map((balance) => [balance.asset, balance]));
  const rows = assets.map((asset) => {
    const balance = byAsset.get(asset) ?? {
      total: '0',
      available: '0',
      locked: '0',
    };
    return [asset, balance.total, balance.available, balance.locked];
  });

  stdout(`Exchange: ${client.displayName ?? client.exchange}`);
  printTable(['ASSET', 'TOTAL', 'AVAILABLE', 'LOCKED'], rows, stdout);
}

async function printStatistics(
  client,
  options,
  { stdout, now, exchange, depositSources },
) {
  requireOption(options.coin, '--coin');
  const coin = normalizeAsset(options.coin);
  const period = resolveStatisticsPeriod({
    days: options.days,
    from: options.from,
    to: options.to,
    now,
  });
  const format = normalizeChoice(
    options.format ?? 'table',
    'format',
    ['table', 'csv'],
  );
  const depositsBySource = options['deposits-by-source'] === true;
  const averagePrice = options['average-price'] === true;
  const averagePriceDecimals = normalizeAveragePriceDecimals(
    options['average-price-decimals'],
    averagePrice,
  );
  if (depositsBySource && exchange === 'coinex') {
    throw new HozamoValidationError(
      'CoinEx API does not provide deposit source addresses, so ' +
      '--deposits-by-source cannot be used with CoinEx',
    );
  }
  const sourceBook = depositsBySource
    ? parseDepositSourceBook(depositSources)
    : null;
  if (typeof client.getAssetActivity !== 'function') {
    throw new HozamoValidationError(
      'The selected exchange does not provide asset history statistics',
    );
  }

  const activity = await client.getAssetActivity({
    coin,
    startTime: period.startTime,
    endTime: period.endTime,
  });
  const report = aggregateAssetStatistics({
    coin,
    startTime: period.startTime,
    endTime: period.endTime,
    activity,
  });
  const sourceColumns = depositsBySource
    ? buildDepositSourceColumns(report.rows, sourceBook)
    : [];
  const headers = [
    'DATE',
    `DEPOSITED ${coin}`,
    ...sourceColumns.map(({ label }) => `FROM ${label}`),
    `WITHDRAWN ${coin}`,
    `SWAPPED ${coin}`,
    ...report.receivedAssets.map((asset) => `RECEIVED ${asset} (GROSS)`),
    ...(averagePrice ? [`AVG SELL PRICE (USDT/${coin})`] : []),
  ];
  const dailyRows = options['hide-zero-days']
    ? report.rows.filter(statisticsRowHasActivity)
    : report.rows;
  const rows = [report.sum, ...dailyRows].map((row) => [
    row.date,
    row.deposited,
    ...sourceColumns.map((column) => depositSourceAmount(row, column)),
    row.withdrawn,
    row.swapped,
    ...report.receivedAssets.map((asset) => row.received.get(asset) ?? '0'),
    ...(averagePrice
      ? [formatAverageSalePrice(row, averagePriceDecimals)]
      : []),
  ]);

  if (format === 'csv') {
    printCsv(headers, rows, stdout);
    return;
  }

  stdout(`Exchange: ${client.displayName ?? client.exchange}`);
  stdout(`Asset: ${coin}`);
  stdout(`Period: ${period.from} to ${period.to} (UTC, inclusive)`);
  printTable(headers, rows, stdout);
}

function statisticsRowHasActivity(row) {
  return [
    row.deposited,
    row.withdrawn,
    row.swapped,
    ...row.received.values(),
  ].some((value) => compareDecimals(value, '0') !== 0);
}

function formatAverageSalePrice(row, decimals) {
  const swappedToUsdt = row.swappedByReceivedAsset.get('USDT') ?? '0';
  if (compareDecimals(swappedToUsdt, '0') === 0) {
    return 'N/A';
  }
  return divideDecimals(row.received.get('USDT') ?? '0', swappedToUsdt, decimals);
}

function normalizeAveragePriceDecimals(value, averagePriceEnabled) {
  if (value === undefined) {
    return DEFAULT_AVERAGE_PRICE_DECIMALS;
  }
  if (!averagePriceEnabled) {
    throw new HozamoValidationError(
      '--average-price-decimals can only be used with --average-price',
    );
  }

  const normalized = String(value).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new HozamoValidationError(
      `--average-price-decimals must be an integer between 0 and ${MAX_AVERAGE_PRICE_DECIMALS}`,
    );
  }
  const decimals = Number(normalized);
  if (!Number.isSafeInteger(decimals) || decimals > MAX_AVERAGE_PRICE_DECIMALS) {
    throw new HozamoValidationError(
      `--average-price-decimals must be an integer between 0 and ${MAX_AVERAGE_PRICE_DECIMALS}`,
    );
  }
  return decimals;
}

async function submitOrder(
  client,
  options,
  { stdout, confirm, buyReservePercent },
) {
  const pair = normalizeDisplayPair(options.pair);
  const { base, quote } = splitPair(pair);
  const type = normalizeChoice(options.type, 'type', ['market', 'limit']);
  const sideOption = resolveSideOption(options);
  const side = normalizeChoice(sideOption, 'side', ['buy', 'sell']);
  const hasAmount = options.amount !== undefined;
  const hasBalancePercent = options['balance-percent'] !== undefined;
  const hasReceive = options.receive !== undefined;
  const hasPrice = options.price !== undefined;
  const hasPricePercent = options['price-percent'] !== undefined;

  const sizingOptionCount = [hasAmount, hasBalancePercent, hasReceive]
    .filter(Boolean)
    .length;
  if (sizingOptionCount !== 1) {
    throw new HozamoValidationError(
      'Use exactly one of --amount, --balance-percent or --receive',
    );
  }
  if (hasReceive && side !== 'sell') {
    throw new HozamoValidationError(
      '--receive can only be used with sell orders',
    );
  }
  if (
    options['reserve-percent'] !== undefined &&
    (!hasBalancePercent || side !== 'buy')
  ) {
    throw new HozamoValidationError(
      '--reserve-percent can only be used with buy orders sized by --balance-percent',
    );
  }

  if (hasPrice && hasPricePercent) {
    throw new HozamoValidationError(
      '--price and --price-percent are mutually exclusive',
    );
  }

  if (type === 'market' && (hasPrice || hasPricePercent)) {
    throw new HozamoValidationError(
      'Market orders must not use --price or --price-percent',
    );
  }

  if (type === 'limit' && !hasPrice && !hasPricePercent) {
    throw new HozamoValidationError(
      'A limit order requires exactly one of --price or --price-percent',
    );
  }

  let price;
  let marketPrice;
  let amount = hasAmount
    ? normalizePositiveDecimal(options.amount, 'amount')
    : undefined;
  let amountAsset;

  if (hasAmount) {
    const marketInfo = await requireMarketInfo(client, pair);
    assertMinimumAmount(amount, marketInfo, base);
  }

  if (hasPrice) {
    price = normalizePositiveDecimal(options.price, 'price');
  } else if (hasPricePercent) {
    const percent = String(options['price-percent']).trim().replace(',', '.');
    marketPrice = await client.getPrice(pair);
    price = applyPercent(marketPrice.price, percent);
    stdout(
      `Price calculation: ${marketPrice.price} ${quote} ${formatPercent(percent)} = ${price} ${quote}`,
    );
  }

  if (hasBalancePercent) {
    ({ amount, amountAsset, marketPrice } = await resolveBalancePercentOrder({
      client,
      options,
      pair,
      base,
      quote,
      type,
      side,
      price,
      marketPrice,
      buyReservePercent,
      stdout,
    }));
  } else if (hasReceive) {
    ({ amount, marketPrice } = await resolveReceiveSellOrder({
      client,
      options,
      pair,
      base,
      quote,
      price,
      marketPrice,
      stdout,
    }));
    await checkSellBalance(client, base, amount, stdout);
  } else if (side === 'sell') {
    await checkSellBalance(client, base, amount, stdout);
  } else {
    if (!price) {
      marketPrice = marketPrice ?? await client.getPrice(pair);
    }
    const referencePrice = price ?? marketPrice.price;
    const requiredQuote = multiplyDecimals(amount, referencePrice);
    const balance = await client.getBalance(quote);
    const available = balance?.available ?? '0';
    if (compareDecimals(available, requiredQuote) < 0) {
      throw new HozamoValidationError(
        `Insufficient ${quote} balance: ${available} available, approximately ${requiredQuote} required`,
      );
    }
    stdout(
      `Balance check: ${available} ${quote} available; estimated principal ${requiredQuote} ${quote} (fees/slippage excluded)`,
    );
  }

  const summary = amountAsset === quote
    ? [
      side.toUpperCase(),
      pair,
      type.toUpperCase(),
      `using ${amount} ${quote}`,
    ].join(' ')
    : [
      side.toUpperCase(),
      amount,
      pair,
      type.toUpperCase(),
      price ? `@ ${price} ${quote}` : '',
    ].filter(Boolean).join(' ');
  stdout(`Exchange: ${client.displayName ?? client.exchange}`);
  stdout(`Order: ${summary}`);

  if (options['dryrun']) {
    stdout('Dry run complete: no order was submitted.');
    return;
  }

  if (!options.yes) {
    const approved = await confirm('Submit this order? [y/N] ');
    if (!approved) {
      stdout('Order cancelled; nothing was submitted.');
      return;
    }
  }

  const orderRequest = {
    pair,
    side,
    type,
    amount,
    price,
  };
  if (amountAsset !== undefined) {
    orderRequest.amountAsset = amountAsset;
  }

  const order = await client.createOrder(orderRequest);
  const id = order?.id ?? order?.order_id ?? order?.uuid ?? 'unknown';
  const state = order?.state ? `, state=${order.state}` : '';
  stdout(`Order submitted successfully: id=${id}${state}`);
}

async function resolveBalancePercentOrder({
  client,
  options,
  pair,
  base,
  quote,
  type,
  side,
  price,
  marketPrice,
  buyReservePercent,
  stdout,
}) {
  const balancePercent = normalizeBalancePercent(options['balance-percent']);
  const marketInfo = await requireMarketInfo(client, pair);
  const balanceAsset = side === 'sell' ? base : quote;
  const balancePrecision = side === 'sell'
    ? marketInfo.basePrecision
    : marketInfo.quotePrecision;
  const balance = await client.getBalance(balanceAsset);
  const available = balance?.available ?? '0';
  const allocation = percentageOf(
    available,
    balancePercent,
    balancePrecision,
  );

  if (compareDecimals(allocation, '0') <= 0) {
    throw new HozamoValidationError(
      `${balancePercent}% of the available ${balanceAsset} balance rounds down to zero`,
    );
  }

  stdout(
    `Balance allocation: ${balancePercent}% of ${available} ${balanceAsset} = ` +
    `${allocation} ${balanceAsset}`,
  );

  if (side === 'sell') {
    assertMinimumAmount(allocation, marketInfo, base);
    return { amount: allocation, amountAsset: undefined, marketPrice };
  }

  const reservePercent = normalizeReservePercent(
    options['reserve-percent'] ??
    buyReservePercent ??
    DEFAULT_BUY_RESERVE_PERCENT,
  );
  const spendPercent = subtractDecimals('100', reservePercent);
  const budget = percentageOf(
    allocation,
    spendPercent,
    marketInfo.quotePrecision,
  );

  if (compareDecimals(budget, '0') <= 0) {
    throw new HozamoValidationError(
      `The ${quote} order budget rounds down to zero after applying the reserve`,
    );
  }

  stdout(
    `Buy reserve: ${reservePercent}% of the selected allocation; ` +
    `order budget ${budget} ${quote}`,
  );

  if (type === 'market' && marketInfo.marketBuyAmountAsset === 'quote') {
    stdout(
      `Market-buy amount: ${budget} ${quote} (quote-denominated by the exchange)`,
    );
    return { amount: budget, amountAsset: quote, marketPrice };
  }

  if (!price) {
    marketPrice = marketPrice ?? await client.getPrice(pair);
  }
  const referencePrice = price ?? marketPrice.price;
  const amount = divideDecimals(
    budget,
    referencePrice,
    marketInfo.basePrecision,
  );

  if (compareDecimals(amount, '0') <= 0) {
    throw new HozamoValidationError(
      `The calculated ${base} order amount rounds down to zero`,
    );
  }
  assertMinimumAmount(amount, marketInfo, base);
  stdout(
    `Calculated order amount: ${amount} ${base} using ` +
    `${referencePrice} ${quote} per ${base}`,
  );

  return { amount, amountAsset: undefined, marketPrice };
}

async function resolveReceiveSellOrder({
  client,
  options,
  pair,
  base,
  quote,
  price,
  marketPrice,
  stdout,
}) {
  const target = normalizePositiveDecimal(options.receive, 'receive');
  const marketInfo = await requireMarketInfo(client, pair);
  if (!price) {
    marketPrice = marketPrice ?? await client.getPrice(pair);
  }
  const referencePrice = price ?? marketPrice.price;
  const amount = divideDecimalsCeil(
    target,
    referencePrice,
    marketInfo.basePrecision,
  );

  if (compareDecimals(amount, '0') <= 0) {
    throw new HozamoValidationError(
      `The calculated ${base} order amount rounds to zero`,
    );
  }

  assertMinimumAmount(amount, marketInfo, base);
  const estimatedGross = multiplyDecimals(amount, referencePrice);
  const priceKind = price ? 'limit price' : 'last traded price';

  stdout(`Receive target: ${target} ${quote} gross`);
  stdout(
    `Calculated order amount: ${amount} ${base} using ${referencePrice} ` +
    `${quote} per ${base} (${priceKind}, rounded up to ` +
    `${marketInfo.basePrecision} decimal places)`,
  );
  stdout(
    `Estimated gross proceeds: ${estimatedGross} ${quote} ` +
    '(exchange fees and market-order slippage excluded)',
  );

  return { amount, marketPrice };
}

async function checkSellBalance(client, base, amount, stdout) {
  const balance = await client.getBalance(base);
  const available = balance?.available ?? '0';
  if (compareDecimals(available, amount) < 0) {
    throw new HozamoValidationError(
      `Insufficient ${base} balance: ${available} available, ` +
      `${amount} requested for this order`,
    );
  }
  stdout(`Balance check: ${available} ${base} available`);
}

async function requireMarketInfo(client, pair) {
  if (typeof client.getMarketInfo !== 'function') {
    throw new HozamoValidationError(
      'The selected exchange client does not provide market precision metadata',
    );
  }
  return client.getMarketInfo(pair);
}

function assertMinimumAmount(amount, marketInfo, base) {
  if (
    marketInfo.minAmount !== null &&
    marketInfo.minAmount !== undefined &&
    compareDecimals(amount, marketInfo.minAmount) < 0
  ) {
    const market = marketInfo.pair ?? marketInfo.market ?? 'selected';
    throw new HozamoValidationError(
      `Order amount ${amount} ${base} is below the ${market} market minimum ` +
      `of ${marketInfo.minAmount} ${base}`,
    );
  }
}

function normalizeBalancePercent(value) {
  const percent = normalizePositiveDecimal(value, 'balance-percent');
  if (compareDecimals(percent, '100') > 0) {
    throw new HozamoValidationError(
      'balance-percent must be greater than 0 and at most 100',
    );
  }
  return percent;
}

function normalizeReservePercent(value) {
  const percent = String(value).trim().replace(',', '.');
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(percent)) {
    throw new HozamoValidationError(
      'reserve-percent must be a decimal from 0 up to, but not including, 100',
    );
  }
  if (compareDecimals(percent, '100') >= 0) {
    throw new HozamoValidationError(
      'reserve-percent must be a decimal from 0 up to, but not including, 100',
    );
  }
  return percent;
}

function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '-h') {
      options.help = true;
      continue;
    }

    if (!argument.startsWith('--')) {
      throw new HozamoValidationError(`Unexpected argument: ${argument}`);
    }

    const [rawName, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    const name = rawName.trim();

    if (!name) {
      throw new HozamoValidationError('Invalid empty option');
    }

    if (Object.hasOwn(options, name)) {
      throw new HozamoValidationError(`Option --${name} was provided twice`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new HozamoValidationError(
          `Boolean option --${name} accepts only true or false`,
        );
      }
      options[name] = inlineValue === undefined ? true : inlineValue === 'true';
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HozamoValidationError(`Option --${name} requires a value`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    options[name] = value;
  }

  return options;
}

function resolveSideOption(options) {
  if (options.side !== undefined && options.order !== undefined) {
    throw new HozamoValidationError(
      'Use either --side or the compatibility alias --order, not both',
    );
  }
  return options.side ?? options.order;
}

function normalizeChoice(value, name, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new HozamoValidationError(
      `--${name} is required and must be one of: ${allowed.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeDisplayPair(value) {
  requireOption(value, '--pair');
  const { base, quote } = splitPair(value);
  return `${base}-${quote}`;
}

function parseAssetList(value) {
  requireOption(value, '--coin');
  return String(value).split(',').map(normalizeAsset);
}

function requireOption(value, name) {
  if (value === undefined || String(value).trim() === '') {
    throw new HozamoValidationError(`${name} is required`);
  }
}

function assertKnownOptions(options, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).find((name) => !allowedSet.has(name));
  if (unknown) {
    throw new HozamoValidationError(`Unknown option: --${unknown}`);
  }
}

function parseTimeout(value) {
  if (value === undefined || value === '') {
    return 15_000;
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new HozamoValidationError(
      'The configured timeout must be a positive integer',
    );
  }
  return timeout;
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

async function defaultConfirm(question) {
  if (!processStdin.isTTY) {
    throw new HozamoValidationError(
      'Non-interactive order submission requires --yes',
    );
  }
  const readline = createInterface({ input: processStdin, output: processStdout });
  try {
    const answer = await readline.question(question);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

function formatPercent(percent) {
  return percent.startsWith('-') ? `${percent}%` : `+${percent}%`;
}

function formatAvailability(value) {
  if (value === true) {
    return 'ENABLED';
  }
  if (value === false) {
    return 'DISABLED';
  }
  return 'UNKNOWN';
}

function printTable(headers, rows, stdout) {
  const normalizedRows = [headers, ...rows].map((row) => (
    row.map((cell) => String(cell))
  ));
  const widths = headers.map((_, column) => Math.max(
    ...normalizedRows.map((row) => row[column]?.length ?? 0),
  ));

  for (const row of normalizedRows) {
    stdout(row.map((cell, column) => (
      cell.padEnd(widths[column])
    )).join('  ').trimEnd());
  }
}

function printCsv(headers, rows, stdout) {
  for (const row of [headers, ...rows]) {
    stdout(row.map(formatCsvCell).join(','));
  }
}

function formatCsvCell(value) {
  const cell = String(value);
  if (!/[",\r\n]/.test(cell)) {
    return cell;
  }
  return `"${cell.replaceAll('"', '""')}"`;
}

function formatCliError(error) {
  if (error instanceof HozamoApiError && error.code === 'CLOUDFLARE_BLOCKED') {
    const ray = error.rayId ? ` Cloudflare Ray ID: ${error.rayId}.` : '';
    return [
      'SafeTrade blocked the API request through Cloudflare (HTTP 403).',
      'This happened before SafeTrade processed the API call; it is not an API-key error.',
      `Try again from another network or contact SafeTrade support.${ray}`,
    ].join('\n');
  }
  return error?.message ?? String(error);
}

function helpText() {
  return `Hozamo ${VERSION} — multi-exchange spot trading CLI

Usage:
  ${CLI_INVOCATION} <command> [options]

Commands:
  price      Show the last traded price for a pair
  status     Show asset and network deposit/withdrawal status
  balance    Show total, available and locked balances
  stats      Show daily deposit, withdrawal and swap statistics
  order      Validate and submit a market or limit order

Examples:
  ${CLI_INVOCATION} price --exchange coinex --pair BTC-USDT
  ${CLI_INVOCATION} status --exchange coinex --coin PEARL,USDT
  ${CLI_INVOCATION} balance --exchange coinex --coin QUAI,RVN
  ${CLI_INVOCATION} stats --exchange coinex --coin PEARL --days 30
  ${CLI_INVOCATION} stats --exchange coinex --coin PEARL --days 30 --average-price
  ${CLI_INVOCATION} stats --exchange safetrade --coin PEARL --from 2026-08-01 --to 2026-08-31 --format csv
  ${CLI_INVOCATION} order --exchange coinex --type market --side sell --pair BTC-USDT --amount 0.001
  ${CLI_INVOCATION} order --exchange coinex --type market --side sell --pair BTC-USDT --balance-percent 100
  ${CLI_INVOCATION} order --exchange coinex --type market --side sell --pair BTC-USDT --receive 100 --dryrun
  ${CLI_INVOCATION} order --exchange coinex --type market --side buy --pair BTC-USDT --balance-percent 100 --dryrun
  ${CLI_INVOCATION} order --exchange coinex --type limit --side sell --pair BTC-USDT --amount 0.001 --price-percent 10
  ${CLI_INVOCATION} order --exchange coinex --type limit --side sell --pair BTC-USDT --amount 0.001 --price 60000 --dryrun

Run "${CLI_INVOCATION} <command> --help" for command-specific help.`;
}

function commandHelp(command) {
  const help = {
    price: `Usage: ${CLI_INVOCATION} price [--exchange safetrade|coinex] --pair BTC-USDT`,
    status: `Usage: ${CLI_INVOCATION} status [--exchange safetrade|coinex] --coin PEARL,USDT

Shows deposit/withdrawal availability for one or more comma-separated assets.
Network-specific rows are included when the exchange provides them.`,
    balance: `Usage: ${CLI_INVOCATION} balance [--exchange safetrade|coinex] --coin QUAI,RVN`,
    stats: `Usage: ${CLI_INVOCATION} stats [--exchange safetrade|coinex] --coin PEARL [period] [options]

Period (use exactly one form):
  --days 30             Current UTC day and the preceding 29 UTC days
  --from 2026-08-01     First UTC date, inclusive
  --to 2026-08-31       Last UTC date, inclusive; required with --from

Options:
  --format table        Aligned table output (default)
  --format csv          CSV written to stdout
  --hide-zero-days      Omit UTC dates where every value is zero
  --deposits-by-source  Add one deposit column for each SafeTrade source address
  --average-price       Add the weighted average USDT sell price
  --average-price-decimals 5
                        Maximum decimal places in average prices (default: 5)

Only credited deposits and successful withdrawals are included. Swaps are
completed trades that spend the requested coin. Received amounts are gross and
are reported in separate columns for each received asset.

--deposits-by-source is supported by SafeTrade only. Known pool names are
resolved from the built-in and HOZAMO_DEPOSIT_SOURCES address books.

--average-price divides gross USDT received by the requested coin amount spent
in those USDT trades. Swaps into other assets do not affect the average.
--average-price-decimals accepts an integer from 0 to 100 and requires
--average-price.`,
    order: `Usage: ${CLI_INVOCATION} order --type market|limit --side buy|sell [options]

Options:
  --exchange coinex     Exchange (default: HOZAMO_EXCHANGE or safetrade)
  --pair BTC-USDT       Trading pair; required
  --amount 0.001        Exact base-asset amount
  --balance-percent 100 Percentage of available base (sell) or quote (buy)
  --receive 100         Target gross quote proceeds for a sell order
                        Use exactly one of --amount, --balance-percent or --receive
  --reserve-percent 0.5 Buy-side reserve used with --balance-percent
                        (default: HOZAMO_BUY_RESERVE_PERCENT or 0.5)
  --price 0.28          Exact limit price
  --price-percent 10    Limit price relative to last traded price
  --dryrun              Validate without submitting
  --yes                 Skip the interactive confirmation
  --order sell          Compatibility alias for --side sell`,
  };
  if (!help[command]) {
    throw new HozamoValidationError(`Unknown command: ${command}`);
  }
  return help[command];
}
