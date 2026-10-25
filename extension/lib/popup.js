import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as FeatureTabs from '../shared/FeatureTabs.js';
import * as Format from '../shared/Format.js';
import {enabledFeatureTabs, enabledProviders} from './providers.js';
import {pickActiveTab, popupTabs, windowForGranularity} from './format.js';
import {UsageChart} from './chart.js';
import {Tooltips, hbox, label, paragraph, quotaRow, spacer, statusChip, vbox} from './widgets.js';

const TICK_SECONDS = 30;

function timeOfDay(epochSeconds) {
    return GLib.DateTime.new_from_unix_local(epochSeconds).format('%H:%M');
}

// Popup body: header, tab bar, provider detail, error banner and the view of
// the active tab. Everything is rebuilt from the controller state on change;
// only the countdown chips are ticked in place.
export class Popup {
    constructor(extension, controller, icons, menu) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._controller = controller;
        this._icons = icons;
        this._menu = menu;
        this._tooltips = new Tooltips();
        this._countdowns = [];
        this._tickId = 0;
        this.activeId = this._settings.get_string('last-tab');

        this.actor = vbox('ai-usage-popup');
        this._buildHeader();
        this._tabs = hbox('ai-usage-tabs');
        this._detail = label('', 'ai-usage-detail');
        this._error = paragraph('', 'ai-usage-error');
        this._body = vbox('ai-usage-body');
        this._scroll = new St.ScrollView({
            style_class: 'ai-usage-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._body,
        });
        this._footer = label('', 'ai-usage-footer');
        this._chart = new UsageChart(id => this._selectChartWindow(id));
        for (const a of [this._tabs, this._detail, this._error, this._scroll, this._footer])
            this.actor.add_child(a);

        this._controller.connectObject(
            'changed', () => this._onData(),
            'history-changed', () => this._menu.isOpen && this._render(),
            'loading-changed', () => this._syncLoading(),
            this.actor);
        this._settings.connectObject(
            'changed::show-overview', () => this._onData(),
            'changed::show-spend', () => this._onData(),
            this.actor);
        this._menu.connectObject('open-state-changed', (_m, open) => this._onOpenChanged(open), this.actor);
        this.actor.connect('destroy', () => this._onDestroy());

        this._onData();
        this._syncLoading();
    }

    _buildHeader() {
        const header = hbox('ai-usage-header');
        this._headerIcon = new St.Icon({style_class: 'ai-usage-header-icon', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._headerIcon);
        const titles = vbox('ai-usage-titles', {y_align: Clutter.ActorAlign.CENTER});
        this._title = label('', 'ai-usage-title');
        this._subtitle = label('', 'ai-usage-subtitle');
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        header.add_child(titles);
        header.add_child(spacer());
        this._statusSlot = hbox('', {y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._statusSlot);

        this._refreshIcon = new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'});
        this._refreshIcon.set_pivot_point(0.5, 0.5);
        const refresh = new St.Button({
            style_class: 'ai-usage-icon-button',
            child: this._refreshIcon,
            can_focus: true,
            accessible_name: _('Refresh'),
        });
        refresh.connect('clicked', () => this._controller.refresh());
        this._tooltips.attach(refresh, _('Refresh'));
        header.add_child(refresh);

        const prefs = new St.Button({
            style_class: 'ai-usage-icon-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', style_class: 'popup-menu-icon'}),
            can_focus: true,
            accessible_name: _('Settings'),
        });
        prefs.connect('clicked', () => {
            this._menu.close();
            this._extension.openPreferences();
        });
        this._tooltips.attach(prefs, _('Settings'));
        header.add_child(prefs);
        this.actor.add_child(header);
    }

    get _tabList() {
        return popupTabs(enabledFeatureTabs(this._settings), this._controller.providers);
    }

    _onData() {
        const tabs = this._tabList;
        const next = pickActiveTab(this.activeId, this._settings.get_string('last-tab'),
            this._controller.active, tabs);
        if (next !== this.activeId)
            this._setActive(next, false);
        if (this._menu.isOpen)
            this._render();
    }

    _setActive(id, remember) {
        this.activeId = id;
        if (remember && id && this._settings.get_string('last-tab') !== id)
            this._settings.set_string('last-tab', id);
    }

    selectTab(id) {
        this._setActive(id, true);
        this._render();
    }

    _onOpenChanged(open) {
        if (open) {
            this._render();
            this._controller.refreshIfOld();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            this._stopTick();
            this._tooltips.hide();
        }
    }

    _stopTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    _tick() {
        const now = Date.now();
        for (const [chip, resetAt] of this._countdowns)
            chip.text = Format.countdownFromEpoch(resetAt, now);
    }

    _syncLoading() {
        const icon = this._refreshIcon;
        if (this._controller.loading) {
            icon.ease({
                rotation_angle_z: 360,
                duration: 1000,
                mode: Clutter.AnimationMode.LINEAR,
                repeatCount: -1,
            });
        } else {
            icon.remove_all_transitions();
            icon.rotation_angle_z = 0;
        }
    }

    _activeProvider() {
        return this._controller.providerById(this.activeId);
    }

    accentFor(id) {
        return FeatureTabs.accent(id) || this._controller.providerById(id)?.accent || '#7dd3fc';
    }

    _render() {
        const tabs = this._tabList;
        const provider = this._activeProvider();
        const feature = tabs.find(t => t.id === this.activeId)?.feature ?? false;

        this._renderHeader(provider, feature);
        this._renderTabs(tabs);

        const detail = provider ? provider.summary?.detail || '' : '';
        const updated = this._controller.updatedAt ? _('updated %s').format(timeOfDay(this._controller.updatedAt)) : '';
        const parts = feature ? [] : [detail, updated, provider?.stale ? _('stale') : ''].filter(s => s);
        this._detail.text = parts.join(' · ');
        this._detail.visible = parts.length > 0;

        this._error.text = provider?.error || '';
        this._error.visible = !feature && !!provider?.error;

        this._footer.text = this._controller.errorText;
        this._footer.visible = this._controller.errorText !== '';

        this._countdowns = [];
        if (this._chart.get_parent())
            this._chart.get_parent().remove_child(this._chart);
        this._body.destroy_all_children();
        this._body.add_child(this._buildView(provider, feature));
    }

    _renderHeader(provider, feature) {
        if (feature) {
            this._title.text = FeatureTabs.label(this.activeId, _);
            this._subtitle.text = this._featureSubtitle();
        } else {
            this._title.text = _('%s Usage').format(provider?.label ?? 'AI');
            this._subtitle.text = '';
        }
        this._subtitle.visible = this._subtitle.text !== '';
        this._headerIcon.gicon = (!feature && this._icons.logo(provider)) || this._icons.app;

        this._statusSlot.destroy_all_children();
        const chip = !feature && provider ? statusChip(provider.details?.status, this._tooltips) : null;
        if (chip)
            this._statusSlot.add_child(chip);
    }

    _featureSubtitle() {
        return '';
    }

    _renderTabs(tabs) {
        this._tabs.destroy_all_children();
        this._tabs.visible = tabs.length > 1;
        for (const tab of tabs) {
            const active = tab.id === this.activeId;
            const button = new St.Button({
                style_class: `ai-usage-tab${active ? ' active' : ''}`,
                can_focus: true,
                x_expand: true,
                style: active ? `border-color: ${this.accentFor(tab.id)};` : '',
            });
            const box = hbox('ai-usage-tab-box', {x_align: Clutter.ActorAlign.CENTER});
            const logo = tab.provider ? this._icons.logo(tab.provider) : null;
            if (logo)
                box.add_child(new St.Icon({gicon: logo, style_class: 'ai-usage-tab-icon', y_align: Clutter.ActorAlign.CENTER}));
            else if (tab.provider)
                box.add_child(new St.Widget({style_class: 'ai-usage-dot', style: `background-color: ${tab.provider.accent};`, y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(label(tab.feature ? FeatureTabs.label(tab.id, _) : tab.provider.label || tab.id, 'ai-usage-tab-label'));
            button.set_child(box);
            button.connect('clicked', () => this.selectTab(tab.id));
            this._tabs.add_child(button);
        }
    }

    _buildView(provider, feature) {
        if (feature)
            return vbox();
        if (!provider)
            return this._emptyView();
        return this._usageView(provider);
    }

    _emptyView() {
        const text = enabledProviders(this._settings).length === 0
            ? _('Enable a provider in Settings to see it here.')
            : this._controller.loading ? _('Loading…') : _('No data yet.');
        return paragraph(text, 'ai-usage-empty');
    }

    _usageView(provider) {
        const box = vbox('ai-usage-view');
        const rows = vbox('ai-usage-quota-rows');
        const now = Date.now();
        const accent = this.accentFor(provider.id);
        for (const win of provider.quotaWindows || [])
            rows.add_child(quotaRow(win, accent, this._countdowns, now));
        if ((provider.quotaWindows || []).length === 0)
            rows.add_child(paragraph(provider.error ? '' : _('No quota windows reported.'), 'ai-usage-empty'));
        box.add_child(rows);

        if (this._syncChart(provider))
            box.add_child(this._chart);
        return box;
    }

    // The chart is kept across renders (it holds the paging and hover state)
    // and just re-parented into each new usage view.
    _syncChart(provider = this._activeProvider()) {
        if (!provider)
            return false;
        const windows = provider.chartWindows || [];
        const chartable = (provider.error || '') === '' && provider.ok !== false &&
            provider.summary?.hasChart !== false && windows.length > 0;
        const win = windowForGranularity(windows, this._settings.get_string('chart-granularity'));
        const shown = chartable && this._chart.update({
            history: this._controller.usageHistory,
            windows,
            windowId: win?.id ?? '',
            accent: this.accentFor(provider.id),
            currency: provider.details?.currency || '',
        });
        this._chart.visible = shown;
        return shown;
    }

    _selectChartWindow(id) {
        const win = (this._activeProvider()?.chartWindows || []).find(w => w.id === id);
        if (win?.granularity)
            this._settings.set_string('chart-granularity', win.granularity);
        this._syncChart();
    }

    _onDestroy() {
        this._stopTick();
        this._chart.destroy();
        this._tooltips.destroy();
        this._tooltips = null;
        this._settings = null;
    }
}
