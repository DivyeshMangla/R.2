import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { initPhysics, ROOM_NAME, SERVER_PORT } from '@robot-arena/shared';
import { ArenaRoom } from './rooms/ArenaRoom';

async function main(): Promise<void> {
  await initPhysics();
  const server = new Server({ transport: new WebSocketTransport() });
  server.define(ROOM_NAME, ArenaRoom);
  const port = Number(process.env.ARENA_PORT ?? SERVER_PORT);
  await server.listen(port);
  console.log(`[robot-arena] authoritative server listening on ws://localhost:${port}`);
}

main().catch((err: unknown) => {
  console.error('[robot-arena] failed to start', err);
  process.exit(1);
});
