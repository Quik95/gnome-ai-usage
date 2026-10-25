import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {panelProviders} from './providers.js';
import {slotText, slotTextColor, slotTooltip, DANGER} from './format.js';

// Top-bar button: one tinted logo + readout per slot of every pinned provider,
// as the backend's `slots` describe them.
export const Indicator = GObject.registerClass(
class AiUsageIndicator extends PanelMenu.Button {
    _init(extension, controller, icons) {
        super._init(0.5, 'AI Usage', false);
        this._settings = extension.getSettings();
        this._controller = controller;
        this._icons = icons;

        this._box = new St.BoxLayout({style_class: 'ai-usage-panel', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);

        this._tooltip = new St.Label({style_class: 'ai-usage-tooltip', visible: false});
        Main.uiGroup.add_child(this._tooltip);
        this.connect('notify::hover', () => this._syncTooltip());
        this.menu.connect('open-state-changed', () => this._syncTooltip());

        this._controller.connectObject('changed', () => this._sync(), this);
        this._settings.connectObject('changed::panel-providers', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this._box.destroy_all_children();
        const pinned = panelProviders(this._settings)
            .map(id => this._controller.providerById(id))
            .filter(p => p);

        const shown = pinned.filter(p => (p.slots || []).length > 0 || p.error);
        if (shown.length === 0) {
            this._box.add_child(new St.Icon({gicon: this._icons.app, style_class: 'system-status-icon'}));
        }
        for (const provider of shown)
            this._box.add_child(this._providerGroup(provider));

        this._tooltipText = slotTooltip(pinned) || 'AI Usage';
        this.accessible_name = this._tooltipText.replaceAll('\n', ', ');
        this._tooltip.text = this._tooltipText;
    }

    _providerGroup(provider) {
        const group = new St.BoxLayout({
            style_class: 'ai-usage-panel-provider',
            opacity: provider.stale ? 140 : 255,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const slots = provider.slots || [];
        if (slots.length === 0) {
            // A provider that failed and has nothing to show: its logo and a red dot.
            group.add_child(this._logo(provider, DANGER));
            group.add_child(new St.Label({
                text: '●',
                style_class: 'ai-usage-panel-error',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            return group;
        }
        slots.forEach((slot, i) => {
            if (i > 0)
                group.add_child(new St.Widget({style_class: 'ai-usage-panel-divider', y_align: Clutter.ActorAlign.CENTER}));
            const box = new St.BoxLayout({style_class: 'ai-usage-panel-slot', y_align: Clutter.ActorAlign.CENTER});
            box.add_child(this._logo(provider, slot.color || provider.accent));
            const color = slotTextColor(slot);
            box.add_child(new St.Label({
                text: slotText(slot),
                style_class: 'ai-usage-panel-label',
                style: color ? `color: ${color};` : '',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            group.add_child(box);
        });
        return group;
    }

    _logo(provider, color) {
        const gicon = this._icons.tinted(provider);
        if (!gicon) {
            return new St.Widget({
                style_class: 'ai-usage-dot',
                style: `background-color: ${provider.accent || '#888'};`,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return new St.Icon({
            gicon,
            style_class: 'ai-usage-panel-icon',
            style: color ? `color: ${color};` : '',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _syncTooltip() {
        const show = this.hover && !this.menu.isOpen;
        if (!show) {
            this._tooltip.hide();
            return;
        }
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        const [, natW] = this._tooltip.get_preferred_width(-1);
        const monitor = Main.layoutManager.findMonitorForActor(this);
        let tx = Math.round(x + w / 2 - natW / 2);
        if (monitor)
            tx = Math.max(monitor.x, Math.min(tx, monitor.x + monitor.width - natW));
        this._tooltip.set_position(tx, Math.round(y + h + 6));
        this._tooltip.show();
    }

    destroy() {
        this._tooltip.destroy();
        this._tooltip = null;
        this._settings = null;
        super.destroy();
    }
});
