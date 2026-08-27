/*
 * A quick settings entry for steamos-manager's performance profile, TDP limit
 * and manual GPU clock, mirroring how Steam presents them:
 */

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SteamOSManagerClient, GPU_LEVEL_MANUAL, GPU_LEVEL_AUTO} from './steamosManager.js';

// How long to poll slider movement before pushing a new value.
const APPLY_INTERVAL_MS = 150;

// Slider steps
const TDP_STEP_W = 1;
const GPU_STEP_MHZ = 50;

// Borrow the GNOME power profile title since it's already translated
function shellProfileName(context, msgid) {
    return GLib.dpgettext2('gnome-shell', context, msgid);
}

const PROFILE_PARAMS = {
    'performance': {
        name: () => shellProfileName('Power profile', 'Performance'),
        iconName: 'power-profile-performance-symbolic',
    },
    'balanced': {
        name: () => shellProfileName('Power profile', 'Balanced'),
        iconName: 'power-profile-balanced-symbolic',
    },
    'low-power': {
        name: () => shellProfileName('Power profile', 'Power Saver'),
        iconName: 'power-profile-power-saver-symbolic',
    },
    'power-saver': {
        name: () => shellProfileName('Power profile', 'Power Saver'),
        iconName: 'power-profile-power-saver-symbolic',
    },
    'quiet': {
        name: () => _('Quiet'),
        iconName: 'power-profile-power-saver-symbolic',
    },
    'custom': {
        name: () => shellProfileName('Power profile', 'Custom'),
        iconName: 'gnome-power-manager-symbolic',
    },
};

const FALLBACK_ICON = 'power-profile-performance-symbolic';

function profileParams(profile) {
    if (!profile)
        return {name: _('Unknown'), iconName: FALLBACK_ICON};

    const params = PROFILE_PARAMS[profile];
    if (params)
        return {name: params.name(), iconName: params.iconName};

    const name = profile
        .split(/[-_]/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    return {name, iconName: FALLBACK_ICON};
}

const ProfileSubMenuItem = GObject.registerClass(
class ProfileSubMenuItem extends PopupMenu.PopupSubMenuMenuItem {
    _subMenuOpenStateChanged(menu, open) {
        if (open) {
            this.add_style_pseudo_class('open');
            this.add_style_pseudo_class('checked');
            this.add_accessible_state(Atk.StateType.EXPANDED);
        } else {
            this.remove_style_pseudo_class('open');
            this.remove_style_pseudo_class('checked');
            this.remove_accessible_state(Atk.StateType.EXPANDED);
        }
    }
});

const ValueSliderItem = GObject.registerClass({
    Signals: {
        'value-set': {param_types: [GObject.TYPE_INT]},
    },
}, class ValueSliderItem extends PopupMenu.PopupBaseMenuItem {
    _init(label, step, formatValue) {
        super._init({
            activate: false,
            style_class: 'tdp-control-slider-item',
        });

        this._step = step;
        this._formatValue = formatValue;
        this._min = 0;
        this._max = 0;
        this._value = 0;
        this._syncing = false;
        this._dragging = false;
        this._applyId = 0;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(box);

        const labelBox = new St.BoxLayout({x_expand: true});
        this._label = new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._valueLabel = new St.Label({
            style_class: 'tdp-control-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelBox.add_child(this._label);
        labelBox.add_child(this._valueLabel);
        box.add_child(labelBox);

        this._slider = new Slider(0);
        this._slider.accessible_name = label;
        box.add_child(this._slider);

        this._slider.connect('drag-begin', () => (this._dragging = true));
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._apply();
        });
        this._slider.connect('notify::value', () => this._onSliderChanged());
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right)
            return this._slider.vfunc_key_press_event(event);
        return super.vfunc_key_press_event(event);
    }

    reparentAccessible(menu) {
        const accessible = this._slider.get_accessible();
        accessible.set_parent(menu.box.get_accessible());
        this.set_accessible(accessible);
    }

    get value() {
        return this._value;
    }

    sync(value, min, max) {
        this._min = min;
        this._max = max;

        if (this._dragging || this._applyId !== 0)
            return;

        this._value = value;
        this._syncing = true;
        this._slider.value = this._toSliderValue(value);
        this._syncing = false;
        this._updateValueLabel();
    }

    _onSliderChanged() {
        if (this._syncing)
            return;

        const value = this._fromSliderValue(this._slider.value);
        if (value === this._value)
            return;

        this._value = value;
        this._updateValueLabel();
        this._queueApply();
    }

    _queueApply() {
        if (this._applyId !== 0)
            return;

        this._applyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            APPLY_INTERVAL_MS, () => {
                this._applyId = 0;
                this.emit('value-set', this._value);
                return GLib.SOURCE_REMOVE;
            });
    }

    _apply() {
        if (this._applyId !== 0) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
        }
        this.emit('value-set', this._value);
    }

    _updateValueLabel() {
        this._valueLabel.text = this._formatValue(this._value);
    }

    _fromSliderValue(sliderValue) {
        if (this._max <= this._min)
            return this._min;
        const raw = this._min + sliderValue * (this._max - this._min);
        const stepped = this._min + Math.round((raw - this._min) / this._step) * this._step;
        return Math.clamp(stepped, this._min, this._max);
    }

    _toSliderValue(value) {
        if (this._max <= this._min)
            return 0;
        return Math.clamp((value - this._min) / (this._max - this._min), 0, 1);
    }

    vfunc_unmap() {
        /* Closing the menu mid-drag should still commit the value. */
        if (this._applyId !== 0)
            this._apply();
        super.vfunc_unmap();
    }

    destroy() {
        if (this._applyId !== 0) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
        }
        super.destroy();
    }
});

const TdpToggle = GObject.registerClass(
class TdpToggle extends QuickMenuToggle {
    _init(client) {
        super._init({
            title: _('TDP'),
            iconName: FALLBACK_ICON,
            menuButtonAccessibleName: _('Open TDP and performance profile menu'),
        });

        this._client = client;
        this._profileItems = new Map();
        this._lastProfile = null;
        this._syncingGpuSwitch = false;

        this.menu.setHeader(FALLBACK_ICON, _('Power'));

        this._profileItem = new ProfileSubMenuItem('', true);
        this.menu.addMenuItem(this._profileItem);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                this._collapseProfiles();
        });

        this._tdpSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._tdpSeparator);

        this._tdpItem = new ValueSliderItem(_('TDP Limit'), TDP_STEP_W,
            // Translators: %d is a wattage, IE "15 W"
            watts => _('%d W').format(watts));
        this.menu.addMenuItem(this._tdpItem);
        this._tdpItem.connect('value-set',
            (item, watts) => this._client.setTdp(watts));

        this._gpuSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._gpuSeparator);

        this._gpuSwitch = new PopupMenu.PopupSwitchMenuItem(
            _('Manual GPU Clock'), false);
        this.menu.addMenuItem(this._gpuSwitch);
        this._gpuSwitch.connect('toggled', (item, state) => {
            if (this._syncingGpuSwitch)
                return;
            this._client.setGpuLevel(state ? GPU_LEVEL_MANUAL : GPU_LEVEL_AUTO);
        });

        this._gpuItem = new ValueSliderItem(_('GPU Frequency'), GPU_STEP_MHZ,
            // Translators: %d is a GPU clock frequency, IE "1600 MHz"
            mhz => _('%d MHz').format(mhz));
        this.menu.addMenuItem(this._gpuItem);
        this._gpuItem.connect('value-set',
            (item, mhz) => this._client.setGpuClock(mhz));

        this._tdpItem.reparentAccessible(this.menu);
        this._gpuItem.reparentAccessible(this.menu);

        this.connect('clicked', () => this._onClicked());

        this._changedId = this._client.connect('changed', () => this._sync());
        this._sync();
    }

    _onClicked() {
        if (!this._client.hasProfiles) {
            this.menu.open();
            return;
        }

        const fallback = this._client.suggestedProfile;
        if (this.checked) {
            this._client.setProfile(fallback);
        } else {
            const target = this._lastProfile ?? this._alternateProfile(fallback);
            if (target)
                this._client.setProfile(target);
            else
                this.menu.open();
        }
    }

    _collapseProfiles() {
        this._profileItem.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    _alternateProfile(exclude) {
        const {profiles} = this._client;
        if (profiles.includes('performance') && exclude !== 'performance')
            return 'performance';
        return profiles.find(p => p !== exclude) ?? null;
    }

    _syncProfileItems() {
        this._profileItem.menu.removeAll();
        this._profileItems.clear();

        if (!this._client.hasProfiles)
            return;

        for (const profile of [...this._client.profiles].reverse()) {
            const {name, iconName} = profileParams(profile);
            const item = new PopupMenu.PopupImageMenuItem(name, iconName);
            item.connect('activate', () => this._client.setProfile(profile));
            this._profileItems.set(profile, item);
            this._profileItem.menu.addMenuItem(item);
        }
    }

    _sync() {
        const client = this._client;
        const showGpu = client.canSetGpuClock;

        this.visible = client.available &&
            (client.hasProfiles || client.hasTdp || showGpu);
        if (!this.visible)
            return;

        const profilesChanged =
            this._profileItems.size !== (client.hasProfiles ? client.profiles.length : 0) ||
            [...this._profileItems.keys()].some(p => !client.profiles.includes(p));
        if (profilesChanged)
            this._syncProfileItems();

        for (const [profile, item] of this._profileItems) {
            item.setOrnament(profile === client.profile
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }

        this._profileItem.visible = client.hasProfiles;
        if (client.hasProfiles) {
            const {name, iconName} = profileParams(client.profile);
            this._profileItem.label.text = name;
            this._profileItem.icon.icon_name = iconName;
        } else {
            this._collapseProfiles();
        }

        this._tdpItem.visible = client.hasTdp;
        this._tdpSeparator.visible = client.hasProfiles && client.hasTdp;

        if (client.hasTdp)
            this._tdpItem.sync(client.tdp, client.tdpMin, client.tdpMax);

        this._gpuSwitch.visible = showGpu;
        this._gpuItem.visible = showGpu && client.gpuManual;
        this._gpuSeparator.visible = showGpu &&
            (client.hasProfiles || client.hasTdp);

        if (showGpu) {
            this._syncingGpuSwitch = true;
            this._gpuSwitch.setToggleState(client.gpuManual);
            this._syncingGpuSwitch = false;

            if (client.gpuManual) {
                this._gpuItem.sync(client.gpuClock,
                    client.gpuClockMin, client.gpuClockMax);
            }
        }

        const watts = _('%d W').format(client.hasTdp ? this._tdpItem.value : 0);
        const megahertz = _('%d MHz').format(showGpu ? this._gpuItem.value : 0);

        if (client.hasProfiles) {
            const {name, iconName} = profileParams(client.profile);
            this.set({
                title: _('Power Profile'),
                subtitle: client.hasTdp ? `${name} · ${watts}` : name,
                iconName,
            });
            this.menu.setHeader(iconName, _('Power Profile'));

            this.checked = client.profile !== client.suggestedProfile;
            if (this.checked)
                this._lastProfile = client.profile;
        } else if (client.hasTdp) {
            this.set({
                title: _('TDP'),
                subtitle: watts,
                iconName: FALLBACK_ICON,
            });
            this.menu.setHeader(FALLBACK_ICON, _('TDP'));
            this.checked = false;
        } else {
            this.set({
                title: _('GPU Clock'),
                subtitle: client.gpuManual ? megahertz : _('Automatic'),
                iconName: FALLBACK_ICON,
            });
            this.menu.setHeader(FALLBACK_ICON, _('GPU Clock'));
            this.checked = client.gpuManual;
        }

        this.menuEnabled = true;
    }

    destroy() {
        if (this._changedId) {
            this._client.disconnect(this._changedId);
            this._changedId = 0;
        }
        super.destroy();
    }
});

const TdpIndicator = GObject.registerClass(
class TdpIndicator extends SystemIndicator {
    _init(client) {
        super._init();

        this._indicator = this._addIndicator();

        this._toggle = new TdpToggle(client);
        this._toggle.bind_property('icon-name',
            this._indicator, 'icon-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this.quickSettingsItems.push(this._toggle);
    }
});

export default class TdpControlExtension extends Extension {
    enable() {
        this._client = new SteamOSManagerClient();
        this._indicator = new TdpIndicator(this._client);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;

        this._client.destroy();
        this._client = null;
    }
}
