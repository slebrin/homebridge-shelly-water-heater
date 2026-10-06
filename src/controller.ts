import { EventEmitter } from 'node:events';
import type { Logging } from 'homebridge';
import { ShellyClient, errorMessage } from './client';
import { isMode, isObject, type Mode, type Settings } from './config';

export interface Snapshot {
  mode: Mode;
  heating: boolean;
}

export class HeaterController extends EventEmitter {
  snapshot?: Snapshot;
  available = false;
  private stopped = true;
  private poll?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private refreshPending?: Promise<void>;
  private dirty = false;
  private lastError?: string;
  private websocketFailed = false;
  private epoch = 0;
  readonly client: ShellyClient;

  constructor(private readonly settings: Settings, private readonly log: Logging) {
    super();
    this.client = new ShellyClient(settings);
    this.client.on('connected', () => {
      this.websocketFailed = false;
      this.log.debug('WebSocket connecte; resynchronisation.');
      void this.refresh();
    });
    this.client.on('disconnected', (error: Error) => {
      this.epoch++;
      this.unavailable(error);
      if (!this.websocketFailed) {
        this.log.warn('WebSocket indisponible; secours RPC HTTP et reconnexion automatique.');
        this.websocketFailed = true;
      }
      void this.refresh();
    });
    this.client.on('transportWarning', (error: Error) => this.log.debug(error.message));
    this.client.on('notification', (params: Record<string, unknown>) => {
      const keys = [`enum:${settings.enumId}`, `switch:${settings.switchId}`];
      const relevantEvent = Array.isArray(params.events) && params.events.some(
        event => isObject(event) && keys.includes(String(event.component)),
      );
      if (keys.some(key => key in params) || relevantEvent) {
        // Re-read both values rather than trusting partial or out-of-order notifications.
        void this.refresh();
      }
    });
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.log.info(`Connexion au Shelly ${this.settings.host}`);
    this.client.start();
    void this.refresh();
    this.poll = setInterval(() => { void this.refresh(); }, this.settings.pollInterval * 1000);
  }

  stop(): void {
    this.stopped = true;
    this.epoch++;
    clearInterval(this.poll);
    this.client.stop();
    this.available = false;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  refresh(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.dirty = true;
    if (this.refreshPending) {
      return this.refreshPending;
    }
    this.refreshPending = this.enqueue(async () => {
      // Bound each batch so frequent status notifications cannot starve queued commands.
      for (let pass = 0; pass < 2 && this.dirty && !this.stopped; pass++) {
        this.dirty = false;
        const epoch = this.epoch;
        try {
          const snapshot = await this.read();
          if (!this.stopped && epoch === this.epoch) {
            this.apply(snapshot);
          } else if (!this.stopped) {
            this.dirty = true;
          }
        } catch (error) {
          if (!this.stopped) {
            this.unavailable(error);
          }
        }
      }
    }).finally(() => {
      this.refreshPending = undefined;
      if (this.dirty && !this.stopped) {
        void this.refresh();
      }
    });
    return this.refreshPending;
  }

  async setMode(mode: Mode): Promise<void> {
    if (!isMode(mode)) {
      throw new Error(`Mode inconnu : ${String(mode)}`);
    }
    if (!this.available || this.stopped) {
      throw new Error('Shelly non synchronise; commande refusee.');
    }
    return this.enqueue(async () => {
      if (!this.available || this.stopped) {
        throw new Error('Shelly non synchronise; commande refusee.');
      }
      try {
        this.log.info(`HomeKit -> ${this.settings.states[mode]}`);
        await this.client.rpc('Enum.Set', { id: this.settings.enumId, value: mode });
        this.log.info(`Shelly enum:${this.settings.enumId} = ${mode}`);
        const snapshot = await this.read();
        if (!this.stopped) {
          this.apply(snapshot, true);
        }
      } catch (error) {
        if (!this.stopped) {
          this.unavailable(error);
          // A failed write is not retried; only its actual resulting state is read.
          void this.refresh();
        }
        throw error;
      }
    });
  }

  private async read(): Promise<Snapshot> {
    const [mode, relay] = await Promise.all([
      this.client.rpc('Enum.GetStatus', { id: this.settings.enumId }),
      this.client.rpc('Switch.GetStatus', { id: this.settings.switchId }),
    ]);
    if (!isObject(mode) || !isMode(mode.value)) {
      throw new Error(`Valeur enum:${this.settings.enumId} inconnue ou invalide.`);
    }
    if (!isObject(relay) || typeof relay.output !== 'boolean') {
      throw new Error(`Etat switch:${this.settings.switchId} invalide.`);
    }
    return { mode: mode.value, heating: relay.output };
  }

  private apply(snapshot: Snapshot, command = false): void {
    const previous = this.snapshot;
    if (!this.available) {
      this.log.info('Shelly synchronise.');
    }
    this.available = true;
    this.lastError = undefined;
    this.snapshot = snapshot;
    if (!previous || previous.mode !== snapshot.mode) {
      if (previous && !command) {
        this.log.info(`Changement externe : ${previous.mode} -> ${snapshot.mode}`);
      }
      this.log.info(`Mode : ${this.settings.states[snapshot.mode]}`);
    }
    if (!previous || previous.heating !== snapshot.heating) {
      this.log.info(`Chauffe-eau : ${snapshot.heating ? 'ON' : 'OFF'}`);
    }
    this.emit('state', snapshot);
  }

  private unavailable(error: unknown): void {
    this.available = false;
    const message = errorMessage(error);
    if (message !== this.lastError) {
      this.log.warn(`Shelly indisponible : ${message}`);
      this.lastError = message;
    }
    this.emit('unavailable');
  }
}
