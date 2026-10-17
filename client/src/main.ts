import { Game } from './Game';

const container = document.getElementById('app');
if (!container) throw new Error('#app container missing');

const game = new Game(container);
// Dev-only handle for debugging from the browser console.
if (import.meta.env.DEV) (window as unknown as { __arena: Game }).__arena = game;
game.start().catch((err: unknown) => {
  console.error('[robot-arena] failed to start', err);
  const msg = document.createElement('pre');
  msg.style.cssText = 'position:fixed;inset:auto 0 0 0;color:#ff3b6b;padding:12px;font:12px monospace;z-index:99;white-space:pre-wrap;';
  msg.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(msg);
});
