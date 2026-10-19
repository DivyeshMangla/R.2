import { CHARACTERS, MAPS, getCharacter, getMap, getArenaDefinition, type CharacterId, type LobbySelection, type MapId } from '@robot-arena/shared';
import { hex, mapSketch, robotSketch, sketchIcon } from './SketchArt';
import './lobby.css';

const KEY = 'robot-arena.lobby.v1';
type Panel = 'maps' | 'robots' | 'guide';

/** Comic workshop lobby. Every visible navigation item opens a working panel. */
export class Lobby {
  onDeploy: ((selection: LobbySelection) => void) | null = null;
  private readonly root = document.createElement('main');
  private readonly shell: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly deploy: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly mapPreview: HTMLElement;
  private readonly drawers: Map<Panel, HTMLElement> = new Map();
  private characterId: CharacterId = 'striker';
  private mapId: MapId = 'foundry';
  private busy = false;
  private reconnect = false;
  private activePanel: Panel | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    let saved: Partial<LobbySelection> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LobbySelection>; } catch { /* Storage is optional. */ }
    this.characterId = getCharacter(saved?.characterId).id;
    this.mapId = getMap(saved?.mapId).id;
    this.root.className = 'garage comic-garage';
    this.root.innerHTML = `
      <div class="garage-shell">
        <header class="workshop-header">
          <label class="pilot-plate"><span class="pilot-avatar">${sketchIcon('robots')}</span><span class="pilot-name"><small>YOUR CALLSIGN</small><input aria-label="Your callsign" maxlength="16" placeholder="ROOKIE" autocomplete="nickname"></span><span class="pilot-stripe">01</span></label>
          <div class="match-facts"><span><i>✦</i><b>6</b><small>PILOT BRAWL</small></span><span><i>⌖</i><b class="arena-size">200 × 200</b><small>METERS OF MAYHEM</small></span><span class="unarmed-fact"><i>∅</i><b>UNARMED</b><small>EVERY WEAPON IS SINGLE USE</small></span></div>
          <button type="button" class="garage-help" data-open="guide" aria-label="Open controls and how to play">${sketchIcon('guide')}<span>HOW TO PLAY</span></button>
        </header>
        <div class="workshop-stage">
          <nav class="workshop-nav" aria-label="Garage navigation">
            <button type="button" class="workshop-tab" data-home aria-pressed="true">${sketchIcon('garage')}<span>GARAGE</span></button>
            <button type="button" class="workshop-tab" data-open="robots" aria-pressed="false">${sketchIcon('robots')}<span>ROBOTS</span><b>3</b></button>
            <button type="button" class="workshop-tab" data-open="maps" aria-pressed="false">${sketchIcon('maps')}<span>ARENAS</span><b>6</b></button>
            <button type="button" class="workshop-tab" data-open="guide" aria-pressed="false">${sketchIcon('guide')}<span>FIELD GUIDE</span></button>
          </nav>
          <aside class="workshop-notes"><span class="note-pin"></span><p>MECHANIC'S NOTES</p><h2>GRAB IT.<br>USE IT ONCE.</h2><ol><li><b>01</b> Everybody starts unarmed.</li><li><b>02</b> Drive over a pad to grab a weapon.</li><li><b>03</b> One trigger pull spends it. Go find another.</li></ol><div class="note-stamp">6 SEC<br><small>SPAWN SHIELD</small></div><span class="note-scribble">29 weapons. One shot each.<br>Make it count. ↗</span></aside>
          <section class="garage-hero" aria-label="Selected robot"><div class="robot-caption"><span class="unit-number"></span><h1 class="robot-name"></h1><span class="robot-role"></span></div><div class="garage-robot-art"></div><div class="robot-floor-mark">UNARMED / READY TO ROLL</div><div class="character-arrows"><button type="button" data-cycle="-1" aria-label="Previous robot">‹</button><button type="button" data-cycle="1" aria-label="Next robot">›</button></div></section>
          <aside class="arena-brief"><span class="brief-label">ON THE WORKBENCH</span><div class="brief-sketch"></div><h2 class="brief-name"></h2><p class="brief-finish"></p><button type="button" data-open="maps">CHANGE ARENA <span>↗</span></button></aside>
        </div>
        <footer class="workshop-footer">
          <section class="quick-robots" aria-label="Quick character selection">${CHARACTERS.map((c, i) => `<button type="button" data-character="${c.id}" class="quick-robot"><span class="quick-number">0${i + 1}</span><span class="quick-robot-art"></span><strong>${c.name}</strong></button>`).join('')}</section>
          <button type="button" class="arena-ticket" data-open="maps"><span class="ticket-ribbon">SCRAP SKIRMISH <b>6 PILOTS</b></span><span class="ticket-body"><span class="ticket-icon">${sketchIcon('maps')}</span><span><strong class="ticket-map"></strong><small class="ticket-summary"></small></span><span class="ticket-arrow">↗</span></span></button>
          <div class="play-box"><button type="button" class="deploy-button">PLAY <span>➤</span></button><p class="garage-status" role="status" aria-live="polite">Choose a robot and arena. No starter guns.</p></div>
        </footer>
      </div>
      <section class="garage-drawer" data-panel="maps" hidden><div class="drawer-panel map-drawer" role="dialog" aria-modal="true" aria-label="Choose an arena"><header><div><span>THE FIELD SKETCHBOOK</span><h2>PICK YOUR PLAYGROUND.</h2></div><button type="button" data-close aria-label="Close arena selection">${sketchIcon('close')}</button></header><p class="drawer-intro">Six big arenas. Real cover, multiple routes, and weapon pads that restock with something new.</p><div class="sketch-map-grid">${MAPS.map((m, i) => `<button type="button" data-map="${m.id}" class="sketch-map-card"><span class="map-card-id">0${i + 1} / ${m.biome.toUpperCase()}</span>${mapSketch(m.id, `card-${m.id}`)}<strong>${m.name}</strong><small>${m.arenaSize} × ${m.arenaSize} m · ${getArenaDefinition(m.id).pickups.length} weapon pads</small><span class="map-card-copy">${m.description}</span><span class="map-card-select">SELECT ARENA ↗</span></button>`).join('')}</div></div></section>
      <section class="garage-drawer" data-panel="robots" hidden><div class="drawer-panel robot-drawer" role="dialog" aria-modal="true" aria-label="Choose a robot"><header><div><span>CHOOSE YOUR TROUBLEMAKER</span><h2>THREE CHASSIS. YOUR CALL.</h2></div><button type="button" data-close aria-label="Close robot selection">${sketchIcon('close')}</button></header><div class="sketch-robot-grid">${CHARACTERS.map((c, i) => `<button type="button" data-character="${c.id}" class="sketch-robot-card"><span>0${i + 1} / ${c.role.toUpperCase()}</span><div class="roster-art" data-art="${c.id}"></div><strong>${c.name}</strong><p>${c.description}</p><small>SPAWNS UNARMED · MAP-MATCHED FINISH</small></button>`).join('')}</div></div></section>
      <section class="garage-drawer" data-panel="guide" hidden><div class="drawer-panel guide-drawer" role="dialog" aria-modal="true" aria-label="How to play"><header><div><span>READ BEFORE YOU ROLL</span><h2>THE SHORT FIELD GUIDE.</h2></div><button type="button" data-close aria-label="Close field guide">${sketchIcon('close')}</button></header><div class="guide-flow"><article><b>01</b><h3>ROLL IN UNARMED</h3><p>Players and bots arrive empty-handed. Your spawn shield gives you six seconds to get moving.</p></article><article><b>02</b><h3>DRIVE OVER TO GRAB</h3><p>Roll across a glowing pad to pick up its weapon automatically. 29 weapons: guns, bows, rockets, blades, fire, poison, shields and more.</p></article><article><b>03</b><h3>ONE USE EACH</h3><p>Every weapon is single use: one trigger pull (a whole burst or flame blast) spends it. Pads restock in about 6 seconds with a random weapon. Press E to swap while armed.</p></article></div><dl class="garage-controls"><div><dt>W / S</dt><dd>Accelerate / brake, then reverse</dd></div><div><dt>A / D · ARROWS</dt><dd>Steer the front wheels</dd></div><div><dt>MOUSE + LEFT CLICK</dt><dd>Aim and use your weapon (single use)</dd></div><div><dt>HOLD RIGHT CLICK</dt><dd>Keep camera direction and steady framing</dd></div><div><dt>C</dt><dd>Recenter behind your robot</dd></div><div><dt>SPACE + A / D</dt><dd>Hold to drift; release to recover grip</dd></div><div><dt>SHIFT</dt><dd>Boost</dd></div><div><dt>Q</dt><dd>Use a power-up ability</dd></div><div><dt>E</dt><dd>Swap to the weapon on a nearby pad</dd></div><div><dt>1 / 2 / 3</dt><dd>Choose a level-up card</dd></div><div><dt>ESC</dt><dd>Release the mouse / settings</dd></div></dl><p class="guide-tip">The camera follows your robot while driving forward after you stop moving the mouse. Hold right click to keep your aim, or press C to recenter. Use walls, trees, freight crates, and raised paths to break line of sight. Bots patrol, take time to notice you, and pause between shots.</p><p class="guide-tip">Engine recording by <a href="https://opengameart.org/content/car-engine-loop-96khz-4s" target="_blank" rel="noopener noreferrer">qubodup (CC BY 3.0)</a>.</p></div></section>`;
    document.body.appendChild(this.root);
    this.shell = this.root.querySelector('.garage-shell')!;
    this.name = this.root.querySelector('input')!;
    this.name.value = new URLSearchParams(location.search).get('name')?.slice(0, 16) ?? (typeof saved?.name === 'string' ? saved.name.slice(0, 16) : '');
    this.deploy = this.root.querySelector('.deploy-button')!;
    this.status = this.root.querySelector('.garage-status')!;
    this.preview = this.root.querySelector('.garage-robot-art')!;
    this.mapPreview = this.root.querySelector('.brief-sketch')!;
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((node) => this.drawers.set(node.dataset.panel as Panel, node));
    this.root.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((button) => button.addEventListener('click', () => this.openPanel(button.dataset.open as Panel, button)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-close],[data-home]').forEach((button) => button.addEventListener('click', () => this.closePanel()));
    this.root.querySelectorAll<HTMLButtonElement>('[data-character]').forEach((button) => button.addEventListener('click', () => {
      if (this.busy) return;
      this.characterId = getCharacter(button.dataset.character).id;
      this.refresh(); this.closePanel();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((button) => button.addEventListener('click', () => {
      if (this.busy) return;
      this.mapId = getMap(button.dataset.map).id;
      this.refresh(); this.closePanel();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-cycle]').forEach((button) => button.addEventListener('click', () => {
      if (this.busy) return;
      const i = CHARACTERS.findIndex((c) => c.id === this.characterId);
      this.characterId = CHARACTERS[(i + Number(button.dataset.cycle) + CHARACTERS.length) % CHARACTERS.length].id;
      this.refresh();
    }));
    this.root.addEventListener('keydown', (event) => this.onDialogKey(event));
    this.drawers.forEach((drawer) => drawer.addEventListener('click', (event) => { if (event.target === drawer) this.closePanel(); }));
    const submit = (): void => {
      if (this.busy) return;
      const selection: LobbySelection = { name: this.name.value.trim().slice(0, 16), characterId: this.characterId, mapId: this.mapId };
      try { localStorage.setItem(KEY, JSON.stringify(selection)); } catch { /* No persistence required to play. */ }
      this.onDeploy?.(selection);
    };
    this.deploy.addEventListener('click', submit);
    this.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this.refresh();
  }

  private refresh(): void {
    const character = getCharacter(this.characterId), map = getMap(this.mapId), definition = getArenaDefinition(map.id);
    this.root.dataset.biome = map.biome;
    this.root.style.setProperty('--machine-paint', hex(map.palette.robotPaint));
    this.root.style.setProperty('--machine-accent', hex(map.palette.robotAccent));
    for (const [key, value] of [['character', this.characterId], ['map', this.mapId]]) {
      this.root.querySelectorAll<HTMLButtonElement>(`[data-${key}]`).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset[key] === value)));
    }
    this.preview.innerHTML = robotSketch(this.characterId, this.mapId);
    this.mapPreview.innerHTML = mapSketch(this.mapId, 'brief');
    this.root.querySelectorAll<HTMLElement>('[data-art]').forEach((node) => { node.innerHTML = robotSketch(getCharacter(node.dataset.art).id, this.mapId, `roster-${node.dataset.art}`); });
    this.root.querySelectorAll<HTMLElement>('.quick-robot').forEach((node) => { node.querySelector('.quick-robot-art')!.innerHTML = robotSketch(getCharacter(node.dataset.character).id, this.mapId, `quick-${node.dataset.character}`); });
    this.root.querySelector('.unit-number')!.textContent = `UNIT 0${CHARACTERS.findIndex((c) => c.id === this.characterId) + 1} / WORKSHOP EDITION`;
    this.root.querySelector('.robot-name')!.textContent = character.name;
    this.root.querySelector('.robot-role')!.textContent = `${character.role.toUpperCase()} CHASSIS`;
    this.root.querySelector('.brief-name')!.textContent = map.name;
    this.root.querySelector('.brief-finish')!.textContent = map.robotFinish;
    this.root.querySelector('.arena-size')!.textContent = `${map.arenaSize} × ${map.arenaSize}`;
    this.root.querySelector('.ticket-map')!.textContent = map.name;
    this.root.querySelector('.ticket-summary')!.textContent = `${map.arenaSize} m arena / ${definition.pickups.length} weapon pads / single-use weapons`;
  }

  private openPanel(panel: Panel, source: HTMLElement): void {
    if (this.busy) return;
    this.activePanel = panel;
    this.returnFocus = source;
    this.drawers.forEach((drawer, id) => { drawer.hidden = id !== panel; });
    this.shell.inert = true;
    this.root.querySelectorAll<HTMLButtonElement>('.workshop-tab').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.open === panel)));
    this.drawers.get(panel)?.querySelector<HTMLButtonElement>('[data-close]')?.focus();
  }

  private closePanel(): void {
    this.drawers.forEach((drawer) => { drawer.hidden = true; });
    this.shell.inert = false;
    this.activePanel = null;
    this.root.querySelectorAll<HTMLButtonElement>('.workshop-tab').forEach((button) => button.setAttribute('aria-pressed', String(button.hasAttribute('data-home'))));
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  private onDialogKey(event: KeyboardEvent): void {
    if (!this.activePanel) return;
    if (event.key === 'Escape') { event.preventDefault(); this.closePanel(); return; }
    if (event.key !== 'Tab') return;
    const items = this.drawers.get(this.activePanel)?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]');
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  setBusy(busy: boolean, message = ''): void {
    this.busy = busy;
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach((node) => { node.disabled = busy; });
    this.deploy.innerHTML = busy ? 'ROLLING OUT <span class="deploy-spinner"></span>' : this.reconnect ? 'RELOAD <span>↻</span>' : 'PLAY <span>➤</span>';
    if (message) this.setStatus(message);
  }

  setStatus(message: string, error = false): void { this.status.textContent = message; this.status.classList.toggle('error', error); }
  showDisconnected(reason: string): void { this.reconnect = true; this.show(); this.setBusy(false); this.setStatus(`${reason}. Reload the garage to rejoin.`, true); }
  show(): void { this.root.hidden = false; }
  hide(): void { this.closePanel(); this.root.hidden = true; }
}
