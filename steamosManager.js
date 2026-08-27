/* steamosManager.js
 *
 * Thin client for the steamos-manager session-bus service.
 *
 *  - PerformanceProfile1 is only exported on hardware that has a platform
 *    profile configured
 *
 *  - TdpLimit1 is added to and removed from the object at runtime, depending
 *    on whether the active performance profile permits manual TDP control
 *
 *  - GpuPerformanceLevel1 is exported once at startup
 *
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const BUS_NAME = 'com.steampowered.SteamOSManager1';
export const OBJECT_PATH = '/com/steampowered/SteamOSManager1';
export const PROFILE_IFACE = 'com.steampowered.SteamOSManager1.PerformanceProfile1';
export const TDP_IFACE = 'com.steampowered.SteamOSManager1.TdpLimit1';
export const GPU_IFACE = 'com.steampowered.SteamOSManager1.GpuPerformanceLevel1';

export const GPU_LEVEL_MANUAL = 'manual';
export const GPU_LEVEL_AUTO = 'auto';

const ROOT_PATH = '/';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';

export const SteamOSManagerClient = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class SteamOSManagerClient extends GObject.Object {
    _init() {
        super._init();

        this._connection = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._signalIds = [];

        this._clearState();

        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onNameAppeared(),
            () => this._onNameVanished());
    }

    _clearState() {
        this.available = false;
        this.hasProfiles = false;
        this.hasTdp = false;
        this.hasGpu = false;
        this.profiles = [];
        this.profile = null;
        this.suggestedProfile = null;
        this.tdp = 0;
        this.tdpMin = 0;
        this.tdpMax = 0;
        this.gpuLevels = [];
        this.gpuLevel = null;
        this.gpuClock = 0;
        this.gpuClockMin = 0;
        this.gpuClockMax = 0;
    }

    get canSetGpuClock() {
        return this.hasGpu &&
            this.gpuLevels.includes(GPU_LEVEL_MANUAL) &&
            this.gpuClockMax > this.gpuClockMin;
    }

    get gpuManual() {
        return this.gpuLevel === GPU_LEVEL_MANUAL;
    }

    _onNameAppeared() {
        this._subscribe();

        this._connection.call(
            BUS_NAME, ROOT_PATH, OM_IFACE, 'GetManagedObjects',
            null, new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, res) => {
                let managed;
                try {
                    managed = connection.call_finish(res).recursiveUnpack()[0];
                } catch (e) {
                    this._logError('GetManagedObjects failed', e);
                    return;
                }

                this.available = true;
                this._applyInterfaces(managed[OBJECT_PATH] ?? {});
                this.emit('changed');
            });
    }

    _onNameVanished() {
        this._unsubscribe();
        this._clearState();
        this.emit('changed');
    }

    _subscribe() {
        if (this._signalIds.length > 0)
            return;

        const connection = this._connection;

        this._signalIds.push(connection.signal_subscribe(
            BUS_NAME, PROPS_IFACE, 'PropertiesChanged', OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (conn_, sender_, path_, iface_, signal_, params) => {
                const [iface, changed] = params.recursiveUnpack();
                this._applyProperties(iface, changed);

                if (iface === GPU_IFACE && 'GpuPerformanceLevel' in changed)
                    this._refreshGpuClock();

                this.emit('changed');
            }));

        this._signalIds.push(connection.signal_subscribe(
            BUS_NAME, OM_IFACE, 'InterfacesAdded', ROOT_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (conn_, sender_, path_, iface_, signal_, params) => {
                const [objectPath, interfaces] = params.recursiveUnpack();
                if (objectPath !== OBJECT_PATH)
                    return;
                this._applyInterfaces(interfaces);
                this.emit('changed');
            }));

        this._signalIds.push(connection.signal_subscribe(
            BUS_NAME, OM_IFACE, 'InterfacesRemoved', ROOT_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (conn_, sender_, path_, iface_, signal_, params) => {
                const [objectPath, interfaces] = params.recursiveUnpack();
                if (objectPath !== OBJECT_PATH)
                    return;
                if (interfaces.includes(TDP_IFACE))
                    this.hasTdp = false;
                if (interfaces.includes(PROFILE_IFACE))
                    this.hasProfiles = false;
                if (interfaces.includes(GPU_IFACE))
                    this.hasGpu = false;
                this.emit('changed');
            }));
    }

    _unsubscribe() {
        for (const id of this._signalIds)
            this._connection.signal_unsubscribe(id);
        this._signalIds = [];
    }

    _applyInterfaces(interfaces) {
        if (PROFILE_IFACE in interfaces) {
            this.hasProfiles = true;
            this._applyProperties(PROFILE_IFACE, interfaces[PROFILE_IFACE]);
        }
        if (TDP_IFACE in interfaces) {
            this.hasTdp = true;
            this._applyProperties(TDP_IFACE, interfaces[TDP_IFACE]);
        }
        if (GPU_IFACE in interfaces) {
            this.hasGpu = true;
            this._applyProperties(GPU_IFACE, interfaces[GPU_IFACE]);
        }
    }

    _applyProperties(iface, props) {
        if (iface === PROFILE_IFACE) {
            if ('AvailablePerformanceProfiles' in props)
                this.profiles = props.AvailablePerformanceProfiles;
            if ('PerformanceProfile' in props)
                this.profile = props.PerformanceProfile;
            if ('SuggestedDefaultPerformanceProfile' in props)
                this.suggestedProfile = props.SuggestedDefaultPerformanceProfile;
        } else if (iface === TDP_IFACE) {
            if ('TdpLimit' in props)
                this.tdp = props.TdpLimit;
            if ('TdpLimitMin' in props)
                this.tdpMin = props.TdpLimitMin;
            if ('TdpLimitMax' in props)
                this.tdpMax = props.TdpLimitMax;
        } else if (iface === GPU_IFACE) {
            if ('AvailableGpuPerformanceLevels' in props)
                this.gpuLevels = props.AvailableGpuPerformanceLevels;
            if ('GpuPerformanceLevel' in props)
                this.gpuLevel = props.GpuPerformanceLevel;
            if ('ManualGpuClock' in props)
                this.gpuClock = props.ManualGpuClock;
            if ('ManualGpuClockMin' in props)
                this.gpuClockMin = props.ManualGpuClockMin;
            if ('ManualGpuClockMax' in props)
                this.gpuClockMax = props.ManualGpuClockMax;
        }
    }

    _refreshGpuClock() {
        this._connection.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [GPU_IFACE, 'ManualGpuClock']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, res) => {
                let clock;
                try {
                    clock = connection.call_finish(res).recursiveUnpack()[0];
                } catch (e) {
                    this._logError('Reading ManualGpuClock failed', e);
                    return;
                }

                if (clock === this.gpuClock)
                    return;

                this.gpuClock = clock;
                this.emit('changed');
            });
    }

    setProfile(profile) {
        this._setProperty(PROFILE_IFACE, 'PerformanceProfile',
            new GLib.Variant('s', profile));
    }

    setTdp(watts) {
        this._setProperty(TDP_IFACE, 'TdpLimit',
            new GLib.Variant('u', watts));
    }

    setGpuLevel(level) {
        this._setProperty(GPU_IFACE, 'GpuPerformanceLevel',
            new GLib.Variant('s', level));
    }

    setGpuClock(megahertz) {
        this._setProperty(GPU_IFACE, 'ManualGpuClock',
            new GLib.Variant('u', megahertz));
    }

    _setProperty(iface, name, value) {
        this._connection.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [iface, name, value]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    this._logError(`Setting ${iface}.${name} failed`, e);
                }
            });
    }

    _logError(message, error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        console.error(`TDP Control: ${message}: ${error.message}`);
    }

    destroy() {
        this._cancellable.cancel();
        this._unsubscribe();

        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
    }
});
