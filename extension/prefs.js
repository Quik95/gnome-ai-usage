import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROVIDERS} from './lib/providers.js';

// Keeps `id`'s membership in the string-list `key` in sync with a boolean
// widget property, both ways.
function bindMembership(settings, key, id, widget, property) {
    const sync = () => {
        const member = settings.get_strv(key).includes(id);
        if (widget[property] !== member)
            widget[property] = member;
    };
    sync();
    const handler = settings.connect(`changed::${key}`, sync);
    widget.connect(`notify::${property}`, () => {
        const list = settings.get_strv(key).filter(v => v !== id);
        if (widget[property])
            list.push(id);
        // Canonical order keeps the stored value stable however it was toggled.
        const order = PROVIDERS.map(p => p.id);
        list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (list.join() !== settings.get_strv(key).join())
            settings.set_strv(key, list);
    });
    widget.connect('destroy', () => settings.disconnect(handler));
}

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const providers = new Adw.PreferencesGroup({
            title: _('Providers'),
            description: _('Enabled providers are fetched on every poll and get a popup tab.'),
        });
        page.add(providers);
        for (const p of PROVIDERS) {
            const row = new Adw.ExpanderRow({title: p.label, show_enable_switch: true, expanded: true});
            bindMembership(settings, 'enabled-providers', p.id, row, 'enable-expansion');
            const pin = new Adw.SwitchRow({title: _('Show in the top bar')});
            bindMembership(settings, 'panel-providers', p.id, pin, 'active');
            row.add_row(pin);
            providers.add(row);
        }

        const views = new Adw.PreferencesGroup({title: _('Popup')});
        page.add(views);
        for (const [key, title, subtitle] of [
            ['show-overview', _('Overview tab'), _('Every provider with its headline and windows')],
            ['show-spend', _('Spend tab'), _('Provider costs and local session spend')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', 0);
            views.add(row);
        }

        const refresh = new Adw.PreferencesGroup({title: _('Refresh')});
        page.add(refresh);
        const interval = new Adw.SpinRow({
            title: _('Poll interval'),
            subtitle: _('Seconds between two backend fetches'),
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        settings.bind('poll-interval', interval, 'value', 0);
        refresh.add(interval);
    }
}
