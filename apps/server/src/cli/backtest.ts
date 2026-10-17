import fs from 'node:fs';
import { defaultSettings, deepMerge, fallbackContractSpec } from '@cryptoalgo/core';
import { DeltaClient, DeltaHttp, resolveEndpoints } from '@cryptoalgo/delta';
import { runBacktestJob, loadCandles, type DataSource } from '../services/backtestService';

/**
 * `npm run backtest -- --days 30 [--kind walkforward] [--env production|testnet] [--synthetic] [--out result.json]`
 * Downloads public ETH 1m candles from Delta Exchange (no API key needed) and runs the backtest
 * with the default strategy settings (or --settings file.json overrides).
 */
const args = process.argv.slice(2);
const arg = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name: string) => args.includes(`--${name}`);

const days = Number(arg('days', '30'));
const kind = (arg('kind', 'backtest') as 'backtest' | 'walkforward');
const envName = (arg('env', 'production') as 'production' | 'testnet' | 'global' | 'global-testnet');
const source: DataSource = flag('synthetic') ? 'synthetic' : 'delta';
const symbol = arg('symbol', 'ETHUSD')!;

let settings = defaultSettings();
const settingsFile = arg('settings');
if (settingsFile) settings = deepMerge(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8')));

const ep = resolveEndpoints(envName);
const client = new DeltaClient(new DeltaHttp({ baseUrl: ep.restUrl, userAgent: 'cryptoalgo-backtest/1.0' }));

let spec = fallbackContractSpec(symbol);
if (source === 'delta') {
  process.stdout.write(`Fetching contract spec from ${ep.restUrl} ...\n`);
  spec = await client.getProduct(symbol);
}
process.stdout.write(`Loading ${days} days of 1m candles (${source}) ...\n`);
const candles = await loadCandles(source, days, client, symbol, (d, t) => process.stdout.write(`  page ${d}/${t}\r`));
process.stdout.write(`\nLoaded ${candles.length} candles. Running ${kind} ...\n`);

const { summary, result } = runBacktestJob(candles, settings, spec, { kind, days }, source);
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
const out = arg('out');
if (out) {
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  process.stdout.write(`Full result written to ${out}\n`);
}
if (source === 'synthetic') process.stdout.write('\n⚠ SYNTHETIC DATA — mechanics check only, not market evidence.\n');
