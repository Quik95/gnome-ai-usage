import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Controller} from './lib/controller.js';

export default class AiUsageExtension extends Extension {
    enable() {
        this._controller = new Controller(this);
        this._controller.start();
    }

    disable() {
        this._controller.destroy();
        this._controller = null;
    }
}
