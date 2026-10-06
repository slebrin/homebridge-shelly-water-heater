import type { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { HeaterController } from './controller';
import { errorMessage } from './client';
import { MODES, type Mode, type Settings } from './config';

export class HeaterAccessory {
  readonly controller: HeaterController;
  readonly television: Service;
  readonly indicator: Service;

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

    // TV power is not relay power. Keep the mode selector available in every mode.
    this.television.getCharacteristic(C.Active)
      .onGet(() => { this.requireState(); return C.Active.ACTIVE; })
      .onSet(value => {
        if (value !== C.Active.ACTIVE) {
          log.warn('Le bouton alimentation TV ne commande pas le chauffe-eau; utilisez les modes.');
          throw new api.hap.HapStatusError(api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
        }
        this.requireState();
      });
    this.television.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.identifier(this.requireState().mode))
      .onSet(async value => {
        const mode = this.mode(value);
        if (!mode) {
          log.warn(`Identifiant de mode HomeKit invalide : ${String(value)}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        try {
          await this.controller.setMode(mode);
        } catch (error) {
          log.warn(`Commande HomeKit refusee : ${errorMessage(error)}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
          // HAP caches the requested value after onSet; restore the confirmed Shelly state.
          setImmediate(() => this.publish());
        }
      });
    this.television.getCharacteristic(C.RemoteKey).onSet(() => {
      log.warn('Commande telecommande TV non prise en charge.');
      throw new api.hap.HapStatusError(api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
    });
    this.television.getCharacteristic(C.ConfiguredName).onSet(value => {
      log.warn(`Renommage TV dans Maison (${String(value)}); config name reappliquee au redemarrage.`);
    });

    MODES.forEach((mode, index) => {
      const input = accessory.addService(S.InputSource, settings.states[mode], `input-${mode}`);
      input
        .setCharacteristic(C.Identifier, index + 1)
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

    this.indicator = accessory.addService(S.Switch, `${settings.name} - En chauffe`, 'heating');
    this.indicator.getCharacteristic(C.On)
      .setProps({ perms: [C.Perms.PAIRED_READ, C.Perms.NOTIFY] })
      .onGet(() => this.requireState().heating)
      .onSet(() => {
        // Defence in depth for local callers; HAP rejects network writes before this handler.
        log.warn('Indicateur de chauffe en lecture seule; commande refusee.');
        throw new api.hap.HapStatusError(api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
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
    return MODES.indexOf(mode) + 1;
  }

  private mode(value: CharacteristicValue): Mode | undefined {
    return typeof value === 'number' && Number.isInteger(value) ? MODES[value - 1] : undefined;
  }

  publish(): void {
    const { Characteristic: C, HAPStatus, HapStatusError } = this.api.hap;
    const state = this.controller.snapshot;
    if (!this.controller.available || !state) {
      const error = new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      this.television.getCharacteristic(C.Active).updateValue(error);
      this.television.getCharacteristic(C.ActiveIdentifier).updateValue(error);
      this.indicator.getCharacteristic(C.On).updateValue(error);
      return;
    }
    this.television.updateCharacteristic(C.Active, C.Active.ACTIVE);
    this.television.updateCharacteristic(C.ActiveIdentifier, this.identifier(state.mode));
    this.indicator.updateCharacteristic(C.On, state.heating);
  }
}
