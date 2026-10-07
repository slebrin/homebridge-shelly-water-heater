const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocketServer, WebSocket } = require('ws');
const { HomebridgeAPI } = require('homebridge/lib/api');
const { hap } = new HomebridgeAPI();
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
const { HeaterAccessory, HeatingIndicatorAccessory } = require('../dist/accessory');
const { parseSettings } = require('../dist/config');

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Condition de test non atteinte.');
    }
    await delay(10);
  }
}

async function simulator() {
  const state = {
    mode: 'auto', output: false, offline: false, notifications: true,
    requests: [], sources: new Set(), invalidMode: false, invalidRelay: false,
    dropReads: false, loseWriteResponse: false, malformed: false, errorCode: undefined,
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    if (state.offline) {
      res.writeHead(503).end();
      return;
    }
    const frame = JSON.parse(body);
    const response = handle(frame, 'http');
    if (response !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(state.malformed ? 'not-json' : JSON.stringify(response));
    }
  });
  const ws = new WebSocketServer({ server, path: '/rpc' });
  ws.on('connection', socket => {
    if (state.offline) {
      socket.close();
      return;
    }
    socket.on('message', data => {
      const frame = JSON.parse(data.toString());
      socket.src = frame.src;
      state.sources.add(frame.src);
      const response = handle(frame, 'ws');
      if (state.loseWriteResponse && frame.method === 'Enum.Set') {
        socket.terminate();
      } else if (response !== undefined) {
        socket.send(state.malformed ? 'not-json' : JSON.stringify(response));
      }
    });
  });
  function notify(params) {
    if (!state.notifications) {
      return;
    }
    for (const socket of ws.clients) {
      if (socket.src && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ src: 'shelly-test', dst: socket.src, method: 'NotifyStatus', params }));
      }
    }
  }
  function handle(frame, transport) {
    state.requests.push({ ...frame, transport });
    const { method } = frame;
    if (state.errorCode !== undefined) {
      return { id: frame.id, error: { code: state.errorCode, message: 'simulated error' } };
    }
    if (state.dropReads && method !== 'Enum.Set') {
      return undefined;
    }
    let result;
    if (method === 'Enum.GetStatus') {
      state.onRead?.();
      result = { value: state.invalidMode ? 'invalid' : state.mode };
    } else if (method === 'Switch.GetStatus') {
      result = { output: state.invalidRelay ? 'ON' : state.output };
    } else if (method === 'Enum.Set') {
      state.mode = frame.params.value;
      state.onMode?.(state.mode);
      notify({ 'enum:200': { value: state.mode }, 'switch:0': { output: state.output } });
      result = null;
    } else {
      return { id: frame.id, error: { code: 404, message: 'unknown method' } };
    }
    return { id: frame.id, src: 'shelly-test', dst: frame.src, result };
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.host = `127.0.0.1:${server.address().port}`;
  state.notify = notify;
  state.external = (mode, output) => {
    state.mode = mode;
    state.output = output;
    notify({ 'enum:200': { value: mode }, 'switch:0': { output } });
  };
  state.disconnect = () => {
    for (const socket of ws.clients) {
      socket.terminate();
    }
  };
  state.close = async () => {
    state.disconnect();
    ws.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return state;
}

function createHeater(sim, overrides = {}) {
  const logs = [];
  const log = Object.assign((...args) => logs.push(args.join(' ')), {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    debug: () => {},
  });
  const settings = parseSettings({ host: sim.host, pollInterval: 1, rpcTimeout: 1, ...overrides });
  const accessory = new PlatformAccessory(settings.name, hap.uuid.generate(`test:${sim.host}`), hap.Categories.TELEVISION);
  const heater = new HeaterAccessory(accessory, settings, { hap }, log);
  const indicatorAccessory = new PlatformAccessory(
    `${settings.name} - En chauffe`,
    hap.uuid.generate(`test:${sim.host}:heating`),
    hap.Categories.SWITCH,
  );
  const indicator = new HeatingIndicatorAccessory(
    indicatorAccessory, heater.controller, settings, { hap }, log,
  );
  let iid = 1;
  for (const platformAccessory of [accessory, indicatorAccessory]) {
    platformAccessory._associatedHAPAccessory.aid = 1;
    for (const service of platformAccessory.services) {
      service.iid = iid++;
      for (const characteristic of service.characteristics) {
        characteristic.iid = iid++;
      }
    }
  }
  heater.indicator = indicator.indicator;
  heater.indicatorAccessory = indicatorAccessory;
  heater.logs = logs;
  heater.networkWrite = (characteristic, value) => {
    const owner = indicatorAccessory.services.some(
      service => service.characteristics.includes(characteristic),
    ) ? indicatorAccessory : accessory;
    return owner._associatedHAPAccessory.handleCharacteristicWrite(
      {}, { aid: 1, iid: characteristic.iid, value }, 0,
    );
  };
  heater.controller.start();
  return heater;
}

async function fixture(t, overrides) {
  const sim = await simulator();
  let heater = createHeater(sim, overrides);
  t.after(async () => {
    heater.controller.stop();
    await sim.close();
  });
  await until(() => heater.controller.available && sim.sources.size > 0);
  return {
    sim, get heater() { return heater; },
    restart: async () => {
      heater.controller.stop();
      heater = createHeater(sim, overrides);
      await until(() => heater.controller.available);
      return heater;
    },
  };
}

module.exports = { hap, until, delay, simulator, createHeater, fixture };
