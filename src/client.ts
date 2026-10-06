import { EventEmitter } from 'node:events';
import { isObject, type Settings } from './config';

type Method = 'Enum.GetStatus' | 'Enum.Set' | 'Switch.GetStatus';
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShellyClient extends EventEmitter {
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private connectTimeout?: NodeJS.Timeout;
  private stopped = true;
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly aborters = new Set<AbortController>();
  private readonly source = `homebridge-water-heater-${process.pid}`;
  private retryMs = 1000;

  constructor(private readonly settings: Settings) {
    super();
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearTimeout(this.connectTimeout);
    this.rejectPending(new Error('Plugin arrete.'));
    for (const aborter of this.aborters) {
      aborter.abort();
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const socket = new WebSocket(`ws://${this.settings.host}/rpc`);
    this.socket = socket;
    this.connectTimeout = setTimeout(() => {
      this.disconnect(socket, new Error('Timeout de connexion WebSocket.'));
    }, this.settings.rpcTimeout * 1000);
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      clearTimeout(this.connectTimeout);
      this.retryMs = 1000;
      // A request with src registers the connection for Shelly notifications.
      this.emit('connected');
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      try {
        if (typeof event.data !== 'string') {
          throw new Error('Trame RPC WebSocket non textuelle.');
        }
        const frame: unknown = JSON.parse(event.data);
        if (!isObject(frame)) {
          throw new Error('Trame RPC invalide.');
        }
        if (typeof frame.id === 'number' && this.pending.has(frame.id)) {
          const pending = this.pending.get(frame.id)!;
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if ('error' in frame) {
            pending.reject(this.rpcError(frame.error));
          } else if ('result' in frame) {
            pending.resolve(frame.result);
          } else {
            pending.reject(new Error('Reponse RPC sans result.'));
          }
        } else if (frame.method === 'NotifyStatus' || frame.method === 'NotifyFullStatus' ||
                   frame.method === 'NotifyEvent') {
          if (!isObject(frame.params)) {
            throw new Error('Notification RPC invalide.');
          }
          this.emit('notification', frame.params);
        }
      } catch (error) {
        this.disconnect(socket, new Error(`WebSocket : ${errorMessage(error)}`));
      }
    });
    socket.addEventListener('error', () => this.disconnect(socket, new Error('Erreur WebSocket.')));
    socket.addEventListener('close', () => this.disconnect(socket, new Error('WebSocket deconnecte.')));
  }

  private rpcError(value: unknown): Error {
    if (isObject(value)) {
      const auth = value.code === 401 ? ' (authentification Shelly non prise en charge)' : '';
      return new Error(`RPC ${String(value.code)} : ${String(value.message)}${auth}`);
    }
    return new Error('Erreur RPC invalide.');
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private disconnect(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    clearTimeout(this.connectTimeout);
    this.rejectPending(error);
    socket.close();
    if (!this.stopped) {
      this.emit('disconnected', error);
      this.reconnect = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    }
  }

  async rpc(method: Method, params: Record<string, unknown>): Promise<unknown> {
    // Runtime allowlist also protects against accidental direct relay commands.
    if (!['Enum.GetStatus', 'Enum.Set', 'Switch.GetStatus'].includes(method)) {
      throw new Error(`Methode interdite : ${method}`);
    }
    if (this.stopped) {
      throw new Error('Client Shelly arrete.');
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        return await this.websocketRpc(method, params);
      } catch (error) {
        // Never replay a write: its result may have been lost after application.
        if (method === 'Enum.Set') {
          throw error;
        }
        this.emit('transportWarning', error);
      }
    }
    return this.httpRpc(method, params);
  }

  private websocketRpc(method: Method, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket non connecte.'));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.disconnect(socket, new Error(`Timeout RPC ${method}.`));
      }, this.settings.rpcTimeout * 1000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, src: this.source, method, params }));
      } catch (error) {
        this.disconnect(socket, new Error(errorMessage(error)));
      }
    });
  }

  private async httpRpc(method: Method, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    const aborter = new AbortController();
    this.aborters.add(aborter);
    const timer = setTimeout(() => aborter.abort(), this.settings.rpcTimeout * 1000);
    try {
      const response = await fetch(`http://${this.settings.host}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, src: this.source, method, params }),
        signal: aborter.signal,
      });
      if (!response.ok) {
        const auth = response.status === 401 ? ' : authentification Shelly non prise en charge' : '';
        throw new Error(`HTTP ${response.status}${auth}`);
      }
      const frame: unknown = await response.json();
      if (!isObject(frame) || frame.id !== id) {
        throw new Error('Reponse RPC HTTP invalide (id).');
      }
      if ('error' in frame) {
        throw this.rpcError(frame.error);
      }
      if (!('result' in frame)) {
        throw new Error('Reponse RPC HTTP sans result.');
      }
      return frame.result;
    } finally {
      clearTimeout(timer);
      this.aborters.delete(aborter);
    }
  }
}
