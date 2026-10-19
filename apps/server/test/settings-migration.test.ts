import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_VERSION, SettingsSchema, defaultSettings, deepMerge } from '@cryptoalgo/core';
import { buildApi } from '../src/api';
import { Repos } from '../src/repos';
import { closeSharedDb, getSharedDb, makeHarness, resetDb, type Harness } from './harness';

/**
 * Settings v2 (no time limit, brokerage on both legs, fixed $10 target): a database that still holds the pre-v2 defaults
 * is upgraded once at start, audited once, and a second start changes nothing.
 */

let h: Harness | null = null;
let apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await h?.stop();
  h = null;
});
afterAll(closeSharedDb);

/** The settings document exactly as the pre-v2 server stored it: old defaults, no `version`, no `goals`. */
function oldDefaultsDocument(operatorChanges: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = deepMerge(defaultSettings() as unknown as Record<string, unknown>, {
    targets: { targetMoveMinUsd: 4, targetMoveMaxUsd: 6, stopLossMinUsd: 3, stopLossMaxUsd: 6 },
    exits: { maxHoldMinutes: 30, timeExitPolicy: 'breakeven_then_close', breakevenAfterMinutes: 15 },
    execution: { exitFeeWaiver: { enabled: true } },
    ...operatorChanges,
  });
  delete doc.version;
  delete doc.goals;
  return doc;
}

const storedSettings = async (db: Harness['db']) => (await new Repos(db).getDoc<any>('settings'))!;
const updatedAt = async (db: Harness['db']) => String((await db.query<{ updated_at: unknown }>("SELECT updated_at FROM app_state WHERE key = 'settings'"))[0].updated_at);
const audits = (db: Harness['db'], action: string) => new Repos(db).listAudit(50, action);

describe('settings migration (S1)', () => {
  it('a database holding the OLD defaults is upgraded at start; every other stored value is kept', async () => {
    const stored = oldDefaultsDocument({ limits: { perTradeRiskUsd: 3.5, dailyLossLimitUsd: 9 }, execution: { usdInrRate: 84.2, exitFeeWaiver: { enabled: true, withinMinutes: 25 } }, position: { leverage: 20 } });
    expect((stored as any).exits.maxHoldMinutes).toBe(30);
    h = await makeHarness({ rawSettings: stored, relax: false });

    const s = h.rt.getSettings();
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.exits.maxHoldMinutes).toBeNull();
    expect(s.exits.timeExitPolicy).toBe('none');
    expect(s.execution.exitFeeWaiver.enabled).toBe(false);
    expect(s.targets).toMatchObject({ targetMoveMinUsd: 10, targetMoveMaxUsd: 10, stopLossMinUsd: 5, stopLossMaxUsd: 8 });
    expect(s.goals.dailyProfitInr).toBe(500);
    // untouched: the operator's own values and the rest of the old document
    expect(s.limits.perTradeRiskUsd).toBe(3.5);
    expect(s.limits.dailyLossLimitUsd).toBe(9);
    expect(s.execution.usdInrRate).toBe(84.2);
    expect(s.execution.exitFeeWaiver.withinMinutes).toBe(25);
    expect(s.position.leverage).toBe(20);
    expect(s.exits.breakevenAfterMinutes).toBe(15);
    expect(s.exits.takeProfitOrderType).toBe('limit');

    // persisted once: the stored document is the migrated one, and it parses as it is
    const doc = await storedSettings(h.db);
    expect(doc.version).toBe(2);
    expect(doc.exits.maxHoldMinutes).toBeNull();
    expect(doc.goals).toEqual({ dailyProfitInr: 500 });
    expect(SettingsSchema.parse(doc)).toEqual(s);

    // one audit row with the versions and the keys that changed
    const rows = await audits(h.db, 'settings_migrated');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'system', success: true });
    expect(rows[0].details).toMatchObject({ from: 1, to: 2 });
    const changed = (rows[0].details as { changed: string[] }).changed;
    expect(changed).toEqual(
      expect.arrayContaining([
        'version',
        'exits.maxHoldMinutes',
        'exits.timeExitPolicy',
        'execution.exitFeeWaiver.enabled',
        'targets.targetMoveMinUsd',
        'targets.targetMoveMaxUsd',
        'targets.stopLossMinUsd',
        'targets.stopLossMaxUsd',
        'goals.dailyProfitInr',
      ]),
    );
    expect(changed).not.toContain('limits.perTradeRiskUsd');
    expect(changed).not.toContain('execution.usdInrRate');
    expect(changed).not.toContain('position.leverage');
  });

  it('a second start changes nothing: same document, same timestamp, no new audit row', async () => {
    h = await makeHarness({ rawSettings: oldDefaultsDocument(), relax: false });
    const before = await storedSettings(h.db);
    const stamp = await updatedAt(h.db);
    const settingsBefore = JSON.stringify(h.rt.getSettings());

    h = await h.restart();
    expect(JSON.stringify(h.rt.getSettings())).toBe(settingsBefore);
    expect(await storedSettings(h.db)).toEqual(before);
    expect(await updatedAt(h.db)).toBe(stamp);
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(1);

    h = await h.restart();
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(1);
    expect(await updatedAt(h.db)).toBe(stamp);
  });

  it('a migrated setting the operator changes afterwards is not migrated again (not even to the v2 default)', async () => {
    h = await makeHarness({ rawSettings: oldDefaultsDocument(), relax: false });
    const r = await h.rt.updateSettings({ exits: { maxHoldMinutes: 120, timeExitPolicy: 'close_at_market' }, targets: { targetMoveMinUsd: 8, targetMoveMaxUsd: 8 } }, 'admin', 'admin');
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    h = await h.restart();
    const s = h.rt.getSettings();
    expect(s.exits).toMatchObject({ maxHoldMinutes: 120, timeExitPolicy: 'close_at_market' });
    expect(s.targets).toMatchObject({ targetMoveMinUsd: 8, targetMoveMaxUsd: 8 });
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(1);
  });

  it('a fresh database gets the new defaults and no migration is recorded', async () => {
    h = await makeHarness({ relax: false });
    const s = h.rt.getSettings();
    expect(s).toEqual(defaultSettings());
    expect(s).toMatchObject({ version: 2, goals: { dailyProfitInr: 500 }, exits: { maxHoldMinutes: null, timeExitPolicy: 'none' }, targets: { targetMoveMinUsd: 10, targetMoveMaxUsd: 10 } });
    expect(s.execution.exitFeeWaiver.enabled).toBe(false);
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(0);
    expect(await new Repos(h.db).getDoc('settings')).toBeNull(); // nothing is written until the operator changes something
  });

  it('a document with an explicit version below 2, and one already at version 2, are handled by their version', async () => {
    h = await makeHarness({ rawSettings: { ...oldDefaultsDocument(), version: 1 }, relax: false });
    expect(h.rt.getSettings().exits.maxHoldMinutes).toBeNull();
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(1);
    await h.stop();

    // an operator who deliberately chose a 45 minute limit AFTER v2 keeps it: version 2 is never migrated
    const v2 = { ...defaultSettings(), exits: { ...defaultSettings().exits, maxHoldMinutes: 45, timeExitPolicy: 'close_at_market' as const } };
    h = await makeHarness({ rawSettings: v2, relax: false });
    expect(h.rt.getSettings().exits).toMatchObject({ maxHoldMinutes: 45, timeExitPolicy: 'close_at_market' });
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(0);
  });

  it('two instances starting together migrate once (compare-and-set on the stored version)', async () => {
    const db = await getSharedDb();
    await resetDb(db);
    const repos = new Repos(db);
    await repos.setDoc('settings', oldDefaultsDocument());
    const [a, b] = await Promise.all([new Repos(db).loadSettingsMigrating(), new Repos(db).loadSettingsMigrating()]);
    expect(a.settings).toEqual(b.settings);
    expect(a.settings.exits.maxHoldMinutes).toBeNull();
    expect([a.migration, b.migration].filter(Boolean)).toHaveLength(1);
    expect(await repos.listAudit(20, 'settings_migrated')).toHaveLength(1);
    expect((await repos.getDoc<any>('settings')).version).toBe(2);
  });

  it('a stored document that cannot be read is left exactly as it was, falls back to the defaults and is audited', async () => {
    const broken = { ...oldDefaultsDocument(), position: { quantityEth: 'a lot' } };
    h = await makeHarness({ rawSettings: broken, relax: false });
    expect(h.rt.getSettings()).toEqual(defaultSettings());
    expect(await storedSettings(h.db)).toEqual(broken); // nothing was overwritten, the operator can still recover it
    expect(await audits(h.db, 'settings_migrated')).toHaveLength(0);
    const failed = await audits(h.db, 'settings_migration_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].success).toBe(false);
  });

  it('a stale dashboard tab sending a whole OLD document cannot downgrade the version, and null clears the time limit', async () => {
    h = await makeHarness({ relax: false });
    const app = await buildApi(h.rt);
    apps.push(app);
    h.rt.bot.workerActive = true;
    const token = ((await app.auth.login('admin', 'correct horse battery', '10.8.0.1')) as any).token as string;
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings', payload: payload as any, remoteAddress: '10.8.0.1', headers: { authorization: `Bearer ${token}` } });

    const stale = await put({ version: 1, exits: { maxHoldMinutes: 30, timeExitPolicy: 'close_at_market' } });
    expect(stale.statusCode, stale.body).toBe(200);
    expect(h.rt.getSettings().version).toBe(2);
    expect(h.rt.getSettings().exits.maxHoldMinutes).toBe(30);
    expect((await storedSettings(h.db)).version).toBe(2);

    const cleared = await put({ exits: { maxHoldMinutes: null, timeExitPolicy: 'none' } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as any).settings.exits).toMatchObject({ maxHoldMinutes: null, timeExitPolicy: 'none' });
    // the time limit cannot be silently turned on by a patch that only names the number while the policy is "none"
    const ignored = await put({ exits: { maxHoldMinutes: 60 } });
    expect(ignored.statusCode, ignored.body).toBe(200);
    expect((ignored.json() as any).issues.map((i: any) => i.message).join(' ')).toMatch(/ignored/);
  });
});
