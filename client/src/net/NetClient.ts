import { Client, type Room } from '@colyseus/sdk';
import {
  encodeInput,
  Msg,
  ROOM_NAME,
  SERVER_PORT,
  type CardOfferMsg,
  type CardResolvedMsg,
  type EventsMsg,
  type InputFrame,
  type PickMsg,
  type PongMsg,
  type ResultsMsg,
  type RosterMsg,
  type SnapshotMsg,
  type TuneMsg,
  type WelcomeMsg,
} from '@robot-arena/shared';

export interface NetHandlers {
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(msg: SnapshotMsg): void;
  onRoster(msg: RosterMsg): void;
  onEvents(msg: EventsMsg): void;
  onCards(msg: CardOfferMsg): void;
  onCardsResolved(msg: CardResolvedMsg): void;
  onResults(msg: ResultsMsg): void;
  onDisconnect(reason: string): void;
}

/** Thin Colyseus wrapper: input upload, clock sync via ping/pong, typed message routing. */
export class NetClient {
  rtt = 0;
  /** serverTime ≈ performance.now() + clockOffset */
  private clockOffset = 0;
  private hasClock = false;
  private room: Room | null = null;
  private pingTimer = 0;
  private readonly handlers: NetHandlers;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.room !== null;
  }

  async connect(name: string): Promise<void> {
    const endpoint = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${SERVER_PORT}`;
    const client = new Client(endpoint);
    const room = await client.joinOrCreate(ROOM_NAME, { name });
    this.room = room;
    const h = this.handlers;
    room.onMessage(Msg.WELCOME, (m: WelcomeMsg) => {
      this.observeServerTime(m.serverTime);
      h.onWelcome(m);
    });
    room.onMessage(Msg.SNAPSHOT, (m: SnapshotMsg) => {
      this.observeServerTime(m.t);
      h.onSnapshot(m);
    });
    room.onMessage(Msg.ROSTER, (m: RosterMsg) => h.onRoster(m));
    room.onMessage(Msg.EVENTS, (m: EventsMsg) => h.onEvents(m));
    room.onMessage(Msg.CARDS, (m: CardOfferMsg) => h.onCards(m));
    room.onMessage(Msg.CARDS_RESOLVED, (m: CardResolvedMsg) => h.onCardsResolved(m));
    room.onMessage(Msg.RESULTS, (m: ResultsMsg) => h.onResults(m));
    room.onMessage(Msg.PONG, (m: PongMsg) => this.onPong(m));
    room.onLeave((code: number) => {
      this.room = null;
      window.clearInterval(this.pingTimer);
      h.onDisconnect(`Disconnected from server (code ${code})`);
    });
    this.pingTimer = window.setInterval(() => this.ping(), 1000);
    this.ping();
  }

  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  sendInput(frame: InputFrame): void {
    this.room?.send(Msg.INPUT, encodeInput(frame));
  }

  sendPick(offerId: number, index: number): void {
    const msg: PickMsg = { offerId, index };
    this.room?.send(Msg.PICK, msg);
  }

  sendTune(key: string, value: number): void {
    const msg: TuneMsg = { key, value };
    this.room?.send(Msg.TUNE, msg);
  }

  private ping(): void {
    this.room?.send(Msg.PING, { c: performance.now() });
  }

  private onPong(m: PongMsg): void {
    const now = performance.now();
    const rtt = Math.max(0, now - m.c);
    this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;
    const offset = m.s + rtt / 2 - now;
    if (!this.hasClock) {
      this.clockOffset = offset;
      this.hasClock = true;
    } else {
      this.clockOffset += (offset - this.clockOffset) * 0.15;
    }
  }

  /** Before the first pong, bootstrap the clock from server timestamps (never letting them be "in the future"). */
  private observeServerTime(serverT: number): void {
    const sample = serverT - performance.now();
    if (!this.hasClock) {
      this.clockOffset = sample;
      this.hasClock = true;
    } else if (sample > this.clockOffset) {
      this.clockOffset += (sample - this.clockOffset) * 0.5;
    }
  }

  dispose(): void {
    window.clearInterval(this.pingTimer);
    void this.room?.leave();
  }
}
