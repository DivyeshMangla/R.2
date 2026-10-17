export const SERVER_PORT = 2567;
export const ROOM_NAME = 'arena';

export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
/** Server broadcasts a snapshot every N simulation ticks (60 / 2 = 30 Hz). */
export const SNAPSHOT_EVERY_TICKS = 2;
/** Max inputs buffered server-side per player before old ones are dropped. */
export const MAX_INPUT_QUEUE = 12;

export const MAX_PLAYERS = 6;

export const MATCH_DURATION_S = 300;
export const RESULTS_DURATION_S = 10;
export const RESPAWN_DELAY_S = 3;
export const SPAWN_PROTECTION_S = 6;

export const BASE_HP = 100;
export const XP_PER_KILL = 100;
export const XP_PER_ASSIST = 40;
export const ASSIST_WINDOW_S = 5;
export const MAX_LEVEL = 10;
export const CARD_AUTO_PICK_S = 8;
export const CARDS_PER_OFFER = 3;

export const RARITY_WEIGHTS = { common: 60, rare: 30, epic: 10 } as const;

export const ROBOT_COLORS: readonly number[] = [0x19d3ff, 0xff3b6b, 0x7dff4a, 0xffb020, 0xb66bff, 0xff6a1a];

export const BOT_NAMES: readonly string[] = ['Rivet', 'Sprocket', 'Torque', 'Piston', 'Gearjaw', 'Voltage', 'Ratchet', 'Servo'];

export function xpToNext(level: number): number {
  return 100 + level * 50;
}
