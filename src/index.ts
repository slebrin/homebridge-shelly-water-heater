import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HeaterAccessory } from './accessory';
import { errorMessage } from './client';
import { parseSettings, PLATFORM_NAME, PLUGIN_NAME, type Settings } from './config';

class ShellyWaterHeaterPlatform {
  private readonly settings: Settings;
  private heater?: HeaterAccessory;

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
    // Only external accessories are used; remove a cached bridged accessory if present.
    this.log.warn(`Ancien accessoire bridge retire : ${accessory.displayName}`);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  private launch(): void {
    const uuid = this.api.hap.uuid.generate(
      `${PLUGIN_NAME}:${this.settings.host.toLowerCase()}:enum:${this.settings.enumId}`,
    );
    const accessory = new this.api.platformAccessory(
      this.settings.name, uuid, this.api.hap.Categories.TELEVISION,
    );
    this.heater = new HeaterAccessory(accessory, this.settings, this.api, this.log);
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.log.info('Accessoire externe publie : ajoutez-le separement dans Maison avec le code Homebridge.');
    this.heater.controller.start();
  }
}

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ShellyWaterHeaterPlatform);
};
