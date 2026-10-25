import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {dailyUnitLabel, formatTokens, modelRows, shortenModelName, statTiles} from './format.js';
import {Bar, foreground, hbox, label, paragraph, rgb, spacer, vbox} from './widgets.js';

// Per-day bars from `dailySeries`, with the hovered day in the tooltip.
const DailyBars = GObject.registerClass(
class AiUsageDailyBars extends St.DrawingArea {
    _init(series, accent, unit, tooltips) {
        super._init({style_class: 'ai-usage-daily', reactive: true, x_expand: true});
        this._series = series;
        this._accent = rgb(accent);
        this._unit = unit;
        this._hover = -1;
        this.connect('motion-event', (_a, event) => {
            const [sx, sy] = event.get_coords();
            const [ok, x] = this.transform_stage_point(sx, sy);
            if (!ok)
                return Clutter.EVENT_PROPAGATE;
            const [w] = this.get_surface_size();
            const i = Math.max(0, Math.min(this._series.length - 1, Math.floor(x / w * this._series.length)));
            if (i !== this._hover) {
                this._hover = i;
                this.queue_repaint();
                const d = this._series[i];
                tooltips.show(this, `${d.date}\n${formatTokens(d.total)} ${this._unit}`, [sx, sy]);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('leave-event', () => {
            this._hover = -1;
            this.queue_repaint();
            tooltips.hide(this);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const n = this._series.length;
        const max = Math.max(1, ...this._series.map(d => d.total || 0));
        const gap = n > 60 ? 0 : 1;
        const barW = Math.max(1, (w - (n - 1) * gap) / n);
        const fg = foreground(this);
        cr.setSourceRGBA(...fg, 0.05);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        this._series.forEach((d, i) => {
            const bh = Math.max(2, h * (d.total || 0) / max);
            cr.rectangle(i * (barW + gap), h - bh, barW, bh);
            cr.setSourceRGBA(...this._accent, i === this._hover ? 1 : 0.75);
            cr.fill();
        });
        cr.$dispose();
    }
});

function tile(t, accent, tooltips) {
    const box = vbox('ai-usage-tile', {x_expand: true});
    box.add_child(label(t.value, 'ai-usage-tile-value', {style: `color: ${accent};`}));
    box.add_child(label(t.sub ? `${_(t.label)} · ${t.sub}` : _(t.label), 'ai-usage-tile-label'));
    if (t.tip)
        tooltips.attach(box, _(t.tip));
    return box;
}

// Stats sub-view for the shared `details.stats` shape.
export function statsView(stats, accent, tooltips) {
    const view = vbox('ai-usage-view ai-usage-stats');
    if (stats?.available !== true) {
        view.add_child(paragraph(_('No local activity stats yet.'), 'ai-usage-empty'));
        return view;
    }

    const head = hbox('ai-usage-section-head');
    head.add_child(label(_('Activity Stats'), 'ai-usage-section-title'));
    head.add_child(spacer());
    if (stats.favoriteModel) {
        head.add_child(label(`★ ${shortenModelName(stats.favoriteModel)}`, 'ai-usage-pill', {
            style: `color: ${accent};`,
        }));
    }
    view.add_child(head);

    const layout = new Clutter.GridLayout({column_homogeneous: true, column_spacing: 6, row_spacing: 6});
    const grid = new St.Widget({layout_manager: layout, x_expand: true});
    statTiles(stats).forEach((t, i) => layout.attach(tile(t, accent, tooltips), i % 3, Math.floor(i / 3), 1, 1));
    view.add_child(grid);

    const daily = Array.isArray(stats.dailySeries) ? stats.dailySeries
        : Array.isArray(stats.dailyTokens) ? stats.dailyTokens : [];
    if (daily.length > 1) {
        const [title, unit] = dailyUnitLabel(stats.dailyUnit);
        const box = vbox('ai-usage-section');
        box.add_child(label(_(title), 'ai-usage-dim ai-usage-small'));
        box.add_child(new DailyBars(daily, accent, _(unit), tooltips));
        view.add_child(box);
    }

    const groups = stats.topRepositories || stats.topWorkspaces || [];
    if (groups.length > 0) {
        const box = vbox('ai-usage-section');
        box.add_child(label(stats.topRepositories ? _('Top repositories') : _('Top workspaces'), 'ai-usage-dim ai-usage-small'));
        for (const g of groups) {
            const row = hbox('ai-usage-model-head');
            row.add_child(label(g.name, '', {x_expand: true}));
            row.add_child(label(_('%d sessions').format(Math.round(g.sessions || 0)), 'ai-usage-small', {style: `color: ${accent};`}));
            box.add_child(row);
        }
        view.add_child(box);
    }

    const models = modelRows(stats);
    if (models.length > 0) {
        const box = vbox('ai-usage-section');
        box.add_child(label(_('Models'), 'ai-usage-section-title'));
        for (const m of models) {
            const row = vbox('ai-usage-model');
            const top = hbox('ai-usage-model-head');
            top.add_child(label(m.short, 'ai-usage-model-name', {x_expand: true}));
            if (m.input !== undefined)
                top.add_child(label(_('%s in').format(formatTokens(m.input)), 'ai-usage-dim ai-usage-small'));
            if (m.output !== undefined)
                top.add_child(label(_('%s out').format(formatTokens(m.output)), 'ai-usage-dim ai-usage-small'));
            if (m.sessions !== undefined && m.input === undefined)
                top.add_child(label(_('%d sess').format(m.sessions), 'ai-usage-dim ai-usage-small'));
            if (m.cost > 0)
                top.add_child(label(`$${m.cost.toFixed(2)}`, 'ai-usage-small', {style: `color: ${accent};`}));
            top.add_child(label(m.share === null ? '—' : `${Math.round(m.share * 100)}%`, 'ai-usage-model-share'));
            row.add_child(top);
            row.add_child(new Bar(m.share ?? 0, accent, 'ai-usage-bar ai-usage-bar-thin'));
            box.add_child(row);
        }
        view.add_child(box);
    }

    if (stats.computedDate)
        view.add_child(label(_('computed %s').format(String(stats.computedDate).substring(0, 10)), 'ai-usage-dim ai-usage-small'));
    return view;
}
