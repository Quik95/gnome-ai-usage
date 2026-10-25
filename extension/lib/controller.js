import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import * as UsageHistory from '../shared/UsageHistory.js';
import {enabledProviders} from './providers.js';
import {run, isCancelled} from './subprocess.js';

// A history save that never answers would hold its batch in flight for the
// rest of the session; after this long it is killed and counted as failed.
const SAVE_WATCHDOG_SECONDS = 30;

// Owns the backend transport: fetching envelopes, replaying the last one on
// start, and mirroring usage history through history-io. The UI only reads
// the state below and listens for:
//   'changed'          — providers / localSpend / updatedAt / errorText
//   'loading-changed'  — a fetch started or finished
//   'history-changed'  — usageHistory was replaced
export class Controller extends EventEmitter {
    constructor(extension) {
        super();
        this._settings = extension.getSettings();
        const tools = GLib.build_filenamev([extension.path, 'tools', 'sh']);
        this._getAiUsage = GLib.build_filenamev([tools, 'get-ai-usage']);
        this._historyIo = GLib.build_filenamev([tools, 'history-io']);

        this.providers = [];
        this.localSpend = {};
        this.active = '';
        this.updatedAt = 0;
        this.errorText = '';
        this.loading = false;
        this.stale = false;
        this.usageHistory = [];

        this._cancellable = new Gio.Cancellable();
        this._procs = new Set();
        this._liveSeen = false;
        this._lastFetchMs = 0;
        this._fetchQueued = false;

        this._store = UsageHistory.newStore();
        this._saving = false;
        this._saveId = 0;
        this._watchdogId = 0;

        this._pollId = 0;
        this._settingsIds = [
            this._settings.connect('changed::poll-interval', () => this._schedulePoll()),
            this._settings.connect('changed::enabled-providers', () => {
                this._filterToEnabled();
                this.refresh();
            }),
        ];
    }

    start() {
        this._loadHistory();
        this._replayThenFetch();
        this._schedulePoll();
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
        if (this._watchdogId)
            GLib.source_remove(this._watchdogId);
        this._watchdogId = 0;
        this._cancellable.cancel();
        for (const proc of this._procs)
            proc.force_exit();
        this._procs.clear();
        this.disconnectAll();
        this._settings = null;
    }

    get pollIntervalMs() {
        return this._settings.get_uint('poll-interval') * 1000;
    }

    // Fetch unless one is running. A request made while one runs (provider
    // list changed) is queued once, so the new list is fetched right after.
    refresh() {
        if (this.loading) {
            this._fetchQueued = true;
            return;
        }
        this._fetch().catch(logError);
    }

    // Popup opened: fetch only when the data is older than the poll interval.
    refreshIfOld() {
        if (Date.now() - this._lastFetchMs >= this.pollIntervalMs)
            this.refresh();
    }

    _run(argv, env = {}) {
        return run(argv, {env, cancellable: this._cancellable, procs: this._procs});
    }

    _schedulePoll() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_uint('poll-interval'), () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _replayThenFetch() {
        try {
            const text = await this._run([this._getAiUsage, '--last-snapshot']);
            this._apply(text, true);
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'ai-usage: --last-snapshot');
        }
        this.refresh();
    }

    async _fetch() {
        const ids = enabledProviders(this._settings);
        this._lastFetchMs = Date.now();
        if (ids.length === 0) {
            this._apply('{"providers": []}', false);
            return;
        }

        this._setLoading(true);
        try {
            const text = await this._run([this._getAiUsage, '--save-snapshot', '--provider', ids.join(',')]);
            this._apply(text, false);
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'ai-usage: fetch');
            this.errorText = 'usage backend unavailable';
            this.emit('changed');
        } finally {
            if (!this._cancellable.is_cancelled()) {
                this._setLoading(false);
                if (this._fetchQueued) {
                    this._fetchQueued = false;
                    this.refresh();
                }
            }
        }
    }

    _setLoading(loading) {
        if (this.loading === loading)
            return;
        this.loading = loading;
        this.emit('loading-changed');
    }

    // A replayed snapshot arrives before the first live answer and is shown
    // stale; once a live one has been applied, a late replay is dropped.
    _apply(text, replayed) {
        if (replayed && this._liveSeen)
            return;

        let data;
        try {
            data = JSON.parse((text || '').trim() || '{}');
        } catch {
            if (!replayed) {
                this.errorText = 'usage backend returned no data';
                this.emit('changed');
            }
            return;
        }
        if (replayed && !Array.isArray(data.providers))
            return;
        if (!replayed)
            this._liveSeen = true;

        this._envelopeProviders = (data.providers || []).map(p => replayed ? {...p, stale: true} : p);
        this.localSpend = data.localSpend || {};
        this.updatedAt = data.updatedAt || 0;
        this.active = data.active || '';
        this.stale = replayed;
        this.errorText = '';
        this._filterToEnabled(false);
        this.emit('changed');

        if (!replayed)
            this._recordHistory();
    }

    // The envelope may carry providers that were switched off since (a replayed
    // snapshot merges every past fetch), so the UI only ever sees enabled ones.
    _filterToEnabled(emit = true) {
        const ids = enabledProviders(this._settings);
        this.providers = (this._envelopeProviders || []).filter(p => ids.includes(p.id));
        if (emit)
            this.emit('changed');
    }

    providerById(id) {
        return this.providers.find(p => p.id === id) ?? null;
    }

    // ── Usage history ──────────────────────────────────────────────────────
    // tools/sh/history-io owns the shared file; UsageHistory.js decides what
    // goes out and when. The file is never written before it has been read.

    _syncHistory() {
        if (this.usageHistory === this._store.history)
            return;
        this.usageHistory = this._store.history;
        this.emit('history-changed');
    }

    _recordHistory() {
        UsageHistory.record(this._store, UsageHistory.collect(this.providers), Date.now());
        this._syncHistory();
        this._saveHistory();
    }

    async _loadHistory() {
        try {
            const text = await this._run([this._historyIo, 'autoload']);
            const res = JSON.parse(text.trim() || '{}');
            if (Array.isArray(res.data)) {
                UsageHistory.adopt(this._store, res.data);
                this._syncHistory();
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            logError(e, 'ai-usage: history autoload');
        }
        UsageHistory.opened(this._store);
        this._saveHistory();
    }

    // One batch in flight. The next one goes once this process is reaped;
    // after a failure take() hands out nothing until the next poll records.
    async _saveHistory() {
        if (this._saving)
            return;
        const batch = UsageHistory.take(this._store);
        if (!batch)
            return;

        this._saving = true;
        const id = ++this._saveId;
        let proc = null;
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAVE_WATCHDOG_SECONDS, () => {
            this._watchdogId = 0;
            this._saveId++;
            proc?.force_exit();
            UsageHistory.failed(this._store);
            return GLib.SOURCE_REMOVE;
        });

        let res = null;
        try {
            const text = await run([this._historyIo, batch.op], {
                env: {WIDGET_HISTORY_JSON: JSON.stringify(batch.points)},
                cancellable: this._cancellable,
                procs: this._procs,
                onSpawn: p => {
                    proc = p;
                },
            });
            res = JSON.parse(text.trim());
        } catch (e) {
            if (isCancelled(e))
                return;
            if (!(e instanceof SyntaxError))
                logError(e, 'ai-usage: history save');
        }

        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }
        this._saving = false;
        // The watchdog already failed this batch; a late answer changes nothing.
        if (id !== this._saveId)
            return;

        if (!res || res.error) {
            UsageHistory.failed(this._store);
            return;
        }
        // The degraded write answers {"ok":true} with no series.
        UsageHistory.done(this._store, res.data);
        this._syncHistory();
        this._saveHistory();
    }
}
