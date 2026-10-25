// Pure display helpers (no GI imports), so tests/ can run them under plain gjs.

export const DANGER = '#ff4d4d';
export const WARNING = '#ffa64d';

// Severity colour for a percentage readout, or null for the default text colour.
export function pctColor(pct) {
    if (pct >= 90)
        return DANGER;
    if (pct >= 70)
        return WARNING;
    return null;
}

// What a panel slot shows: the backend's own text when it sends one, else the
// rounded percentage.
export function slotText(slot) {
    if (slot.text !== null && slot.text !== undefined && slot.text !== '')
        return String(slot.text);
    return `${Math.round(Number(slot.pct) || 0)}%`;
}

// Colour of a slot's label: severity for a percentage, the slot colour for text.
export function slotTextColor(slot) {
    if (slot.text !== null && slot.text !== undefined && slot.text !== '')
        return slot.color || null;
    return pctColor(Number(slot.pct) || 0);
}

export function slotTooltip(providers) {
    const lines = [];
    for (const p of providers) {
        for (const s of p.slots || []) {
            if (s.tooltip)
                lines.push(s.tooltip);
        }
    }
    return lines.join('\n');
}

// "#rrggbb" / "#rgb" → [r, g, b] in 0..1; null for anything else.
export function parseHex(hex) {
    let m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex || '');
    if (m)
        return [1, 2, 3].map(i => parseInt(m[i] + m[i], 16) / 255);
    return null;
}

// "#rrggbb" plus an alpha as a CSS rgba() string (St has no #rrggbbaa).
export function rgbaCss(hex, alpha) {
    const [r, g, b] = (parseHex(hex) ?? [0.5, 0.5, 0.5]).map(c => Math.round(c * 255));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Black or white text for a filled accent background.
export function contrastText(hex) {
    const rgb = parseHex(hex);
    if (!rgb)
        return '#ffffff';
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 0.6 ? '#1a1a1a' : '#ffffff';
}

export function formatTokens(n) {
    if (!n || n <= 0)
        return '0';
    if (n >= 1000000)
        return `${(n / 1000000).toFixed(2)}M`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}K`;
    return String(Math.round(n));
}

export function formatDuration(ms) {
    if (!ms || ms <= 0)
        return '—';
    const totalMins = Math.floor(ms / 60000);
    const d = Math.floor(totalMins / 1440);
    const h = Math.floor(totalMins % 1440 / 60);
    const m = totalMins % 60;
    const parts = [];
    if (d > 0)
        parts.push(`${d}d`);
    if (h > 0)
        parts.push(`${h}h`);
    if (d === 0 && m > 0)
        parts.push(`${m}m`);
    return parts.length ? parts.join(' ') : '<1m';
}

export function formatHour(hour) {
    if (hour === undefined || hour === null || hour < 0)
        return '—';
    return `${hour < 10 ? '0' : ''}${hour}:00`;
}

export function shortenModelName(name) {
    if (!name)
        return '';
    return name
        .replace(/gpt-4o-mini/g, '4o-mini')
        .replace(/gpt-4o/g, '4o')
        .replace(/claude-3-5-/g, '3.5-')
        .replace(/claude-3-/g, '3-')
        .replace(/claude-/g, '')
        .replace(/-\d{8}$/, '')
        .replace(/-20\d{2}-\d{2}-\d{2}$/, '');
}

export function money(value, currency) {
    const amount = Number(value || 0).toFixed(2);
    if (currency === 'CNY')
        return `¥${amount}`;
    if (currency === 'USD' || !currency)
        return `$${amount}`;
    return `${amount} ${currency}`;
}

// The quota rows a provider shows: only windows the backend marks available.
export function visibleQuotaWindows(provider) {
    return (provider?.quotaWindows || []).filter(w => w.available === true);
}

// Popup tabs: enabled feature tabs first, then the providers in envelope
// order, so a provider the backend has not answered for yet still gets none.
export function popupTabs(featureIds, providers) {
    return [
        ...featureIds.map(id => ({id, feature: true})),
        ...providers.map(p => ({id: p.id, feature: false, provider: p})),
    ];
}

// Which tab to show after new data: keep the current one while it exists,
// else reopen the remembered one, else the backend's suggestion, else the
// first provider (feature tabs are never picked by default).
export function pickActiveTab(current, remembered, active, tabs) {
    const has = id => !!id && tabs.some(t => t.id === id);
    if (has(current))
        return current;
    if (has(remembered))
        return remembered;
    const providers = tabs.filter(t => !t.feature);
    if (providers.some(t => t.id === active))
        return active;
    return providers[0]?.id ?? '';
}

// The chart window for a granularity, so the selected range carries across
// tabs; falls back to the widest window.
export function windowForGranularity(windows, granularity) {
    if (!windows?.length)
        return null;
    return windows.find(w => w.granularity === granularity) ?? windows[windows.length - 1];
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Tiles for the shared `stats` shape, in upstream's order. Tiles whose figure
// a provider does not record are left out rather than shown as zero.
export function statTiles(stats) {
    const s = stats || {};
    const tiles = [];
    const add = (value, label, sub = '', tip = '') => tiles.push({value, label, sub, tip});
    if ((s.totalTokens || 0) > 0)
        add(formatTokens(s.totalTokens), 'tokens', '', 'Total tokens across all models');
    add(String(Math.round(s.totalSessions || 0)), 'sessions', '', `${formatTokens(s.totalMessages || 0)} messages total`);
    add(`${Math.round(s.activeDays || 0)}${(s.spanDays || 0) > 0 ? `/${Math.round(s.spanDays)}` : ''}`,
        'active days', '', s.firstDate ? `Since ${s.firstDate}` : '');
    add(`${Math.round(s.currentStreak || 0)}d`, 'streak', `best ${Math.round(s.longestStreak || 0)}d`,
        'Current consecutive-day streak');
    add(formatDuration(s.longestSessionMs || 0), 'longest session',
        (s.longestSessionMessages || 0) > 0 ? plural(Math.round(s.longestSessionMessages), 'msg', 'msgs') : '');
    if (s.peakHour !== undefined && s.peakHour !== null && s.peakHour >= 0)
        add(formatHour(s.peakHour), 'peak hour', '', 'Hour of day with the most activity');
    if ((s.totalToolCalls || 0) > 0)
        add(formatTokens(s.totalToolCalls), 'tool calls', '', 'Total tool invocations across all sessions');
    if ((s.totalCostUSD || 0) > 0)
        add(money(s.totalCostUSD, s.currency || 'USD'), 'spend', '', 'Total cost across all models');
    if ((s.totalWebSearches || 0) > 0)
        add(formatTokens(s.totalWebSearches), 'web searches');
    if ((s.totalFiles || 0) > 0)
        add(formatTokens(s.totalFiles), 'files touched');
    if ((s.totalRepositories || 0) > 0)
        add(String(Math.round(s.totalRepositories)), 'repos');
    return tiles;
}

export function dailyUnitLabel(unit) {
    if (unit === 'requests')
        return ['Requests / day', 'requests'];
    if (unit === 'messages')
        return ['Messages / day', 'messages'];
    return ['Tokens / day', 'tokens'];
}

// Model rows sorted by token total, each with its share of all tokens.
export function modelRows(stats) {
    const models = stats?.models && typeof stats.models === 'object' ? stats.models : {};
    const total = stats?.totalTokens || 0;
    return Object.keys(models)
        .map(name => {
            const m = models[name] || {};
            return {
                name,
                short: shortenModelName(name),
                input: m.input,
                output: m.output,
                sessions: m.sessions,
                cost: m.cost || 0,
                share: total > 0 ? Math.min(1, Math.max(0, (m.total || 0) / total)) : null,
                total: m.total || 0,
            };
        })
        .sort((a, b) => b.total - a.total);
}
