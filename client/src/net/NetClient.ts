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
  type ShotResultMsg,
  type SnapshotMsg,
  type TuneMsg,
  type InputWire,
  type WelcomeMsg,
  type LobbySelection,
} from '@robot-arena/shared';

/** Artificial network conditions for testing (applied on this client only, both directions). */
export interface NetSimSettings {
  /** Extra one-way delay added to every message, ms (so RTT grows by twice this). */
  latencyMs: number;
  jitterMs: number;
  /** Probability [0,1] that an outgoing input packet is dropped. */
  inputLoss: number;
}

/** Inputs per packet: the newest plus the previous ones, so one lost packet never drops a trigger pull. */
const REDUNDANT_INPUTS = 3;

export interface NetHandlers {
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(msg: SnapshotMsg): void;
  onRoster(msg: RosterMsg): void;
  onEvents(msg: EventsMsg): void;
  onCards(msg: CardOfferMsg): void;
  onCardsResolved(msg: CardResolvedMsg): void;
  onResults(msg: ResultsMsg): void;
  onShotResult(msg: ShotResultMsg): void;
  onDisconnect(reason: string): void;
}

/** Thin Colyseus wrapper: input upload, clock sync via ping/pong, typed message routing. */
export class NetClient {
  rtt = 0;
  readonly sim: NetSimSettings = { latencyMs: 0, jitterMs: 0, inputLoss: 0 };
  private readonly recentInputs: InputWire[] = [];
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

  async connect(selection: LobbySelection): Promise<void> {
    const endpoint = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${SERVER_PORT}`;
    const client = new Client(endpoint);
    const room = await client.joinOrCreate(ROOM_NAME, selection);
    this.room = room;
    const h = this.handlers;
    room.onMessage(Msg.WELCOME, (m: WelcomeMsg) => this.delayed(() => {
      this.observeServerTime(m.serverTime);
      h.onWelcome(m);
    }));
    room.onMessage(Msg.SNAPSHOT, (m: SnapshotMsg) => this.delayed(() => {
      this.observeServerTime(m.t);
      h.onSnapshot(m);
    }));
    room.onMessage(Msg.ROSTER, (m: RosterMsg) => this.delayed(() => h.onRoster(m)));
    room.onMessage(Msg.EVENTS, (m: EventsMsg) => this.delayed(() => h.onEvents(m)));
    room.onMessage(Msg.CARDS, (m: CardOfferMsg) => this.delayed(() => h.onCards(m)));
    room.onMessage(Msg.CARDS_RESOLVED, (m: CardResolvedMsg) => this.delayed(() => h.onCardsResolved(m)));
    room.onMessage(Msg.RESULTS, (m: ResultsMsg) => this.delayed(() => h.onResults(m)));
    room.onMessage(Msg.SHOT_RESULT, (m: ShotResultMsg) => this.delayed(() => h.onShotResult(m)));
    room.onMessage(Msg.PONG, (m: PongMsg) => this.delayed(() => this.onPong(m)));
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
    const recent = this.recentInputs;
    recent.push(encodeInput(frame));
    if (recent.length > REDUNDANT_INPUTS) recent.shift();
    if (this.sim.inputLoss > 0 && Math.random() < this.sim.inputLoss) return;
    // Oldest first; the server discards seqs it has already queued.
    const packet = recent.slice();
    this.delayed(() => this.room?.send(Msg.INPUT, packet));
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
    const c = performance.now();
    this.delayed(() => this.room?.send(Msg.PING, { c }));
  }

  /** Runs `fn` now, or after the simulated one-way delay. */
  private delayed(fn: () => void): void {
    const ms = this.sim.latencyMs + (this.sim.jitterMs > 0 ? Math.random() * this.sim.jitterMs : 0);
    if (ms <= 0) fn();
    else window.setTimeout(fn, ms);
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
