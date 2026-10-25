import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as FeatureTabs from '../shared/FeatureTabs.js';
import {money, pctColor} from './format.js';
import {Bar, hbox, label, paragraph, spacer, vbox} from './widgets.js';

function logoBadge(provider, icons) {
    const badge = new St.Bin({style_class: 'ai-usage-badge', y_align: Clutter.ActorAlign.CENTER});
    const gicon = icons.logo(provider);
    badge.set_child(gicon
        ? new St.Icon({gicon, style_class: 'ai-usage-badge-icon'})
        : new St.Widget({style_class: 'ai-usage-dot', style: `background-color: ${provider.accent || '#38bdf8'};`}));
    return badge;
}

// Every enabled provider with its headline and per-window meters; a click
// opens its tab.
export function overviewView(providers, icons, onOpen) {
    const view = vbox('ai-usage-view ai-usage-overview');
    if (providers.length === 0) {
        view.add_child(paragraph(_('Enable a provider in Settings to see it here.'), 'ai-usage-empty'));
        return view;
    }
    for (const p of providers) {
        const accent = p.accent || '#38bdf8';
        const card = new St.Button({style_class: 'ai-usage-card', can_focus: true, x_expand: true});
        card.connect('clicked', () => onOpen(p.id));
        const body = hbox('ai-usage-card-body', {x_expand: true});
        body.add_child(logoBadge(p, icons));

        const col = vbox('ai-usage-card-col', {x_expand: true});
        const head = hbox('ai-usage-card-head');
        head.add_child(label(p.label || p.id, 'ai-usage-card-title'));
        if (p.stale)
            head.add_child(label(_('stale'), 'ai-usage-dim ai-usage-small'));
        head.add_child(spacer());
        if (p.summary?.text)
            head.add_child(label(p.summary.text, 'ai-usage-card-pct', {style: `color: ${accent};`}));
        col.add_child(head);

        if (p.error) {
            col.add_child(label(p.error, 'ai-usage-card-error'));
        } else {
            for (const w of (p.quotaWindows || []).filter(q => q.available === true && q.showMeter !== false)) {
                const row = hbox('ai-usage-card-window');
                row.add_child(label(w.label || w.key, 'ai-usage-card-window-label'));
                row.add_child(new Bar((Number(w.pct) || 0) / 100, w.color || accent, 'ai-usage-bar ai-usage-card-bar'));
                const pct = Math.round(Number(w.pct) || 0);
                row.add_child(label(`${pct}%`, 'ai-usage-card-window-pct', {
                    style: pctColor(pct) ? `color: ${pctColor(pct)};` : '',
                }));
                col.add_child(row);
            }
        }
        if (p.summary?.detail)
            col.add_child(label(p.summary.detail, 'ai-usage-dim ai-usage-small'));
        body.add_child(col);
        card.set_child(body);
        view.add_child(card);
    }
    return view;
}

// Provider cost figures plus the local session aggregates, both from the
// shared FeatureTabs mapping so the totals match the other frontends.
export function spendRows(providers, localSpend) {
    const rows = FeatureTabs.spendProviderRows(providers, localSpend);
    const local = FeatureTabs.localSpendRows(localSpend, rows, providers);
    const all = rows.concat(local);
    all.sort((a, b) => b.cost - a.cost);
    return all;
}

// Claude's extra-usage allowance, or any provider reporting one the same way.
function extraUsageRows(providers) {
    const out = [];
    for (const p of providers) {
        const x = p.details?.extraUsage;
        if (!x?.enabled)
            continue;
        out.push({
            provider: p,
            used: money(x.used, x.currency || 'USD'),
            limit: x.limit ? money(x.limit, x.currency || 'USD') : '',
            pct: Number(x.pct) || 0,
        });
    }
    return out;
}

export function spendSummary(providers, localSpend) {
    return FeatureTabs.spendSummaryText(spendRows(providers, localSpend), 'USD', null);
}

export function spendView(providers, localSpend, icons, onOpen) {
    const view = vbox('ai-usage-view ai-usage-spend');
    view.add_child(paragraph(_("Totals come from each provider's own usage APIs and local CLI logs. Ranges differ (30-day, all-time, lifetime)."), 'ai-usage-dim ai-usage-small'));

    const rows = spendRows(providers, localSpend);
    const extras = extraUsageRows(providers);
    if (rows.length === 0 && extras.length === 0) {
        const empty = vbox('ai-usage-spend-empty');
        empty.add_child(label(_('No cost figures yet'), 'ai-usage-section-title'));
        const groups = ['actual', 'estimated', 'subscription', 'subscriptionActual'];
        const unavailable = groups.every(g => (localSpend?.[g]?.costStatus ?? 'unavailable') === 'unavailable');
        empty.add_child(paragraph(unavailable
            ? _('The providers report no API spend, and no local session could be priced. Subscription usage is covered by the plan.')
            : _('Enable providers that report spend, or use them until local logs appear.'), 'ai-usage-dim ai-usage-small'));
        view.add_child(empty);
        return view;
    }

    for (const r of rows) {
        const provider = providers.find(p => p.id === r.id);
        const card = new St.Button({
            style_class: 'ai-usage-card',
            can_focus: true,
            reactive: !r.local && !!provider,
            x_expand: true,
        });
        if (provider && !r.local)
            card.connect('clicked', () => onOpen(r.id));
        const body = hbox('ai-usage-card-body', {x_expand: true});
        body.add_child(logoBadge(provider ?? {accent: r.accent, icon: r.icon}, icons));
        const col = vbox('ai-usage-card-col', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        col.add_child(label(_(r.label), 'ai-usage-card-title'));
        if (r.note)
            col.add_child(label(_(r.note), 'ai-usage-dim ai-usage-small'));
        body.add_child(col);
        body.add_child(label(FeatureTabs.formatMoney(r.cost, r.currency || 'USD'), 'ai-usage-money'));
        card.set_child(body);
        view.add_child(card);
    }

    for (const x of extras) {
        const card = vbox('ai-usage-card');
        const head = hbox('ai-usage-card-body');
        head.add_child(logoBadge(x.provider, icons));
        head.add_child(label(_('%s extra usage').format(x.provider.label), 'ai-usage-card-title', {x_expand: true}));
        head.add_child(label(x.limit ? `${x.used} / ${x.limit}` : x.used, 'ai-usage-money'));
        card.add_child(head);
        if (x.limit)
            card.add_child(new Bar(x.pct / 100, x.provider.accent, 'ai-usage-bar'));
        view.add_child(card);
    }
    return view;
}
