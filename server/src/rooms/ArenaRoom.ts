import { Room, type Client } from '@colyseus/core';
import { decodeInput, MAX_PLAYERS, Msg, type PingMsg, type PickMsg, type PongMsg, type TuneMsg } from '@robot-arena/shared';
import { GameSimulation } from '../game/GameSimulation';

interface JoinOptions {
  name?: string;
}

/**
 * One match. State is not synced through Colyseus schema; instead the room
 * broadcasts compact snapshots + event batches that the client interpolates.
 */
export class ArenaRoom extends Room {
  override maxClients = MAX_PLAYERS;
  private game!: GameSimulation;
  private readonly clientsBySession = new Map<string, Client>();

  override onCreate(): void {
    this.autoDispose = true;
    this.setPatchRate(null);
    this.game = new GameSimulation({
      broadcast: (type, msg) => this.broadcast(type, msg),
      send: (sessionId, type, msg) => this.clientsBySession.get(sessionId)?.send(type, msg),
    });

    this.onMessage(Msg.INPUT, (client: Client, message: unknown) => {
      const frames = Array.isArray(message) && Array.isArray(message[0]) ? message : [message];
      for (const f of frames) {
        const input = decodeInput(f);
        if (input) this.game.queueInput(client.sessionId, input);
      }
    });

    this.onMessage(Msg.PICK, (client: Client, message: PickMsg) => {
      this.game.pickCard(client.sessionId, message?.offerId, message?.index);
    });

    this.onMessage(Msg.TUNE, (_client: Client, message: TuneMsg) => {
      this.game.tune(message?.key, message?.value);
    });

    this.onMessage(Msg.PING, (client: Client, message: PingMsg) => {
      const pong: PongMsg = { c: typeof message?.c === 'number' ? message.c : 0, s: this.game.serverTimeMs() };
      client.send(Msg.PONG, pong);
    });

    // Measure wall-clock time ourselves; the game owns its fixed-timestep accumulator.
    let last = performance.now();
    this.setSimulationInterval(() => {
      const now = performance.now();
      this.game.update(now - last);
      last = now;
    }, 1000 / 60);
  }

  override onJoin(client: Client, options?: JoinOptions): void {
    this.clientsBySession.set(client.sessionId, client);
    const robot = this.game.addHuman(client.sessionId, options?.name);
    client.send(Msg.WELCOME, this.game.welcomeFor(robot));
    console.log(`[arena ${this.roomId}] ${robot.name} joined as robot #${robot.id} (${this.game.humanCount()} human)`);
  }

  override onLeave(client: Client): void {
    this.clientsBySession.delete(client.sessionId);
    this.game.removeHuman(client.sessionId);
    console.log(`[arena ${this.roomId}] session ${client.sessionId} left (${this.game.humanCount()} human)`);
  }

  override onDispose(): void {
    this.game.dispose();
  }
}
