import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Format from '../shared/Format.js';
import {parseHex, pctColor} from './format.js';

// The widget's own text colour as [r, g, b] in 0..1, so Cairo drawings follow
// the shell theme (light or dark) instead of hardcoding white.
export function foreground(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    return [c.red / 255, c.green / 255, c.blue / 255];
}

export function rgb(hex, fallback = '#7dd3fc') {
    return parseHex(hex) ?? parseHex(fallback);
}

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, `ai-usage: open ${uri}`);
    }
}

export function label(text, styleClass = '', props = {}) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

// Wrapping body text.
export function paragraph(text, styleClass = '') {
    const l = new St.Label({text: text ?? '', style_class: styleClass, x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

export function hbox(styleClass = '', props = {}) {
    return new St.BoxLayout({style_class: styleClass, ...props});
}

export function vbox(styleClass = '', props = {}) {
    return new St.BoxLayout({style_class: styleClass, orientation: Clutter.Orientation.VERTICAL, ...props});
}

export function spacer() {
    return new St.Widget({x_expand: true});
}

// A 20-segment meter with a partial last segment, as the upstream rows draw it.
export const SegmentMeter = GObject.registerClass(
class AiUsageSegmentMeter extends St.DrawingArea {
    _init(pct, color, segments = 20) {
        super._init({style_class: 'ai-usage-meter', x_expand: true});
        this._pct = Math.max(0, Math.min(100, Number(pct) || 0));
        this._color = rgb(color);
        this._segments = segments;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = foreground(this);
        const gap = 3;
        const n = this._segments;
        const segW = (w - (n - 1) * gap) / n;
        const step = 100 / n;
        for (let i = 0; i < n; i++) {
            const x = i * (segW + gap);
            roundedRect(cr, x + 0.5, 0.5, segW - 1, h - 1, 2);
            cr.setSourceRGBA(...fg, 0.06);
            cr.fillPreserve();
            cr.setSourceRGBA(...fg, 0.12);
            cr.setLineWidth(1);
            cr.stroke();

            const ratio = this._pct >= (i + 1) * step ? 1 : this._pct <= i * step ? 0 : (this._pct - i * step) / step;
            if (ratio <= 0)
                continue;
            const fw = Math.max(0, (segW - 2) * ratio);
            const grad = new cairo.LinearGradient(x + 1, 0, x + 1 + segW, 0);
            const [r, g, b] = this._color;
            grad.addColorStopRGBA(0, Math.min(1, r * 1.15), Math.min(1, g * 1.15), Math.min(1, b * 1.15), 1);
            grad.addColorStopRGBA(1, r, g, b, 1);
            roundedRect(cr, x + 1, 1, fw, h - 2, 1.5);
            cr.setSource(grad);
            cr.fill();
        }
        cr.$dispose();
    }
});

// A thin single bar (overview, models), filled to `fraction` of the width.
export const Bar = GObject.registerClass(
class AiUsageBar extends St.DrawingArea {
    _init(fraction, color, styleClass = 'ai-usage-bar') {
        super._init({style_class: styleClass, x_expand: true});
        this._fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
        this._color = rgb(color);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = foreground(this);
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.setSourceRGBA(...fg, 0.08);
        cr.fill();
        if (this._fraction > 0) {
            roundedRect(cr, 0, 0, Math.max(h, w * this._fraction), h, h / 2);
            cr.setSourceRGBA(...this._color, 1);
            cr.fill();
        }
        cr.$dispose();
    }
});

export function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// One quotaWindows entry: label, reset time, live countdown chip, percentage,
// meter and detail line. `countdowns` collects the chips the popup's clock
// ticks; each entry is [label, resetAt].
export function quotaRow(win, accent, countdowns, nowMs) {
    const row = vbox('ai-usage-quota-row');
    const head = hbox('ai-usage-quota-head');
    row.add_child(head);
    head.add_child(label(win.label || win.key, 'ai-usage-quota-label'));

    if (win.available !== true) {
        row.add_style_class_name('unavailable');
        head.add_child(spacer());
        head.add_child(label(_('unavailable'), 'ai-usage-dim'));
        if (win.detail)
            row.add_child(paragraph(win.detail, 'ai-usage-quota-detail'));
        return row;
    }

    if (win.resetText)
        head.add_child(label(`· ${win.resetText}`, 'ai-usage-dim ai-usage-small'));
    head.add_child(spacer());

    if (win.resetAt) {
        const chip = label(Format.countdownFromEpoch(win.resetAt, nowMs), 'ai-usage-chip');
        countdowns.push([chip, win.resetAt]);
        head.add_child(chip);
    }

    const color = win.color || accent;
    if (win.showMeter !== false) {
        const pct = Number(win.pct) || 0;
        head.add_child(label(`${Math.round(pct)}%`, 'ai-usage-quota-pct', {
            style: `color: ${pctColor(pct) ?? color};`,
        }));
        row.add_child(new SegmentMeter(pct, color));
        if (win.detail)
            row.add_child(paragraph(win.detail, 'ai-usage-quota-detail'));
    } else {
        // Without a meter `detail` is the value itself; `note` is its aside.
        if (win.detail)
            head.add_child(label(win.detail, 'ai-usage-quota-value', {style: `color: ${color};`}));
        if (win.note)
            row.add_child(paragraph(win.note, 'ai-usage-quota-detail'));
    }
    return row;
}

// Service-status chip for details.status; null when there is nothing to show.
export function statusChip(status, tooltips) {
    const indicator = status?.indicator || '';
    const url = status?.url || '';
    if (!indicator && !url)
        return null;

    const linkOnly = indicator === '';
    const text = linkOnly ? _('Status ↗')
        : indicator === 'critical' ? _('Major Outage')
            : indicator === 'major' ? _('Partial Outage')
                : indicator === 'minor' ? _('Minor Issues')
                    : _('Operational');
    const chip = new St.Button({
        style_class: `ai-usage-status ai-usage-status-${linkOnly ? 'link' : indicator}`,
        can_focus: true,
        reactive: url !== '',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const box = hbox('ai-usage-status-box');
    if (!linkOnly)
        box.add_child(new St.Widget({style_class: 'ai-usage-status-dot', y_align: Clutter.ActorAlign.CENTER}));
    box.add_child(label(text, 'ai-usage-status-label'));
    chip.set_child(box);

    const lines = [`${_('Status')} · ${status.description || _('Unknown')}`];
    for (const c of status.components || [])
        lines.push(`  · ${c}`);
    for (const i of status.incidents || [])
        lines.push(`  · ${i}`);
    if (status.latestUpdate)
        lines.push(status.latestUpdate);
    chip.accessible_name = lines.join('\n');
    tooltips.attach(chip, lines.join('\n'));
    if (url)
        chip.connect('clicked', () => openUri(url));
    return chip;
}

// One floating label shared by every hover target of a popup or button.
// St has no tooltips of its own; this sits in uiGroup above open menus.
export class Tooltips {
    constructor() {
        this._label = new St.Label({style_class: 'ai-usage-tooltip', visible: false});
        this._label.clutter_text.line_wrap = true;
        Main.uiGroup.add_child(this._label);
        this._owner = null;
    }

    // `text` may be a function, read when the pointer enters.
    attach(actor, text) {
        actor.track_hover = true;
        actor.reactive = true;
        actor.connect('notify::hover', () => {
            if (actor.hover)
                this.show(actor, typeof text === 'function' ? text() : text);
            else
                this.hide(actor);
        });
        actor.connect('destroy', () => this.hide(actor));
    }

    // Below `actor`, or at a given stage point when `at` is passed.
    show(actor, text, at = null) {
        if (!this._label || !text) {
            this.hide(actor);
            return;
        }
        this._owner = actor;
        this._label.text = text;
        Main.uiGroup.set_child_above_sibling(this._label, null);
        const [, natW] = this._label.get_preferred_width(-1);
        const [, natH] = this._label.get_preferred_height(natW);
        let x, y;
        if (at) {
            [x, y] = at;
            x -= natW / 2;
            y -= natH + 8;
        } else {
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            x = ax + aw / 2 - natW / 2;
            y = ay + ah + 6;
        }
        const monitor = Main.layoutManager.findMonitorForActor(actor);
        if (monitor) {
            x = Math.max(monitor.x + 4, Math.min(x, monitor.x + monitor.width - natW - 4));
            y = Math.max(monitor.y + 4, Math.min(y, monitor.y + monitor.height - natH - 4));
        }
        this._label.set_position(Math.round(x), Math.round(y));
        this._label.show();
    }

    hide(actor = null) {
        if (!this._label || (actor && actor !== this._owner))
            return;
        this._owner = null;
        this._label.hide();
    }

    destroy() {
        this._label?.destroy();
        this._label = null;
    }
}
