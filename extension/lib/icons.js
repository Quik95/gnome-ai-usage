import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Provider logos ship under icons/ by their envelope filename; the package
// adds a `-symbolic` twin of each so St recolors it with CSS `color`.
export class Icons {
    constructor(extensionPath) {
        this._dir = GLib.build_filenamev([extensionPath, 'icons']);
        this._cache = new Map();
    }

    _file(name) {
        let icon = this._cache.get(name);
        if (!icon) {
            icon = new Gio.FileIcon({file: Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]))});
            this._cache.set(name, icon);
        }
        return icon;
    }

    // The brand logo in its own colours, or null when the provider has none.
    logo(provider) {
        return provider?.icon ? this._file(provider.icon) : null;
    }

    // The logo as a symbolic icon, tinted by the widget's CSS `color`.
    tinted(provider) {
        return provider?.icon ? this._file(provider.icon.replace(/\.svg$/, '-symbolic.svg')) : null;
    }

    get app() {
        return this._file('org.muddyblack.aiUsageWidget.svg');
    }
}
