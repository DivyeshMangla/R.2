import {
  ASSIST_WINDOW_S,
  CARD_AUTO_PICK_S,
  drawCards,
  grantXp,
  Msg,
  XP_PER_ASSIST,
  XP_PER_KILL,
  type CardOfferMsg,
  type CardResolvedMsg,
} from '@robot-arena/shared';
import type { GameHost } from './GameHost';
import type { PowerUpSystem } from './PowerUpSystem';
import type { ServerRobot } from './ServerRobot';

/** XP, assists, level-ups and the level-up card offer queue. */
export class ProgressionSystem {
  private readonly host: GameHost;
  private readonly powerups: PowerUpSystem;
  private nextOfferId = 1;

  constructor(host: GameHost, powerups: PowerUpSystem) {
    this.host = host;
    this.powerups = powerups;
  }

  /** Awards kill + assist XP. Returns ids of assisting robots. */
  onKill(killer: ServerRobot | null, victim: ServerRobot): number[] {
    const now = this.host.time;
    const assists: number[] = [];
    for (const [attackerId, t] of victim.damageLog) {
      if (killer && attackerId === killer.id) continue;
      if (attackerId === victim.id || now - t > ASSIST_WINDOW_S) continue;
      const a = this.host.robotById(attackerId);
      if (!a) continue;
      assists.push(a.id);
      this.giveXp(a, XP_PER_ASSIST);
    }
    if (killer && killer !== victim) this.giveXp(killer, XP_PER_KILL);
    victim.damageLog.clear();
    return assists;
  }

  giveXp(robot: ServerRobot, amount: number): void {
    const state = { level: robot.level, xp: robot.xp };
    const gained = grantXp(state, amount);
    robot.level = state.level;
    robot.xp = state.xp;
    if (gained > 0) {
      robot.pendingOffers += gained;
      this.host.emit({ k: 'levelup', id: robot.id, level: robot.level });
      this.activateNext(robot);
    }
    this.host.markRosterDirty();
  }

  private activateNext(robot: ServerRobot): void {
    while (!robot.activeOffer && robot.pendingOffers > 0) {
      robot.pendingOffers -= 1;
      const cards = drawCards(robot.stacks);
      if (cards.length === 0) {
        robot.pendingOffers = 0;
        return;
      }
      const autoDelay = robot.isBot ? 0.6 + Math.random() * 1.4 : CARD_AUTO_PICK_S;
      robot.activeOffer = { offerId: this.nextOfferId++, cards, expiresAt: this.host.time + autoDelay };
      if (!robot.isBot) {
        const msg: CardOfferMsg = { offerId: robot.activeOffer.offerId, cards, expiresIn: CARD_AUTO_PICK_S, queued: robot.pendingOffers };
        this.host.sendTo(robot, Msg.CARDS, msg);
      }
    }
  }

  /** Handles a client pick. Returns true when accepted. */
  pick(robot: ServerRobot, offerId: number, index: number): boolean {
    const offer = robot.activeOffer;
    if (!offer || offer.offerId !== offerId) return false;
    if (!Number.isInteger(index) || index < 0 || index >= offer.cards.length) return false;
    this.resolve(robot, index, false);
    return true;
  }

  private resolve(robot: ServerRobot, index: number, auto: boolean): void {
    const offer = robot.activeOffer;
    if (!offer) return;
    const picked = offer.cards[index];
    robot.activeOffer = null;
    if (picked) {
      this.powerups.grant(robot, picked);
      if (!robot.isBot) {
        const msg: CardResolvedMsg = { offerId: offer.offerId, picked, auto };
        this.host.sendTo(robot, Msg.CARDS_RESOLVED, msg);
      }
    }
    this.activateNext(robot);
  }

  update(): void {
    const now = this.host.time;
    for (const r of this.host.robots()) {
      const offer = r.activeOffer;
      if (offer && now >= offer.expiresAt) {
        const index = r.isBot ? this.botChoice(offer.cards) : Math.floor(Math.random() * offer.cards.length);
        this.resolve(r, index, !r.isBot);
      }
    }
  }

  /** Bots prefer rarer cards with a little randomness. */
  private botChoice(cards: readonly string[]): number {
    let best = 0;
    let bestScore = -1;
    cards.forEach((c, i) => {
      const def = this.powerups.definition(c);
      const base = def ? (def.rarity === 'epic' ? 3 : def.rarity === 'rare' ? 2 : 1) : 0;
      const score = base + Math.random() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }
}
