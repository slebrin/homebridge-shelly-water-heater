const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hap, until, delay, fixture, simulator, createHeater } = require('./helpers.cjs');
const { parseSettings, PLUGIN_NAME, PLATFORM_NAME } = require('../dist/config');
const register = require('../dist/index');
const C = hap.Characteristic;

async function select(heater, identifier) {
  const result = await heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), identifier);
  assert.equal(result.status, hap.HAPStatus.SUCCESS);
  await delay(0);
}

for (const scenario of [
  { title: '1. Arret -> relais OFF', mode: 'arret', output: false, id: 1 },
  { title: '2. Auto en HP -> relais OFF', mode: 'auto', output: false, id: 2 },
  { title: '3. Auto en HC -> relais ON', mode: 'auto', output: true, id: 2 },
  { title: '4. Marche forcee -> relais ON', mode: 'force', output: true, id: 3 },
]) {
  test(scenario.title, async t => {
    const { sim, heater } = await fixture(t);
    // The fixture, not Homebridge, represents the pre-existing Shelly script.
    sim.onMode = () => { sim.output = scenario.output; };
    await select(heater, scenario.id);
    assert.equal(sim.mode, scenario.mode);
    assert.equal(heater.controller.snapshot.mode, scenario.mode);
    assert.equal(heater.indicator.getCharacteristic(C.On).value, scenario.output);
    const writes = sim.requests.filter(request => request.method.endsWith('.Set'));
    assert.ok(writes.length >= 1);
    assert.ok(writes.every(request => request.method === 'Enum.Set' && request.params.id === 200));
  });
}

test('5. Transition du script Force -> Auto en HC, chauffe reste ON', async t => {
  const { sim, heater } = await fixture(t, { pollInterval: 3600 });
  sim.external('force', true);
  await until(() => heater.controller.snapshot.mode === 'force');
  sim.external('auto', true);
  await until(() => heater.television.getCharacteristic(C.ActiveIdentifier).value === 2);
  assert.equal(heater.indicator.getCharacteristic(C.On).value, true);
  assert.equal(sim.requests.filter(request => request.method.endsWith('.Set')).length, 0);
});

test('6. Changement UI Shelly -> Maison, sans attendre le polling', async t => {
  const { sim, heater } = await fixture(t, { pollInterval: 3600 });
  sim.external('arret', false);
  await until(() => heater.television.getCharacteristic(C.ActiveIdentifier).value === 1);
  sim.external('force', true);
  await until(() => heater.television.getCharacteristic(C.ActiveIdentifier).value === 3);
  assert.equal(heater.indicator.getCharacteristic(C.On).value, true);
});

test('7. Maison -> Enum.Set, noms personnalises et seulement trois sources', async t => {
  const { sim, heater } = await fixture(t, { states: { arret: 'OFF', auto: 'Automatique', force: 'Force' } });
  const sources = heater.accessory.services.filter(service => service.UUID === hap.Service.InputSource.UUID);
  assert.equal(sources.length, 3);
  assert.deepEqual(sources.map(source => source.getCharacteristic(C.ConfiguredName).value),
    ['OFF', 'Automatique', 'Force']);
  assert.deepEqual(sources.map(source => source.getCharacteristic(C.Identifier).value), [1, 2, 3]);
  assert.ok(sources.every(source => heater.television.linkedServices.includes(source)));
  await select(heater, 3);
  assert.equal(sim.mode, 'force');
  assert.equal(heater.television.getCharacteristic(C.ActiveIdentifier).value, 3);
  assert.ok(sim.requests.some(request => request.method === 'Enum.Set' && request.transport === 'ws'));
});

test('8. Relais -> indicateur, independamment du mode et avec notification partielle', async t => {
  const { sim, heater } = await fixture(t, { pollInterval: 3600 });
  const updates = [];
  heater.indicator.getCharacteristic(C.On).on('change', event => updates.push(event.newValue));
  sim.mode = 'force';
  sim.output = false;
  sim.notify({ 'switch:0': { output: false } });
  await until(() => heater.controller.snapshot.mode === 'force');
  assert.equal(heater.indicator.getCharacteristic(C.On).value, false);
  sim.output = true;
  sim.notify({ 'switch:0': { output: true } });
  await until(() => heater.indicator.getCharacteristic(C.On).value === true);
  sim.output = false;
  sim.notify({ 'switch:0': { output: false } });
  await until(() => heater.indicator.getCharacteristic(C.On).value === false);
  assert.ok(updates.includes(true));
  assert.equal(updates.at(-1), false);
});

test('9. Redemarrage : relecture mode et relais, aucune ecriture', async t => {
  const f = await fixture(t);
  f.sim.external('force', true);
  await until(() => f.heater.controller.snapshot.mode === 'force');
  const heater = await f.restart();
  assert.deepEqual(heater.controller.snapshot, { mode: 'force', heating: true });
  assert.equal(heater.television.getCharacteristic(C.ActiveIdentifier).value, 3);
  assert.equal(heater.indicator.getCharacteristic(C.On).value, true);
  assert.equal(f.sim.requests.filter(request => request.method.endsWith('.Set')).length, 0);
});

test('10. Perte puis retour connexion : refus de commande et resynchronisation', async t => {
  const { sim, heater } = await fixture(t);
  sim.offline = true;
  sim.disconnect();
  await until(() => !heater.controller.available);
  const count = sim.requests.filter(request => request.method === 'Enum.Set').length;
  const result = await heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), 3);
  assert.equal(result.status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(sim.requests.filter(request => request.method === 'Enum.Set').length, count);
  sim.mode = 'arret';
  sim.output = false;
  sim.offline = false;
  await until(() => heater.controller.available && heater.controller.snapshot.mode === 'arret');
  await until(() => sim.requests.filter(request => request.transport === 'ws').length > 2);
  assert.equal(heater.television.getCharacteristic(C.ActiveIdentifier).value, 1);
  assert.equal(heater.indicator.getCharacteristic(C.On).value, false);
});

test('Switch strictement read-only : HAP rejette ON/OFF sans RPC', async t => {
  const { sim, heater } = await fixture(t);
  const on = heater.indicator.getCharacteristic(C.On);
  assert.deepEqual(on.props.perms, [C.Perms.PAIRED_READ, C.Perms.NOTIFY]);
  const count = sim.requests.length;
  for (const value of [true, false]) {
    const result = await heater.networkWrite(on, value);
    assert.equal(result.status, hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }
  assert.equal(sim.requests.length, count);
  assert.equal(on.value, false);
  await assert.rejects(heater.controller.client.rpc('Switch.Set', { id: 0, on: true }), /interdite/);
  assert.equal(sim.requests.length, count);
});

test('Bouton alimentation et telecommande TV ne commandent ni mode ni relais', async t => {
  const { sim, heater } = await fixture(t);
  const count = sim.requests.length;
  for (const [type, value] of [[C.Active, 0], [C.RemoteKey, 0]]) {
    const result = await heater.networkWrite(heater.television.getCharacteristic(type), value);
    assert.equal(result.status, hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
  }
  const ok = await heater.networkWrite(heater.television.getCharacteristic(C.Active), 1);
  assert.equal(ok.status, hap.HAPStatus.SUCCESS);
  assert.equal(sim.requests.length, count);
});

test('Polling recupere une notification manquee sans logs de valeurs repetes', async t => {
  const { sim, heater } = await fixture(t);
  await heater.controller.refresh();
  const logs = heater.logs.filter(line => line.startsWith('Mode :') || line.startsWith('Chauffe-eau :')).length;
  await heater.controller.refresh();
  await heater.controller.refresh();
  assert.equal(heater.logs.filter(line => line.startsWith('Mode :') || line.startsWith('Chauffe-eau :')).length, logs);
  sim.notifications = false;
  sim.external('force', true);
  await until(() => heater.controller.snapshot.mode === 'force');
  assert.equal(heater.indicator.getCharacteristic(C.On).value, true);
});

test('RPC HTTP de secours quand le WebSocket est indisponible', async t => {
  const { sim, heater } = await fixture(t);
  const httpCount = sim.requests.filter(request => request.transport === 'http').length;
  sim.disconnect();
  await until(() => sim.requests.filter(request => request.transport === 'http').length > httpCount &&
    heater.controller.available && !heater.controller.client.socket);
  await select(heater, 1);
  assert.equal(sim.mode, 'arret');
  assert.ok(sim.requests.some(request => request.method === 'Enum.Set' && request.transport === 'http'));
});

test('Enum inconnu et relais invalide : erreur explicite puis recuperation', async t => {
  const { sim, heater } = await fixture(t);
  sim.invalidMode = true;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, false);
  await assert.rejects(heater.indicator.getCharacteristic(C.On).handleGetRequest(),
    error => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.ok(heater.logs.some(line => line.includes('inconnue ou invalide')));
  sim.invalidMode = false;
  sim.invalidRelay = true;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, false);
  sim.invalidRelay = false;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, true);
});

test('Timeout RPC puis retour : pas de faux etat, pas de commande hors ligne', async t => {
  const { sim, heater } = await fixture(t);
  sim.dropReads = true;
  await until(() => !heater.controller.available, 5000);
  await assert.rejects(heater.controller.setMode('force'), /non synchronise/);
  sim.dropReads = false;
  await until(() => heater.controller.available, 5000);
});

test('Reponse ecriture perdue : aucune repetition de Enum.Set, relecture seulement', async t => {
  const { sim, heater } = await fixture(t);
  sim.loseWriteResponse = true;
  const result = await heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), 3);
  assert.equal(result.status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await until(() => heater.controller.available && heater.controller.snapshot.mode === 'force');
  assert.equal(sim.requests.filter(request => request.method === 'Enum.Set').length, 1);
  assert.equal(sim.mode, 'force');
});

test('Le script peut annuler immediatement force; la valeur confirmee prime', async t => {
  const { sim, heater } = await fixture(t);
  sim.onMode = () => { sim.mode = 'auto'; sim.output = true; };
  await select(heater, 3);
  await until(() => heater.television.getCharacteristic(C.ActiveIdentifier).value === 2);
  assert.deepEqual(heater.controller.snapshot, { mode: 'auto', heating: true });
});

test('Commandes concurrentes serialisees, dernier etat confirme conserve', async t => {
  const { sim, heater } = await fixture(t);
  const results = await Promise.all([3, 1, 2].map(value =>
    heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), value)));
  assert.ok(results.every(result => result.status === hap.HAPStatus.SUCCESS));
  await delay(0);
  assert.deepEqual(sim.requests.filter(request => request.method === 'Enum.Set')
    .map(request => request.params.value), ['force', 'arret', 'auto']);
  assert.equal(sim.mode, 'auto');
  assert.equal(heater.television.getCharacteristic(C.ActiveIdentifier).value, 2);
});

test('Notifications continues : une commande ne reste pas bloquee derriere les lectures', async t => {
  const { sim, heater } = await fixture(t, { pollInterval: 3600 });
  sim.onRead = () => sim.notify({ 'switch:0': { output: sim.output } });
  const count = sim.requests.length;
  void heater.controller.refresh();
  await until(() => sim.requests.length > count + 2);
  await select(heater, 3);
  sim.onRead = undefined;
  assert.equal(sim.mode, 'force');
});

test('Reponses RPC malformees et erreurs RPC sont signalees sans faux succes', async t => {
  const { sim, heater } = await fixture(t);
  sim.malformed = true;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, false);
  sim.malformed = false;
  sim.errorCode = 401;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, false);
  assert.ok(heater.logs.some(line => line.includes('authentification')));
  sim.errorCode = undefined;
  await heater.controller.refresh();
  assert.equal(heater.controller.available, true);
});

test('Demarrage non synchronise : aucun OFF ou mode valide presume', async t => {
  const sim = await simulator();
  sim.dropReads = true;
  const heater = createHeater(sim);
  t.after(async () => { heater.controller.stop(); await sim.close(); });
  assert.equal(heater.controller.available, false);
  const result = await heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), 1);
  assert.equal(result.status, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(sim.requests.filter(request => request.method === 'Enum.Set').length, 0);
});

test('Validation configuration et IDs de sources invalides', async t => {
  assert.throws(() => parseSettings({ host: 'http://shelly' }), /host/);
  assert.throws(() => parseSettings({ host: 'shelly', enumId: 0 }), /enumId/);
  assert.throws(() => parseSettings({ host: 'shelly', pollInterval: 0 }), /pollInterval/);
  assert.throws(() => parseSettings({ host: 'shelly', states: { auto: '' } }), /states.auto/);
  assert.throws(() => parseSettings({ host: 'shelly', states: { auto: 'é'.repeat(33) } }), /states.auto/);
  const { sim, heater } = await fixture(t);
  const result = await heater.networkWrite(heater.television.getCharacteristic(C.ActiveIdentifier), 4);
  assert.equal(result.status, hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
  assert.equal(sim.requests.filter(request => request.method === 'Enum.Set').length, 0);
});

test('Enregistrement platform externe, identite stable et arret Homebridge', async t => {
  const sim = await simulator();
  const handlers = {};
  const published = [];
  const api = {
    hap,
    platformAccessory: require('homebridge/lib/platformAccessory').PlatformAccessory,
    registerPlatform: (plugin, name, constructor) => {
      assert.equal(plugin, PLUGIN_NAME);
      assert.equal(name, PLATFORM_NAME);
      api.constructor = constructor;
    },
    on: (event, handler) => { handlers[event] = handler; },
    publishExternalAccessories: (plugin, accessories) => published.push(...accessories),
  };
  const log = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
  register(api);
  new api.constructor(log, { platform: PLATFORM_NAME, host: sim.host }, api);
  handlers.didFinishLaunching();
  assert.equal(published.length, 1);
  assert.equal(published[0].category, hap.Categories.TELEVISION);
  await until(() => published[0].getService(hap.Service.Switch).getCharacteristic(C.On).statusCode === 0);
  const firstUuid = published[0].UUID;
  handlers.shutdown();
  new api.constructor(log, { host: sim.host, name: 'Renomme' }, api);
  handlers.didFinishLaunching();
  assert.equal(published[1].UUID, firstUuid);
  t.after(async () => { handlers.shutdown(); await sim.close(); });
});
