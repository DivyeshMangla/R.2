/**
 * Rapier interaction groups: upper 16 bits = membership, lower 16 bits = filter.
 * Two colliders interact when (a.membership & b.filter) && (b.membership & a.filter).
 */
export const Group = {
  ENV: 1 << 0,
  ROBOT: 1 << 1,
  PROJECTILE: 1 << 2,
  DEBRIS: 1 << 3,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

export const CollisionGroups = {
  ENV: interactionGroups(Group.ENV, Group.ROBOT | Group.PROJECTILE | Group.DEBRIS | Group.ENV),
  ROBOT: interactionGroups(Group.ROBOT, Group.ENV | Group.ROBOT | Group.PROJECTILE | Group.DEBRIS),
  /** Debris ignores projectiles entirely. */
  DEBRIS: interactionGroups(Group.DEBRIS, Group.ENV | Group.ROBOT | Group.DEBRIS),
  /** Query groups used by projectile sweeps. */
  PROJECTILE_QUERY: interactionGroups(Group.PROJECTILE, Group.ENV | Group.ROBOT),
  /** Wheels only ride on the environment. */
  WHEEL_QUERY: interactionGroups(Group.ROBOT, Group.ENV),
  /** Line-of-sight / ground probes against the static world only. */
  ENV_QUERY: interactionGroups(Group.PROJECTILE, Group.ENV),
} as const;
