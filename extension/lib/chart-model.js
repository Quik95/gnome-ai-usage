// What the usage chart plots for one chartWindows entry, without any drawing
// (no GI imports), so tests/ can run it under plain gjs. Mirrors the series
// extraction of upstream's hyprland/UsageChart.qml.

import * as UsageHistory from '../shared/UsageHistory.js';

// A drop larger than this between two samples of a resetting window is drawn
// as a reset marker.
const RESET_DROP = 6;

export function hasSeriesData(history, key) {
    return (history || []).some(p => UsageHistory.isValue(p[key]));
}

export function oldestPoint(history, key) {
    return (history || []).find(p => UsageHistory.isValue(p[key]))?.t ?? 0;
}

// The visible range for a window paged back by `offsetMs` from `nowMs`.
export function range(win, nowMs, offsetMs) {
    const maxT = nowMs - offsetMs;
    return {minT: maxT - win.size, maxT};
}

// {series: [{t, v, raw?}], resets: [t], isCost, maxRaw} for the visible range.
// Resetting windows get the resets that fell between samples replayed
// (UsageHistory.withResets); money series are scaled to their own maximum.
export function seriesFor(history, win, minT, maxT) {
    const points = history || [];
    const lo = UsageHistory.lowerBound(points, minT);
    const hi = UsageHistory.upperBound(points, maxT);
    let series = [];
    for (let i = lo; i < hi; i++) {
        const v = points[i][win.key];
        if (UsageHistory.isValue(v))
            series.push({t: points[i].t, v});
    }

    const resetting = win.resets === true;
    if (resetting && win.resetAt)
        series = UsageHistory.withResets(series, win.resetAt * 1000, win.periodMs, minT, maxT);

    const isCost = win.raw === true;
    let maxRaw = 0;
    if (isCost && series.length > 0) {
        maxRaw = Math.max(...series.map(p => p.v));
        if (maxRaw > 0)
            series = series.map(p => ({t: p.t, v: p.v / maxRaw * 100, raw: p.v}));
    }

    const resets = [];
    if (resetting) {
        for (let i = 1; i < series.length; i++) {
            if (series[i - 1].v - series[i].v > RESET_DROP)
                resets.push(series[i].t);
        }
    }
    return {series, resets, isCost, maxRaw};
}

// Index of the sample nearest to `t`, or -1 for an empty series.
export function nearestIndex(series, t) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < series.length; i++) {
        const d = Math.abs(series[i].t - t);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

export function costLabel(value, currency, digits = 2) {
    const amount = Number(value || 0).toFixed(digits);
    if (currency === 'CNY')
        return `¥${amount}`;
    if (currency === 'USD')
        return `$${amount}`;
    return currency ? `${amount} ${currency}` : amount;
}
