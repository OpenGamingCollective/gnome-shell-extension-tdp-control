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

// How long to keep showing a value we asked for before believing the daemon.
const CONFIRM_TIMEOUT_MS = 2000;

const ROOT_PATH = '/';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';

export const SteamOSManagerClient = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class SteamOSManagerClient extends GObject.Object {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._connection = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._signalIds = [];
        this._pending = {};

        this._clearState();

        this._nameWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onNameAppeared(),
            () => this._onNameVanished());
    }

    _clearState() {
        this._clearPending();

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
        this.tdpEnabled = this._settings.get_boolean('tdp-enabled');
        this._rememberedTdp = this._settings.get_uint('tdp-limit');
        this._tdpRestored = false;
        this.gpuLevels = [];
        this.gpuLevel = null;
        this.gpuClock = 0;
        this.gpuClockMin = 0;
        this.gpuClockMax = 0;
        this._gpuClockKnown = false;
        this.gpuManualWanted = this._settings.get_boolean('gpu-manual');
        this._rememberedGpuClock = this._settings.get_uint('gpu-clock');
        this._gpuRestored = false;
        this._gpuClockToProgram = 0;
    }

    get canSetTdp() {
        return this.hasTdp && this.tdpMax > this.tdpMin;
    }

    // The limit to restore when TDP control is switched back on
    get tdpTarget() {
        if (this._rememberedTdp > 0)
            return Math.clamp(this._rememberedTdp, this.tdpMin, this.tdpMax);
        return this.tdpMax;
    }

    get canSetGpuClock() {
        return this.hasGpu &&
            this.gpuLevels.includes(GPU_LEVEL_MANUAL) &&
            this.gpuClockMax > this.gpuClockMin;
    }

    get gpuManual() {
        return this.gpuLevel === GPU_LEVEL_MANUAL;
    }

    // The clock to restore when manual GPU control is switched back on
    get storedGpuClock() {
        if (this._rememberedGpuClock > 0) {
            return Math.clamp(this._rememberedGpuClock,
                this.gpuClockMin, this.gpuClockMax);
        }
        return this.gpuClockMax;
    }

    get gpuClockTarget() {
        if (this._gpuClockKnown)
            return this.gpuClock;
        return this.storedGpuClock;
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
                if (interfaces.includes(TDP_IFACE)) {
                    this.hasTdp = false;
                    this._tdpRestored = false;
                }
                if (interfaces.includes(PROFILE_IFACE))
                    this.hasProfiles = false;
                if (interfaces.includes(GPU_IFACE)) {
                    this.hasGpu = false;
                    this._gpuRestored = false;
                }
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
            this._restoreTdp();
        }
        if (GPU_IFACE in interfaces) {
            this.hasGpu = true;
            this._applyProperties(GPU_IFACE, interfaces[GPU_IFACE]);
            this._restoreGpu();
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
            // The bounds have to land before the limit is judged against them
            if ('TdpLimitMin' in props)
                this.tdpMin = props.TdpLimitMin;
            if ('TdpLimitMax' in props)
                this.tdpMax = props.TdpLimitMax;
            if ('TdpLimit' in props) {
                const ours = !!this._pending['tdp'];
                this._observeTdp(this._settle('tdp', props.TdpLimit), !ours);
            }
        } else if (iface === GPU_IFACE) {
            if ('AvailableGpuPerformanceLevels' in props)
                this.gpuLevels = props.AvailableGpuPerformanceLevels;
            if ('GpuPerformanceLevel' in props) {
                const previous = this.gpuLevel;
                this.gpuLevel = this._settle('gpuLevel',
                    props.GpuPerformanceLevel);
                this._updateGpuClockKnown(previous);
                this._observeGpuLevel();
                this._programGpuClock();
            }
            if ('ManualGpuClock' in props) {
                this.gpuClock = this._settle('gpuClock', props.ManualGpuClock);
                this._observeGpuClock();
            }
            if ('ManualGpuClockMin' in props)
                this.gpuClockMin = props.ManualGpuClockMin;
            if ('ManualGpuClockMax' in props)
                this.gpuClockMax = props.ManualGpuClockMax;
        }
    }

    // The reported clock only means anything while the level is manual
    _updateGpuClockKnown(previousLevel) {
        if (this.gpuLevel !== GPU_LEVEL_MANUAL)
            this._gpuClockKnown = false;
        else if (previousLevel === null)
            this._gpuClockKnown = true;
        else if (previousLevel !== GPU_LEVEL_MANUAL)
            this._gpuClockKnown = false;
    }

    // Switching levels swaps in a different clock, so ask for the new one
    _refreshGpuClock() {
        this._readProperty(GPU_IFACE, 'ManualGpuClock', clock => {
            const settled = this._settle('gpuClock', clock);
            if (settled === this.gpuClock)
                return;

            this.gpuClock = settled;
            this._observeGpuClock();
            this.emit('changed');
        });
    }

    _readProperty(iface, name, onValue) {
        this._connection.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [iface, name]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, res) => {
                let value;
                try {
                    value = connection.call_finish(res).recursiveUnpack()[0];
                } catch (e) {
                    this._logError(`Reading ${iface}.${name} failed`, e);
                    return;
                }

                onValue(value);
            });
    }

    setProfile(profile, onDone) {
        this._setProperty(PROFILE_IFACE, 'PerformanceProfile',
            new GLib.Variant('s', profile), undefined, onDone);
    }

    // A limit that lands from elsewhere still says the user wants one
    _observeTdp(watts, external = false) {
        this.tdp = watts;

        if (!this.tdpEnabled) {
            if (external && watts < this.tdpMax)
                this._storeTdpEnabled(true);
            else
                return;
        }

        if (watts > 0 && watts < this.tdpMax)
            this._rememberTdp(watts);
    }

    // The daemon comes up at its own limit, so put ours back once it's ready
    _restoreTdp() {
        if (this._tdpRestored || !this.canSetTdp)
            return;

        this._tdpRestored = true;
        if (!this.tdpEnabled)
            return;

        const watts = this.tdpTarget;
        if (watts !== this.tdp)
            this.setTdp(watts);
    }

    _storeTdpEnabled(enabled) {
        this.tdpEnabled = enabled;
        this._settings.set_boolean('tdp-enabled', enabled);
    }

    _rememberTdp(watts) {
        if (watts === this._rememberedTdp)
            return;

        this._rememberedTdp = watts;
        this._settings.set_uint('tdp-limit', watts);
    }

    setTdpEnabled(enabled) {
        if (enabled === this.tdpEnabled)
            return;

        if (enabled) {
            const target = this.tdpTarget;
            this._storeTdpEnabled(true);
            this.setTdp(target);
        } else {
            if (this.tdp > 0)
                this._rememberTdp(this.tdp);
            this._storeTdpEnabled(false);
            this.setTdp(this.tdpMax);
        }
    }

    setTdp(watts) {
        this._writeTdp(watts, true);
    }

    _writeTdp(watts, mayRetry) {
        this.tdp = watts;
        if (this.tdpEnabled)
            this._rememberTdp(watts);
        this._expect('tdp', TDP_IFACE, 'TdpLimit', watts, (value, refused) => {
            if (refused && mayRetry && this.hasProfiles && this.profile) {
                this.setProfile(this.profile,
                    () => this._writeTdp(watts, false));
                return;
            }
            this._observeTdp(value);
        });
        this._setProperty(TDP_IFACE, 'TdpLimit',
            new GLib.Variant('u', watts), 'tdp');
        this.emit('changed');
    }

    _observeGpuLevel() {
        if (this._gpuRestored)
            this._storeGpuManual(this.gpuManual);
    }

    _observeGpuClock() {
        if (this._gpuRestored && this.gpuManual && this.gpuClock > 0)
            this._rememberGpuClock(this.gpuClock);
    }

    // The daemon comes up at its own limit, so put ours back once it's ready
    _restoreGpu() {
        if (this._gpuRestored || !this.canSetGpuClock)
            return;

        this._gpuRestored = true;
        if (!this.gpuManualWanted) {
            this._observeGpuLevel();
            this._observeGpuClock();
            return;
        }

        if (!this.gpuManual) {
            this.setGpuLevel(GPU_LEVEL_MANUAL);
            return;
        }

        const megahertz = this.storedGpuClock;
        if (megahertz !== this.gpuClock)
            this.setGpuClock(megahertz);
    }

    _storeGpuManual(manual) {
        if (manual === this.gpuManualWanted)
            return;

        this.gpuManualWanted = manual;
        this._settings.set_boolean('gpu-manual', manual);
    }

    _rememberGpuClock(megahertz) {
        if (megahertz === this._rememberedGpuClock)
            return;

        this._rememberedGpuClock = megahertz;
        this._settings.set_uint('gpu-clock', megahertz);
    }

    setGpuLevel(level) {
        const previous = this.gpuLevel;

        this._storeGpuManual(level === GPU_LEVEL_MANUAL);

        this._gpuClockToProgram = level === GPU_LEVEL_MANUAL &&
            previous !== GPU_LEVEL_MANUAL ? this.gpuClockTarget : 0;

        this.gpuLevel = level;
        this._expect('gpuLevel', GPU_IFACE, 'GpuPerformanceLevel', level, value => {
            const stale = this.gpuLevel;
            this.gpuLevel = value;
            this._updateGpuClockKnown(stale);
            this._observeGpuLevel();
            this._programGpuClock();
        });
        this._updateGpuClockKnown(previous);
        this._setProperty(GPU_IFACE, 'GpuPerformanceLevel',
            new GLib.Variant('s', level), 'gpuLevel');
        this.emit('changed');
    }

    // A clock only sticks once the level has actually turned manual
    _programGpuClock() {
        const clock = this._gpuClockToProgram;
        if (clock === 0)
            return;

        this._gpuClockToProgram = 0;
        if (this.gpuLevel === GPU_LEVEL_MANUAL)
            this.setGpuClock(clock);
    }

    setGpuClock(megahertz) {
        this.gpuClock = megahertz;
        this._rememberGpuClock(megahertz);
        this._gpuClockKnown = true;
        this._expect('gpuClock', GPU_IFACE, 'ManualGpuClock', megahertz, value => {
            this.gpuClock = value;
            this._observeGpuClock();
        });
        this._setProperty(GPU_IFACE, 'ManualGpuClock',
            new GLib.Variant('u', megahertz), 'gpuClock');
        this.emit('changed');
    }

    _expect(key, iface, name, value, apply) {
        this._cancelPending(key);
        this._pending[key] = {
            iface,
            name,
            value,
            apply,
            reported: undefined,
            id: GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_TIMEOUT_MS,
                () => this._onPendingTimeout(key)),
        };
    }

    // Keep showing the value we asked for until the daemon reports it back
    _settle(key, reported) {
        const pending = this._pending[key];
        if (!pending)
            return reported;

        if (reported !== pending.value) {
            pending.reported = reported;
            return pending.value;
        }

        this._cancelPending(key);
        return reported;
    }

    // Out of patience: believe whatever the daemon says the value is
    _onPendingTimeout(key) {
        const pending = this._pending[key];
        this._pending[key] = null;

        if (pending?.reported !== undefined) {
            this._readProperty(pending.iface, pending.name, value => {
                if (value === pending.value)
                    return;
                pending.apply(value, true);
                this.emit('changed');
            });
        }

        this.emit('changed');
        return GLib.SOURCE_REMOVE;
    }

    _cancelPending(key) {
        const pending = this._pending[key];
        if (!pending)
            return;

        GLib.source_remove(pending.id);
        this._pending[key] = null;
    }

    _clearPending() {
        for (const key of Object.keys(this._pending))
            this._cancelPending(key);
        this._pending = {};
    }

    _setProperty(iface, name, value, key, onDone) {
        this._connection.call(
            BUS_NAME, OBJECT_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [iface, name, value]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, res) => {
                try {
                    connection.call_finish(res);
                } catch (e) {
                    this._logError(`Setting ${iface}.${name} failed`, e);
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._revertPending(key, iface, name);
                    return;
                }

                onDone?.();
            });
    }

    // A write that never landed shouldn't keep the value it asked for on screen
    _revertPending(key, iface, name) {
        const pending = key !== undefined ? this._pending[key] : null;
        if (!pending)
            return;

        this._cancelPending(key);
        this._readProperty(iface, name, value => {
            pending.apply(value, false);
            this.emit('changed');
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
        this._clearPending();

        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
    }
});
