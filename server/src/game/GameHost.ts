import type { GameEvent, Vec3 } from '@robot-arena/shared';
import type { PhysicsWorld } from './PhysicsWorld';
import type { ServerRobot } from './ServerRobot';

export type DamageCause = 'projectile' | 'ram' | 'mine';

/** The services the simulation exposes to its subsystems. */
export interface GameHost {
  readonly physics: PhysicsWorld;
  /** Simulation time in seconds. */
  readonly time: number;
  robots(): Iterable<ServerRobot>;
  robotById(id: number): ServerRobot | undefined;
  emit(e: GameEvent): void;
  applyDamage(target: ServerRobot, amount: number, attacker: ServerRobot | null, cause: DamageCause, point: Vec3): number;
  heal(target: ServerRobot, amount: number, sourceId?: number): void;
  combatEnabled(): boolean;
  sendTo(robot: ServerRobot, type: string, msg: unknown): void;
  markRosterDirty(): void;
}
