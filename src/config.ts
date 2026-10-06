export const PLUGIN_NAME = 'homebridge-shelly-water-heater';
export const PLATFORM_NAME = 'ShellyWaterHeater';
export const MODES = ['arret', 'auto', 'force'] as const;
export type Mode = typeof MODES[number];

export interface Settings {
  name: string;
  host: string;
  enumId: number;
  switchId: number;
  pollInterval: number;
  rpcTimeout: number;
  states: Record<Mode, string>;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMode(value: unknown): value is Mode {
  return value === 'arret' || value === 'auto' || value === 'force';
}

function integer(value: unknown, fallback: number, name: string, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${name} doit etre un entier entre ${min} et ${max}.`);
  }
  return result;
}

function label(value: unknown, fallback: string, name: string): string {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || result.trim().length === 0 || Buffer.byteLength(result.trim()) > 64) {
    throw new Error(`${name} doit etre un texte non vide (64 octets maximum).`);
  }
  return result.trim();
}

export function parseSettings(config: unknown): Settings {
  if (!isObject(config)) {
    throw new Error('Configuration ShellyWaterHeater absente.');
  }
  if (typeof config.host !== 'string' || !config.host.trim()) {
    throw new Error('host est obligatoire (IP ou nom local du Shelly).');
  }
  const host = config.host.trim();
  const url = new URL(`http://${host}`);
  if (url.host !== host.toLowerCase() || url.username || url.password || /[/?#\s]/.test(host)) {
    throw new Error('host doit contenir uniquement une IP ou un nom local, avec port facultatif.');
  }
  if (config.states !== undefined && !isObject(config.states)) {
    throw new Error('states doit etre un objet.');
  }
  const states = isObject(config.states) ? config.states : {};
  return {
    name: label(config.name, 'Chauffe-eau', 'name'),
    host,
    enumId: integer(config.enumId, 200, 'enumId', 200, 299),
    switchId: integer(config.switchId, 0, 'switchId', 0, 255),
    pollInterval: integer(config.pollInterval, 10, 'pollInterval', 1, 3600),
    rpcTimeout: integer(config.rpcTimeout, 5, 'rpcTimeout', 1, 60),
    states: {
      arret: label(states.arret, 'Arrêt', 'states.arret'),
      auto: label(states.auto, 'Auto', 'states.auto'),
      force: label(states.force, 'Marche forcée', 'states.force'),
    },
  };
}
