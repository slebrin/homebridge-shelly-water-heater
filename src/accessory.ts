import type { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { HeaterController } from './controller';
import { errorMessage } from './client';
import type { Mode, Settings } from './config';

const INPUTS = [
  { mode: 'auto', identifier: 2 },
  { mode: 'force', identifier: 3 },
] as const;

export class HeaterAccessory {
  readonly controller: HeaterController;
  readonly television: Service;

  constructor(
    readonly accessory: PlatformAccessory,
    private readonly settings: Settings,
    private readonly api: API,
    private readonly log: Logging,
  ) {
    const { Service: S, Characteristic: C } = api.hap;
    this.controller = new HeaterController(settings, log);
    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Shelly / Homebridge')
      .setCharacteristic(C.Model, 'Water heater Enum interface')
      .setCharacteristic(C.SerialNumber, `${settings.host}-enum-${settings.enumId}`);

    this.television = accessory.addService(S.Television, settings.name, 'mode');
    this.television.setPrimaryService();
    this.television
      .setCharacteristic(C.ConfiguredName, settings.name)
      .setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    this.television.getCharacteristic(C.Active)
      .onGet(() => this.requireState().mode === 'arret' ? C.Active.INACTIVE : C.Active.ACTIVE)
      .onSet(async value => {
        if (value !== C.Active.ACTIVE && value !== C.Active.INACTIVE) {
          throw new api.hap.HapStatusError(api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        const state = this.requireState();
        const target = value === C.Active.ACTIVE ? 'auto' : 'arret';
        if ((target === 'auto' && state.mode !== 'arret') || state.mode === target) {
          return;
        }
        await this.setModeFromHomeKit(target);
      });
    this.television.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.identifier(this.requireState().mode))
      .onSet(async value => {
        const mode = this.mode(value);
        if (!mode) {
          log.warn(`Identifiant de mode HomeKit invalide : ${String(value)}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        await this.setModeFromHomeKit(mode);
      });
    this.television.getCharacteristic(C.RemoteKey).onSet(() => {
      log.warn('Commande telecommande TV non prise en charge.');
      throw new api.hap.HapStatusError(api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    });
    this.television.getCharacteristic(C.ConfiguredName).onSet(value => {
      log.warn(`Renommage TV dans Maison (${String(value)}); config name reappliquee au redemarrage.`);
    });

    INPUTS.forEach(({ mode, identifier }) => {
      const input = accessory.addService(S.InputSource, settings.states[mode], `input-${mode}`);
      input
        .setCharacteristic(C.Identifier, identifier)
        .setCharacteristic(C.ConfiguredName, settings.states[mode])
        .setCharacteristic(C.InputSourceType, C.InputSourceType.OTHER)
        .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
      input.getCharacteristic(C.ConfiguredName).onSet(value => {
        log.info(`Nom de source Maison : ${String(value)} (config reappliquee au redemarrage).`);
      });
      input.getCharacteristic(C.TargetVisibilityState)
        .onGet(() => C.TargetVisibilityState.SHOWN)
        .onSet(value => {
          input.updateCharacteristic(C.CurrentVisibilityState, value);
        });
      this.television.addLinkedService(input);
    });

    this.controller.on('state', () => this.publish());
    this.controller.on('unavailable', () => this.publish());
    this.publish();
  }

  private requireState() {
    if (!this.controller.available || !this.controller.snapshot) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.controller.snapshot;
  }

  private identifier(mode: Mode): number {
    return mode === 'force' ? 3 : 2;
  }

  private mode(value: CharacteristicValue): Mode | undefined {
    return value === 2 ? 'auto' : value === 3 ? 'force' : undefined;
  }

  private async setModeFromHomeKit(mode: Mode): Promise<void> {
    try {
      await this.controller.setMode(mode);
    } catch (error) {
      this.log.warn(`Commande HomeKit refusee : ${errorMessage(error)}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      // HAP caches the requested value after onSet; restore the confirmed Shelly state.
      setImmediate(() => this.publish());
    }
  }

  publish(): void {
    const { Characteristic: C, HAPStatus, HapStatusError } = this.api.hap;
    const state = this.controller.snapshot;
    if (!this.controller.available || !state) {
      const error = new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      this.television.getCharacteristic(C.Active).updateValue(error);
      this.television.getCharacteristic(C.ActiveIdentifier).updateValue(error);
      return;
    }
    this.television.updateCharacteristic(
      C.Active,
      state.mode === 'arret' ? C.Active.INACTIVE : C.Active.ACTIVE,
    );
    this.television.updateCharacteristic(C.ActiveIdentifier, this.identifier(state.mode));
  }
}

export class HeatingIndicatorAccessory {
  readonly indicator: Service;

  constructor(
    readonly accessory: PlatformAccessory,
    private readonly controller: HeaterController,
    settings: Settings,
    private readonly api: API,
    log: Logging,
  ) {
    const { Service: S, Characteristic: C } = api.hap;
    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Shelly / Homebridge')
      .setCharacteristic(C.Model, 'Water heater heating indicator')
      .setCharacteristic(C.SerialNumber, `${settings.host}-switch-${settings.switchId}`);

    this.indicator = accessory.getService(S.Switch)
      ?? accessory.addService(S.Switch, `${settings.name} - En chauffe`, 'heating');
    this.indicator.setPrimaryService();
    this.indicator.getCharacteristic(C.On)
      .setProps({ perms: [C.Perms.PAIRED_READ, C.Perms.PAIRED_WRITE, C.Perms.NOTIFY] })
      .onGet(() => this.requireState())
      .onSet(() => {
        // Apple Home needs write permission to show a room tile; every write is still rejected.
        log.warn('Indicateur de chauffe en lecture seule; commande refusee.');
        throw new api.hap.HapStatusError(api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      });
    controller.on('state', () => this.publish());
    controller.on('unavailable', () => this.publish());
    this.publish();
  }

  private requireState(): boolean {
    if (!this.controller.available || !this.controller.snapshot) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.controller.snapshot.heating;
  }

  publish(): void {
    const { Characteristic: C, HAPStatus, HapStatusError } = this.api.hap;
    if (!this.controller.available || !this.controller.snapshot) {
      this.indicator.getCharacteristic(C.On)
        .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      return;
    }
    this.indicator.updateCharacteristic(C.On, this.controller.snapshot.heating);
  }
}
