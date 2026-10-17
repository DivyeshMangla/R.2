/** Real WebSocket smoke test; start the server first. No report files written. */
import assert from 'node:assert/strict';
import { Client, type Room } from '@colyseus/sdk';
import { getArenaDefinition, MAPS, Msg, ROOM_NAME, type EventsMsg, type GameEvent, type RosterMsg, type SnapshotMsg, type WelcomeMsg } from '@robot-arena/shared';

interface Connected {
  room: Room;
  events: GameEvent[];
  welcome?: WelcomeMsg;
  roster?: RosterMsg;
  snapshot?: SnapshotMsg;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  const client = new Client(process.env.ARENA_URL ?? 'ws://localhost:2567');
  const connections: Connected[] = [];
  const namePrefix = `Test${Date.now() % 100000}`;
  const join = async (mapId: string, name: string, characterId: string, weaponId?: string): Promise<Connected> => {
    const room = await client.joinOrCreate(ROOM_NAME, { mapId, name, characterId, weaponId });
    const state: Connected = { room, events: [] };
    connections.push(state);
    room.onMessage('*', (type, message) => {
      if (type === Msg.WELCOME) state.welcome = message as WelcomeMsg;
      if (type === Msg.ROSTER) state.roster = message as RosterMsg;
      if (type === Msg.SNAPSHOT) state.snapshot = message as SnapshotMsg;
      if (type === Msg.EVENTS) state.events.push(...(message as EventsMsg).e);
    });
    await waitFor(() => !!state.welcome && !!state.roster && !!state.snapshot, 'welcome, roster, and snapshot');
    return state;
  };
  try {
    const first = await join('foundry', `${namePrefix}A`, 'spectre', 'rail');
    const second = await join('foundry', `${namePrefix}B`, 'bulwark');
    const otherMap = await join('crossroads', `${namePrefix}C`, 'striker', 'repeater');
    const invalid = await join('foundry', `${namePrefix}D`, 'invalid-character', 'invalid-weapon');
    assert.equal(first.room.roomId, second.room.roomId, 'Players selecting the same map should match together');
    assert.equal(first.room.roomId, invalid.room.roomId);
    assert.notEqual(first.room.roomId, otherMap.room.roomId, 'Different maps must have separate rooms');
    assert.equal(first.welcome!.mapId, 'foundry');
    assert.equal(otherMap.welcome!.mapId, 'crossroads');
    await waitFor(() => first.roster!.players.some((player) => player.name === `${namePrefix}D`), 'updated shared roster');
    const player = (connection: Connected, name: string) => connection.roster!.players.find((entry) => entry.name === name)!;
    assert.equal(player(first, `${namePrefix}A`).characterId, 'spectre');
    assert.equal(player(first, `${namePrefix}A`).weaponId, null);
    assert.equal(player(first, `${namePrefix}B`).weaponId, null);
    assert.equal(player(first, `${namePrefix}D`).characterId, 'striker');
    assert.equal(player(first, `${namePrefix}D`).weaponId, null);
    assert.equal(player(otherMap, `${namePrefix}C`).weaponId, null);
    assert.ok(!otherMap.roster!.players.some((entry) => entry.name === `${namePrefix}A`));
    assert.equal(first.snapshot!.pickups?.length, getArenaDefinition('foundry').pickups.length);
    assert.equal(otherMap.snapshot!.pickups?.length, getArenaDefinition('crossroads').pickups.length);
    const mapConnections = [first, otherMap];
    const harborPartner = await join('crossroads', `${namePrefix}Harbor2`, 'striker');
    assert.equal(harborPartner.room.roomId, otherMap.room.roomId);
    for (const map of MAPS) {
      if (map.id === 'foundry' || map.id === 'crossroads') continue;
      const selected = await join(map.id, `${namePrefix}${map.id}A`, 'striker');
      const partner = await join(map.id, `${namePrefix}${map.id}B`, 'bulwark');
      assert.equal(selected.room.roomId, partner.room.roomId, `${map.id}: same-map players must match together`);
      assert.equal(selected.welcome!.mapId, map.id, `${map.id}: welcome must keep the selected biome`);
      const expectedPads = getArenaDefinition(map.id).pickups.map((pad) => [pad.id, pad.weaponId, pad.position]);
      assert.deepEqual(selected.snapshot!.pickups!.map((pad) => [pad.id, pad.weaponId, pad.position]), expectedPads);
      assert.ok(!selected.roster!.players.some((entry) => entry.name === `${namePrefix}A`), `${map.id}: another map roster leaked into the room`);
      mapConnections.push(selected);
    }
    assert.equal(new Set(mapConnections.map(({ room }) => room.roomId)).size, MAPS.length, 'All six maps must have separate rooms');
    for (const connection of connections) connection.events.length = 0;
    const currentSpeed = first.welcome!.tuning.maxSpeed;
    first.room.send(Msg.TUNE, { key: 'maxSpeed', value: currentSpeed });
    const receivedTune = (connection: Connected) => connection.events.some((event) => event.k === 'tune' && event.key === 'maxSpeed' && event.value === currentSpeed);
    await waitFor(() => mapConnections.every(receivedTune), 'tuning event in all six map rooms');
    console.log('NETWORK HARNESS: PASS (all six biome maps, same-map matchmaking, map isolation, validated loadouts, welcome, roster, pickups, tuning across rooms)');
  } finally {
    await Promise.allSettled(connections.map(({ room }) => room.leave()));
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
