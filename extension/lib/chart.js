import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import cairo from 'cairo';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {costLabel, hasSeriesData, nearestIndex, oldestPoint, range, seriesFor} from './chart-model.js';
import {contrastText} from './format.js';
import {foreground, hbox, label, rgb, roundedRect, spacer} from './widgets.js';

const DAY_MS = 24 * 3600000;
const PAD = {left: 36, right: 8, top: 14, bottom: 26};

function fmt(ms, pattern) {
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format(pattern);
}

function rangeText(minT, maxT, size) {
    if (size <= DAY_MS) {
        if (fmt(minT, '%F') === fmt(maxT, '%F'))
            return `${fmt(minT, '%H:%M')} – ${fmt(maxT, '%H:%M')} (${fmt(maxT, '%b %-d')})`;
        return `${fmt(minT, '%b %-d, %H:%M')} – ${fmt(maxT, '%b %-d, %H:%M')}`;
    }
    return `${fmt(minT, '%b %-d')} – ${fmt(maxT, '%b %-d')}`;
}

// The curve itself: grid, glow + fill + line, reset markers, axis labels and
// a hover scrub with its readout, all in one Cairo pass.
const ChartCanvas = GObject.registerClass(
class AiUsageChartCanvas extends St.DrawingArea {
    _init(chart) {
        super._init({style_class: 'ai-usage-chart-canvas', reactive: true, x_expand: true});
        this._chart = chart;
        this._scrub = -1;
        this.connect('motion-event', (_a, event) => {
            const [sx, sy] = event.get_coords();
            const [ok, x] = this.transform_stage_point(sx, sy);
            if (ok)
                this._scrubAt(x);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('leave-event', () => {
            this._scrub = -1;
            this.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _scrubAt(x) {
        const model = this._chart.model;
        if (!model || model.series.length === 0)
            return;
        // get_surface_size() is only meaningful inside a repaint.
        const w = this.width;
        const pw = w - PAD.left - PAD.right;
        const t = model.minT + (x - PAD.left) / pw * (model.maxT - model.minT);
        const i = nearestIndex(model.series, t);
        if (i !== this._scrub) {
            this._scrub = i;
            this.queue_repaint();
        }
    }

    clearScrub() {
        this._scrub = -1;
    }

    _layout(cr, text, size = 7.5, bold = false) {
        const layout = PangoCairo.create_layout(cr);
        const font = this.get_theme_node().get_font()?.copy() ?? Pango.FontDescription.from_string('Sans');
        font.set_size(size * Pango.SCALE);
        if (bold)
            font.set_weight(Pango.Weight.BOLD);
        layout.set_font_description(font);
        layout.set_text(text, -1);
        return layout;
    }

    _text(cr, text, x, y, align, rgba, size, bold) {
        const layout = this._layout(cr, text, size, bold);
        const [tw, th] = layout.get_pixel_size();
        const dx = align === 'right' ? -tw : align === 'center' ? -tw / 2 : 0;
        cr.setSourceRGBA(...rgba);
        cr.moveTo(x + dx, y - th / 2);
        PangoCairo.show_layout(cr, layout);
        return [tw, th];
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            if (this.get_stage())
                this._paint(cr);
        } finally {
            cr.$dispose();
        }
    }

    _paint(cr) {
        const model = this._chart.model;
        if (!model)
            return;
        const [w, h] = this.get_surface_size();
        const fg = foreground(this);
        const accent = rgb(this._chart.accent);
        const pw = w - PAD.left - PAD.right;
        const ph = h - PAD.top - PAD.bottom;
        const {minT, maxT, series, resets, isCost, maxRaw} = model;
        const span = maxT - minT;
        const px = t => PAD.left + (t - minT) / span * pw;
        const py = v => PAD.top + ph - v / 100 * ph * 0.88 - ph * 0.04;

        // dashed grid at 25 / 50 / 75 / 100 %
        cr.save();
        cr.setDash([3, 5], 0);
        cr.setLineWidth(1);
        cr.setSourceRGBA(...fg, 0.1);
        for (const pct of [25, 50, 75, 100]) {
            cr.moveTo(PAD.left, py(pct) + 0.5);
            cr.lineTo(PAD.left + pw, py(pct) + 0.5);
            cr.stroke();
        }
        cr.restore();

        // y labels
        const yLabel = f => isCost
            ? (maxRaw > 0 ? costLabel(maxRaw * f, this._chart.currency) : '')
            : `${Math.round(f * 100)}%`;
        for (const f of [1, 0.5, 0])
            this._text(cr, yLabel(f), PAD.left - 4, py(f * 100), 'right', [...fg, 0.4]);

        // x endpoint labels, hidden when a reset label would sit on top of them
        const hourly = span <= DAY_MS;
        const crowded = frac => resets.some(r => {
            const f = (r - minT) / span;
            return f > 0 && f < 1 && Math.abs(f - frac) < 0.1;
        });
        const xLabel = t => hourly ? fmt(t, '%H:%M') : fmt(t, '%b %-d %H:%M');
        const yAxis = PAD.top + ph + 12;
        if (!crowded(0))
            this._text(cr, xLabel(minT), PAD.left, yAxis, 'left', [...fg, 0.45]);
        if (!crowded(1))
            this._text(cr, xLabel(maxT), PAD.left + pw, yAxis, 'right', [...fg, 0.45]);

        if (series.length === 0) {
            this._text(cr, _('No data in this range'), PAD.left + pw / 2, PAD.top + ph / 2, 'center', [...fg, 0.5], 9);
            return;
        }

        this._curve(cr, series, px, py, accent, PAD.top + ph);

        // reset markers: dashed line, accent pip, time underneath, one caption
        const weekly = this._chart.windowId.includes('weekly') || span > DAY_MS * 2;
        const caption = weekly ? _('week reset') : _('5h reset');
        let captioned = false;
        for (let i = resets.length - 1; i >= 0; i--) {
            const t = resets[i];
            if (t <= minT || t >= maxT)
                continue;
            const x = px(t);
            cr.save();
            cr.setDash([2, 4], 0);
            cr.setLineWidth(1);
            cr.setSourceRGBA(...fg, 0.25);
            cr.moveTo(x + 0.5, PAD.top);
            cr.lineTo(x + 0.5, PAD.top + ph);
            cr.stroke();
            cr.restore();
            cr.arc(x, PAD.top + ph, 2, 0, 2 * Math.PI);
            cr.setSourceRGBA(...accent, 0.85);
            cr.fill();
            if (!captioned) {
                const [tw] = this._layout(cr, caption).get_pixel_size();
                this._text(cr, caption, Math.min(Math.max(x + 3, PAD.left), PAD.left + pw - tw), PAD.top - 6, 'left', [...fg, 0.5]);
                captioned = true;
            }
            const when = weekly ? fmt(t, '%b %-d') : fmt(t, '%H:%M');
            const [ww] = this._layout(cr, when).get_pixel_size();
            const cx = Math.min(Math.max(x, PAD.left + ww / 2), PAD.left + pw - ww / 2);
            this._text(cr, when, cx, yAxis, 'center', [...accent, 0.9]);
        }

        if (this._scrub >= 0 && this._scrub < series.length)
            this._drawScrub(cr, series[this._scrub], px, py, accent, w, PAD.top + ph, isCost);
    }

    _curve(cr, pts, px, py, [r, g, b], bottom) {
        if (pts.length === 1) {
            const x = PAD.left + (this.get_surface_size()[0] - PAD.left - PAD.right) / 2;
            this._dot(cr, x, py(pts[0].v), [r, g, b]);
            return;
        }
        const path = () => {
            cr.moveTo(px(pts[0].t), py(pts[0].v));
            for (let i = 0; i < pts.length - 1; i++) {
                const x0 = px(pts[i].t), y0 = py(pts[i].v);
                const x1 = px(pts[i + 1].t), y1 = py(pts[i + 1].v);
                const cx = x0 + (x1 - x0) / 2;
                cr.curveTo(cx, y0, cx, y1, x1, y1);
            }
        };
        cr.setLineJoin(cairo.LineJoin.ROUND);
        cr.setLineCap(cairo.LineCap.ROUND);
        for (const [alpha, width] of [[0.08, 14], [0.18, 8], [0.4, 4]]) {
            path();
            cr.setSourceRGBA(r, g, b, alpha);
            cr.setLineWidth(width);
            cr.stroke();
        }

        const grad = new cairo.LinearGradient(0, PAD.top, 0, bottom);
        grad.addColorStopRGBA(0, r, g, b, 0.24);
        grad.addColorStopRGBA(0.6, r, g, b, 0.06);
        grad.addColorStopRGBA(1, r, g, b, 0);
        path();
        cr.lineTo(px(pts[pts.length - 1].t), bottom);
        cr.lineTo(px(pts[0].t), bottom);
        cr.closePath();
        cr.setSource(grad);
        cr.fill();

        path();
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(2);
        cr.stroke();

        const last = pts[pts.length - 1];
        this._dot(cr, px(last.t), py(last.v), [r, g, b]);
    }

    _dot(cr, x, y, [r, g, b]) {
        cr.arc(x, y, 7, 0, 2 * Math.PI);
        cr.setSourceRGBA(r, g, b, 0.18);
        cr.fill();
        cr.arc(x, y, 4, 0, 2 * Math.PI);
        cr.setSourceRGBA(r, g, b, 1);
        cr.fill();
        cr.arc(x, y, 1.8, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.fill();
    }

    _drawScrub(cr, pt, px, py, accent, w, bottom, isCost) {
        const x = px(pt.t);
        const y = py(pt.v);
        cr.save();
        cr.setDash([2, 3], 0);
        cr.setLineWidth(1);
        cr.setSourceRGBA(...accent, 0.5);
        cr.moveTo(x + 0.5, PAD.top);
        cr.lineTo(x + 0.5, bottom);
        cr.stroke();
        cr.restore();
        cr.arc(x, y, 5, 0, 2 * Math.PI);
        cr.setSourceRGBA(...accent, 1);
        cr.fill();
        cr.arc(x, y, 2, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.fill();

        const value = isCost ? costLabel(pt.raw ?? 0, this._chart.currency, 4) : `${Math.round(pt.v)}%`;
        const text = `${value}  ·  ${fmt(pt.t, '%b %-d, %H:%M')}`;
        const layout = this._layout(cr, text, 8.5, true);
        const [tw, th] = layout.get_pixel_size();
        const bw = tw + 14, bh = th + 8;
        const bx = Math.max(0, Math.min(x - bw / 2, w - bw - 4));
        const by = Math.max(2, y - bh - 8);
        roundedRect(cr, bx, by, bw, bh, 6);
        cr.setSourceRGBA(0, 0, 0, 0.75);
        cr.fill();
        cr.setSourceRGBA(...accent, 1);
        cr.moveTo(bx + 7, by + 4);
        PangoCairo.show_layout(cr, layout);
    }
});

// Usage-history card for the active provider: range paging, the window
// toggle from `chartWindows`, and the canvas. `onSelect(id)` reports a window
// pick so the popup can remember its granularity across tabs.
export const UsageChart = GObject.registerClass(
class AiUsageChart extends St.BoxLayout {
    _init(onSelect) {
        super._init({style_class: 'ai-usage-chart', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._onSelect = onSelect;
        this.history = [];
        this.windows = [];
        this.windowId = '';
        this.accent = '#7dd3fc';
        this.currency = '';
        this.offsetMs = 0;
        this.model = null;

        const nav = hbox('ai-usage-chart-nav');
        this._prev = this._navButton('‹', () => this._page(1));
        this._next = this._navButton('›', () => this._page(-1));
        this._range = label('', 'ai-usage-chart-range');
        this._windowsBox = hbox('ai-usage-chart-windows');
        for (const a of [this._prev, this._range, this._next, spacer(), this._windowsBox])
            nav.add_child(a);
        this.add_child(nav);

        this._canvas = new ChartCanvas(this);
        this.add_child(this._canvas);
    }

    _navButton(text, cb) {
        const b = new St.Button({style_class: 'ai-usage-chart-button', label: text, can_focus: true});
        b.connect('clicked', cb);
        return b;
    }

    // Returns false when there is nothing to chart (no windows, or the series
    // has never been recorded), so the caller can hide the card.
    update({history, windows, windowId, accent, currency}) {
        if (windowId !== this.windowId)
            this.offsetMs = 0;
        this.history = history || [];
        this.windows = windows || [];
        this.windowId = windowId;
        this.accent = accent;
        this.currency = currency || '';
        const win = this._window;
        if (!win || !hasSeriesData(this.history, win.key))
            return false;
        this._rebuild();
        return true;
    }

    get _window() {
        return this.windows.find(w => w.id === this.windowId) ?? this.windows[0] ?? null;
    }

    _page(direction) {
        const win = this._window;
        if (!win)
            return;
        this.offsetMs = Math.max(0, this.offsetMs + direction * win.size);
        this._canvas.clearScrub();
        this._rebuild();
    }

    _rebuild() {
        const win = this._window;
        const {minT, maxT} = range(win, Date.now(), this.offsetMs);
        this.model = {minT, maxT, ...seriesFor(this.history, win, minT, maxT)};
        this._range.text = rangeText(minT, maxT, win.size);
        const oldest = oldestPoint(this.history, win.key);
        this._prev.reactive = oldest > 0 && minT > oldest;
        this._prev.opacity = this._prev.reactive ? 255 : 80;
        this._next.reactive = this.offsetMs > 0;
        this._next.opacity = this._next.reactive ? 255 : 80;

        this._windowsBox.destroy_all_children();
        if (this.windows.length > 1) {
            for (const w of this.windows) {
                const active = w.id === win.id;
                const b = new St.Button({
                    style_class: `ai-usage-chart-button${active ? ' active' : ''}`,
                    label: w.label,
                    can_focus: true,
                    style: active ? `background-color: ${this.accent}; color: ${contrastText(this.accent)};` : '',
                });
                b.connect('clicked', () => this._onSelect(w.id));
                this._windowsBox.add_child(b);
            }
        }
        this._canvas.queue_repaint();
    }
});
