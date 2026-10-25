import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Controller} from './lib/controller.js';
import {Icons} from './lib/icons.js';
import {Indicator} from './lib/indicator.js';

export default class AiUsageExtension extends Extension {
    enable() {
        this._controller = new Controller(this);
        this._indicator = new Indicator(this, this._controller, new Icons(this.path));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._controller.start();
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._controller.destroy();
        this._controller = null;
    }
}
