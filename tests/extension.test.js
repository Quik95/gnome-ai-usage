// gjs -m tests/extension.test.js
//
// Runs against an installed extension directory ($EXT_DIR) and provider
// results normalized from upstream's tests/fixtures ($FIXTURES_DIR):
//   - the build-time ESM conversion of the shared upstream modules,
//   - the UsageHistory save protocol through the real tools/sh/history-io,
//   - the pure mapping helpers the popup and panel render from.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const EXT = GLib.getenv('EXT_DIR');
const FIXTURES = GLib.getenv('FIXTURES_DIR');
if (!EXT || !FIXTURES) {
    printerr('EXT_DIR and FIXTURES_DIR must be set');
    System.exit(2);
}

const load = rel => import(`file://${EXT}/${rel}`);
const UsageHistory = await load('shared/UsageHistory.js');
const Format = await load('shared/Format.js');
const FeatureTabs = await load('shared/FeatureTabs.js');
const F = await load('lib/format.js');
const Chart = await load('lib/chart-model.js');

const fixture = name => JSON.parse(new TextDecoder().decode(
    GLib.file_get_contents(`${FIXTURES}/${name}.json`)[1]));
const claude = fixture('claude-success');
const openai = fixture('openai-codex-success');
const offline = fixture('claude-offline');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        print(`ok - ${name}`);
    } catch (e) {
        failures++;
        print(`not ok - ${name}\n  ${e.message}`);
    }
}
function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what} expected ${b}, got ${a}`);
}

async function historyIo(op, dataHome, points = null) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
    launcher.setenv('XDG_DATA_HOME', dataHome, true);
    if (points)
        launcher.setenv('WIDGET_HISTORY_JSON', JSON.stringify(points), true);
    const proc = launcher.spawnv([`${EXT}/tools/sh/history-io`, op]);
    const [out] = await proc.communicate_utf8_async(null, null);
    return JSON.parse(out.trim());
}

// ── shared modules ───────────────────────────────────────────────────────

check('Format.countdown formats days, hours and minutes', () => {
    const now = 1_000_000_000_000;
    eq(Format.countdown(now + ((26 * 60) + 3) * 60000, now), '1d 2h 3m');
    eq(Format.countdown(now + 5 * 60000, now), '5m');
    eq(Format.countdown(now - 1, now), 'resetting...');
    eq(Format.countdownFromEpoch(0, now), '');
});

check('FeatureTabs exports survive the ESM conversion', () => {
    eq(FeatureTabs.label('spend'), 'Usage & Spend');
    eq(FeatureTabs.isFeatureTab('overview'), true);
});

check('UsageHistory.collect merges every provider\'s historyValues', () => {
    eq(UsageHistory.collect([claude, openai, offline]), {s: 23, w: 61, cp: 58, cw: 30});
});

// ── history round trip through history-io ────────────────────────────────

const dataHome = GLib.dir_make_tmp('ai-usage-test-XXXXXX');
const t0 = 1_785_000_000_000;
const store = UsageHistory.newStore();
UsageHistory.opened(store);
UsageHistory.record(store, UsageHistory.collect([claude, openai]), t0);
const batch = UsageHistory.take(store);
check('the first reading goes out as an autosave batch', () => {
    eq(batch, {op: 'autosave', points: [{t: t0, s: 23, w: 61, cp: 58, cw: 30}]});
    eq(UsageHistory.take(store), null, 'second take while in flight');
});

const saved = await historyIo(batch.op, dataHome, batch.points);
UsageHistory.done(store, saved.data);
UsageHistory.record(store, {s: 30, w: 61, cp: 58, cw: 30}, t0 + 10 * 60000);
const second = UsageHistory.take(store);
const merged = await historyIo(second.op, dataHome, second.points);
UsageHistory.done(store, merged.data);

const reloaded = UsageHistory.newStore();
UsageHistory.adopt(reloaded, (await historyIo('autoload', dataHome)).data);
check('history-io stores and replays the series', () => {
    eq(saved.ok, true, 'autosave ok');
    eq(second.points, [{t: t0 + 10 * 60000, s: 30}], 'only the changed key is saved');
    // The file holds what was stored; the live store also shows the latest reading.
    eq(reloaded.history, store.points);
    eq(reloaded.history.length, 2);
});

check('a failed batch is retried only after the next poll', () => {
    const s = UsageHistory.newStore();
    UsageHistory.opened(s);
    UsageHistory.record(s, {s: 1}, t0);
    UsageHistory.take(s);
    UsageHistory.failed(s);
    eq(UsageHistory.take(s), null, 'right after failure');
    UsageHistory.record(s, {s: 1}, t0 + 1000);
    eq(UsageHistory.take(s)?.points, [{t: t0, s: 1}], 'after next poll');
});

// ── mapping helpers ──────────────────────────────────────────────────────

check('panel slots show the percentage, or the backend text', () => {
    eq(F.slotText(claude.slots[0]), '23%');
    eq(F.slotText(offline.slots[0]), '—');
    eq(F.slotTextColor({pct: 95, text: null}), F.DANGER);
    eq(F.slotTextColor({pct: 75, text: null}), F.WARNING);
    eq(F.slotTextColor({pct: 10, text: null}), null);
    eq(F.slotTooltip([claude, openai]), [...claude.slots, ...openai.slots].map(s => s.tooltip).join('\n'));
});

check('the active tab survives refreshes and never defaults to a feature tab', () => {
    const tabs = F.popupTabs(['overview', 'spend'], [claude, openai]);
    eq(tabs.map(t => t.id), ['overview', 'spend', 'claude', 'openai']);
    eq(F.pickActiveTab('openai', 'claude', 'claude', tabs), 'openai', 'current kept');
    eq(F.pickActiveTab('gone', 'spend', 'claude', tabs), 'spend', 'remembered');
    eq(F.pickActiveTab('', '', 'openai', tabs), 'openai', 'backend active');
    eq(F.pickActiveTab('', '', 'kiro', tabs), 'claude', 'first provider');
    eq(F.pickActiveTab('', '', 'claude', F.popupTabs(['overview'], [])), '', 'no providers yet');
});

check('chart granularity carries across providers', () => {
    eq(F.windowForGranularity(openai.chartWindows, '24h').id, 'codex_day');
    eq(F.windowForGranularity(claude.chartWindows, '24h').id, 'day');
    eq(F.windowForGranularity(claude.chartWindows, 'nope').id, 'monthly');
    eq(F.windowForGranularity([], '7d'), null);
});

check('a reset between two samples is replayed at its instant', () => {
    const win = claude.chartWindows.find(w => w.id === 'session');
    const reset = win.resetAt * 1000 - win.periodMs;
    const history = [{t: reset - 3600000, s: 40}, {t: reset + 3600000, s: 5}];
    const {series, resets} = Chart.seriesFor(history, win, reset - 4 * 3600000, reset + 2 * 3600000);
    eq(series.map(p => [p.t - reset, p.v]), [[-3600000, 40], [-1, 40], [0, 0], [3600000, 5]]);
    eq(resets, [reset]);
});

check('money series are scaled to their own maximum', () => {
    const win = {id: 'x', key: 'mv', size: 3600000, raw: true, resets: false};
    const {series, maxRaw, isCost} = Chart.seriesFor([{t: 10, mv: 2}, {t: 20, mv: 4}], win, 0, 100);
    eq([isCost, maxRaw, series.map(p => p.v)], [true, 4, [50, 100]]);
});

check('stats tiles skip figures the provider does not record', () => {
    const labels = F.statTiles(openai.details.stats).map(t => t.label);
    eq(labels.includes('tokens'), (openai.details.stats.totalTokens || 0) > 0);
    eq(labels.includes('sessions'), true);
    eq(F.statTiles({available: true}).map(t => t.label), ['sessions', 'active days', 'streak', 'longest session']);
});

check('model rows are sorted by token share', () => {
    const rows = F.modelRows({totalTokens: 100, models: {a: {total: 10}, b: {total: 90}}});
    eq(rows.map(r => [r.name, r.share]), [['b', 0.9], ['a', 0.1]]);
});

check('spend rows come from the provider cost figures', () => {
    const rows = FeatureTabs.spendProviderRows([claude, openai], {});
    eq(rows.map(r => [r.id, r.cost]), [['openai', 12.50154], ['claude', 12]]);
    eq(FeatureTabs.spendSummaryText(rows, 'USD', null), 'Metered: $24.50');
    eq(FeatureTabs.localSpendRows({actual: {costStatus: 'unavailable'}}, rows, []), []);
});

if (failures > 0) {
    printerr(`${failures} check(s) failed`);
    System.exit(1);
}
