// Providers this frontend offers. Everything else about a provider (label,
// accent, icon, windows, series) comes from the backend envelope, so adding
// one is an entry here, not a new code path. Labels are only used before the
// first envelope arrives (prefs, empty tabs).
export const PROVIDERS = [
    {id: 'claude', label: 'Claude'},
    {id: 'openai', label: 'OpenAI'},
];

export const PROVIDER_IDS = PROVIDERS.map(p => p.id);

// Feature tabs that sit ahead of the provider tabs, with their settings key.
export const FEATURE_TABS = [
    {id: 'overview', key: 'show-overview'},
    {id: 'spend', key: 'show-spend'},
];

// The enabled providers in canonical order, restricted to the known ones.
export function enabledProviders(settings) {
    const enabled = settings.get_strv('enabled-providers');
    return PROVIDER_IDS.filter(id => enabled.includes(id));
}

// Pinned providers that are also enabled, in canonical order.
export function panelProviders(settings) {
    const pinned = settings.get_strv('panel-providers');
    return enabledProviders(settings).filter(id => pinned.includes(id));
}

export function enabledFeatureTabs(settings) {
    return FEATURE_TABS.filter(t => settings.get_boolean(t.key)).map(t => t.id);
}
