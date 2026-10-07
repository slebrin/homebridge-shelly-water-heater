import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HeaterAccessory, HeatingIndicatorAccessory } from './accessory';
import { errorMessage } from './client';
import { parseSettings, PLATFORM_NAME, PLUGIN_NAME, type Settings } from './config';

class ShellyWaterHeaterPlatform {
  private readonly settings: Settings;
  private heater?: HeaterAccessory;
  private cachedIndicator?: PlatformAccessory;
  private indicator?: HeatingIndicatorAccessory;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    try {
      this.settings = parseSettings(config);
    } catch (error) {
      log.error(`Configuration invalide : ${errorMessage(error)}`);
      throw error;
    }
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.heater?.controller.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (accessory.UUID === this.indicatorUuid()) {
      this.cachedIndicator = accessory;
      return;
    }
    this.log.warn(`Accessoire en cache inconnu retire : ${accessory.displayName}`);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  private launch(): void {
    const uuid = this.api.hap.uuid.generate(
      `${PLUGIN_NAME}:${this.settings.host.toLowerCase()}:enum:${this.settings.enumId}`,
    );
    const televisionAccessory = new this.api.platformAccessory(
      this.settings.name, uuid, this.api.hap.Categories.TELEVISION,
    );
    this.heater = new HeaterAccessory(televisionAccessory, this.settings, this.api, this.log);
    this.api.publishExternalAccessories(PLUGIN_NAME, [televisionAccessory]);
    this.log.info('Accessoire externe publie : ajoutez-le separement dans Maison avec le code Homebridge.');

    let indicatorAccessory = this.cachedIndicator;
    if (!indicatorAccessory) {
      indicatorAccessory = new this.api.platformAccessory(
        `${this.settings.name} - En chauffe`,
        this.indicatorUuid(),
        this.api.hap.Categories.SWITCH,
      );
      indicatorAccessory.context.kind = 'heating-indicator';
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [indicatorAccessory]);
    } else {
      indicatorAccessory.updateDisplayName(`${this.settings.name} - En chauffe`);
    }
    this.indicator = new HeatingIndicatorAccessory(
      indicatorAccessory, this.heater.controller, this.settings, this.api, this.log,
    );
    this.log.info('Indicateur de chauffe publie comme accessoire separe du pont Homebridge.');
    this.heater.controller.start();
  }

  private indicatorUuid(): string {
    return this.api.hap.uuid.generate(
      `${PLUGIN_NAME}:${this.settings.host.toLowerCase()}:switch:${this.settings.switchId}:heating`,
    );
  }
}

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ShellyWaterHeaterPlatform);
};
