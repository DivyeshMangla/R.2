import * as THREE from 'three';
import { getMap, getPowerUp, MAX_LEVEL, RARITY_COLORS, type CardOfferMsg, type MapId, type PlayerInfo, type PowerUpId, type PowerUpStacks, type ResultsMsg } from '@robot-arena/shared';
import './styles.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Keep pilot hues readable when they are printed on the light paper panels. */
function inkHex(color: number): string {
  const r = Math.round(((color >> 16) & 255) * 0.3 + 52 * 0.7);
  const g = Math.round(((color >> 8) & 255) * 0.3 + 47 * 0.7);
  const b = Math.round((color & 255) * 0.3 + 39 * 0.7);
  return hex((r << 16) | (g << 8) | b);
}

export interface AbilityDisplay {
  id: string;
  icon: string;
  cooldown: number;
  max: number;
  key: string;
}

interface DamageNumber {
  node: HTMLDivElement;
  world: THREE.Vector3;
  age: number;
  life: number;
  drift: number;
}

const tmp = new THREE.Vector3();

/** HTML/CSS overlay HUD: vitals, abilities, kill feed, scoreboards, cards, results, damage numbers. */
export class UI {
  private readonly hud: HTMLDivElement;
  private readonly splash: HTMLDivElement;
  private readonly splashStatus: HTMLDivElement;
  private readonly hpBar: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpGhost: HTMLDivElement;
  private readonly hpValue: HTMLDivElement;
  private readonly xpFill: HTMLDivElement;
  private readonly xpValue: HTMLDivElement;
  private readonly boostFill: HTMLDivElement;
  private readonly levelBadge: HTMLDivElement;
  private readonly abilities: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly killfeed: HTMLDivElement;
  private readonly miniScore: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly hitmarker: HTMLDivElement;
  private readonly centerMsg: HTMLDivElement;
  private readonly statusTag: HTMLDivElement;
  private readonly damageFlashEl: HTMLDivElement;
  private readonly lowHpEl: HTMLDivElement;
  private readonly numbers: HTMLDivElement;
  private readonly cards: HTMLDivElement;
  private readonly cardsRow: HTMLDivElement;
  private readonly cardsTimerFill: HTMLDivElement;
  private readonly cardsQueued: HTMLDivElement;
  private readonly resultsOverlay: HTMLDivElement;
  private readonly resultsBox: HTMLDivElement;
  private readonly netInfo: HTMLDivElement;
  private readonly weaponHud: HTMLDivElement;
  private readonly pickupPrompt: HTMLDivElement;
  private readonly driveFeedback: HTMLDivElement;
  private readonly driveSpeed: HTMLSpanElement;
  private readonly driveMode: HTMLDivElement;
  private readonly driveHeading: HTMLSpanElement;
  private readonly mapName: HTMLDivElement;
  private readonly biomeLabel: HTMLDivElement;
  private weaponLabel = '';
  private readonly hitArcs: { node: HTMLDivElement; t: number }[] = [];
  private nextArc = 0;
  private readonly killBanner: HTMLDivElement;
  private readonly killBannerName: HTMLDivElement;
  private readonly killBannerSub: HTMLDivElement;
  private killBannerT = 0;
  private readonly dmgNumbers: DamageNumber[] = [];
  private hitTimer = 0;
  private flashTimer = 0;
  private cardExpiry = 0;
  private cardDuration = 8;
  private abilityKey = '';
  private abilityNodes = new Map<string, { root: HTMLDivElement; cd: HTMLDivElement; timer: HTMLDivElement }>();
  private lastHpFrac = 1;
  private resultsEndsAt = 0;
  private resultsNext: HTMLDivElement | null = null;
  activeOffer: CardOfferMsg | null = null;
  onPick: ((index: number) => void) | null = null;
  onPlay: (() => void) | null = null;

  constructor() {
    this.hud = el('div', 'hud', document.body);

    this.damageFlashEl = el('div', 'damage-flash', this.hud);
    this.lowHpEl = el('div', 'low-hp-vignette', this.hud);
    this.numbers = el('div', '', this.hud);

    const folio = el('div', 'map-folio panel', this.hud);
    el('span', 'folio-mark', folio, '✧');
    el('small', 'folio-eyebrow', folio, 'SCRAP SKIRMISH / LIVE ARENA');
    this.mapName = el('div', 'folio-name', folio);
    this.biomeLabel = el('div', 'folio-biome', folio);

    const vitals = el('div', 'vitals panel', this.hud);
    vitals.style.position = 'absolute';
    this.levelBadge = el('div', 'level-badge', vitals, '1');
    const hpRow = el('div', 'row', vitals);
    el('div', 'label', hpRow, 'HULL');
    this.hpBar = el('div', 'bar hp', hpRow);
    this.hpGhost = el('div', 'ghost', this.hpBar);
    this.hpFill = el('div', 'fill', this.hpBar);
    this.hpValue = el('div', 'value', hpRow, '100');
    const xpRow = el('div', 'row', vitals);
    el('div', 'label', xpRow, 'XP');
    const xpBar = el('div', 'bar xp', xpRow);
    this.xpFill = el('div', 'fill', xpBar);
    this.xpValue = el('div', 'value', xpRow, '0/150');
    const boostRow = el('div', 'row', vitals);
    el('div', 'label', boostRow, 'BST');
    const boostBar = el('div', 'bar boost', boostRow);
    this.boostFill = el('div', 'fill', boostBar);
    el('div', 'value', boostRow, 'SHIFT');

    this.abilities = el('div', 'abilities', this.hud);
    this.timer = el('div', 'match-timer panel', this.hud, '5:00');
    this.killfeed = el('div', 'killfeed', this.hud);
    this.miniScore = el('div', 'mini-score panel', this.hud);
    this.scoreboard = el('div', 'scoreboard panel', this.hud);
    this.crosshair = el('div', 'crosshair', this.hud);
    this.hitmarker = el('div', 'hitmarker', this.hud);
    this.centerMsg = el('div', 'center-msg', this.hud);
    this.statusTag = el('div', 'status-tag panel', this.hud, 'STUNNED');
    this.netInfo = el('div', 'net-info', this.hud);
    this.weaponHud = el('div', 'weapon-hud', this.hud);
    this.pickupPrompt = el('div', 'pickup-prompt', this.hud);
    this.driveFeedback = el('div', 'drive-feedback panel', this.hud);
    const speedRow = el('div', 'drive-speed-row', this.driveFeedback);
    this.driveSpeed = el('span', 'drive-speed', speedRow, '0');
    el('small', '', speedRow, 'KM/H');
    this.driveHeading = el('span', 'drive-heading', speedRow, '▲');
    this.driveHeading.title = 'Chassis direction relative to your view';
    this.driveMode = el('div', 'drive-mode', this.driveFeedback, 'READY');
    el('small', 'drive-tip', this.driveFeedback, 'C recenter · RMB hold view');
    const arcs = el('div', 'hit-indicator', this.hud);
    for (let i = 0; i < 4; i++) this.hitArcs.push({ node: el('div', 'hit-arc', arcs), t: 0 });
    this.killBanner = el('div', 'kill-banner', this.hud);
    el('div', 'tag', this.killBanner, 'ELIMINATED');
    this.killBannerName = el('div', 'name', this.killBanner);
    this.killBannerSub = el('div', 'sub', this.killBanner);

    this.cards = el('div', 'cards', this.hud);
    el('div', 'title', this.cards, 'LEVEL UP — CHOOSE AN UPGRADE');
    this.cardsRow = el('div', 'row', this.cards);
    const cardsTimer = el('div', 'timer', this.cards);
    this.cardsTimerFill = el('div', 'fill', cardsTimer);
    this.cardsQueued = el('div', 'queued', this.cards);

    this.resultsOverlay = el('div', 'overlay hidden', document.body);
    this.resultsBox = el('div', 'results panel', this.resultsOverlay);

    this.splash = el('div', 'overlay', document.body);
    const box = el('div', 'splash', this.splash);
    el('h1', '', box, 'ROBOT ARENA');
    el('div', 'sub', box, 'AUTHORITATIVE • PHYSICS • MAYHEM');
    el('div', 'play', box, 'CLICK TO PLAY');
    this.splashStatus = el('div', 'status', box, 'Connecting…');
    const controls = el('div', 'controls', box);
    const rows: [string, string][] = [
      ['<kbd>W</kbd> / <kbd>S</kbd>', 'Accelerate / brake then reverse'],
      ['<kbd>A</kbd> / <kbd>D</kbd>', 'Steer the front wheels'],
      ['<kbd>Mouse</kbd>', 'Aim turret'],
      ['<kbd>RMB</kbd> / <kbd>C</kbd>', 'Hold view / recenter behind robot'],
      ['<kbd>LMB</kbd>', 'Fire cannon'],
      ['<kbd>Shift</kbd>', 'Boost'],
      ['<kbd>Space</kbd>', 'Ability (from power-ups)'],
      ['<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>', 'Pick level-up card'],
      ['<kbd>Tab</kbd>', 'Scoreboard'],
      ['<kbd>`</kbd> / <kbd>F2</kbd>', 'Tuning panel'],
      ['<kbd>F3</kbd>', 'Performance overlay'],
      ['<kbd>F4</kbd> / <kbd>F5</kbd>', 'Aim debug / side view'],
      ['<kbd>M</kbd>', 'Mute'],
      ['<kbd>Esc</kbd>', 'Settings (releases mouse)'],
    ];
    for (const [k, d] of rows) {
      el('div', '', controls).innerHTML = k;
      el('div', '', controls, d);
    }
    this.splash.addEventListener('click', () => this.onPlay?.());
    this.setMapTheme('foundry');
  }

  setMapTheme(mapId: MapId): void {
    const map = getMap(mapId);
    const labels = { volcanic: 'Volcanic frontier', urban: 'Harbor district', forest: 'Living woodland', desert: 'Dune country', arctic: 'Frozen frontier', ancient: 'Ancient sanctuary' };
    this.mapName.textContent = map.name;
    this.biomeLabel.textContent = labels[map.biome];
    for (const surface of [this.hud, this.resultsOverlay, this.splash]) {
      surface.dataset.biome = map.biome;
      surface.style.setProperty('--biome-accent', hex(map.palette.accent));
      surface.style.setProperty('--biome-ground', hex(map.palette.ground));
    }
  }

  // ------------------------------------------------------------- splash

  setSplashVisible(v: boolean): void {
    this.splash.classList.toggle('hidden', !v);
  }

  setHudVisible(visible: boolean): void {
    this.hud.style.display = visible ? '' : 'none';
  }

  setWeapon(name: string, role: string): void {
    const label = `${name}|${role}`;
    if (label === this.weaponLabel) return;
    this.weaponLabel = label;
    this.weaponHud.textContent = '';
    el('small', '', this.weaponHud, 'EQUIPPED WEAPON');
    el('strong', '', this.weaponHud, name);
    el('small', '', this.weaponHud, role);
  }

  setPickupPrompt(text: string): void {
    if (this.pickupPrompt.textContent !== text) this.pickupPrompt.textContent = text;
  }

  setDriving(forwardSpeed: number, throttle: number, relativeYaw: number, grounded: boolean, boosting: boolean, alive: boolean): void {
    const speed = Number.isFinite(forwardSpeed) ? forwardSpeed : 0;
    this.driveSpeed.textContent = String(Math.round(Math.abs(speed) * 3.6));
    const mode = !alive ? 'OFFLINE' : !grounded ? 'AIRBORNE' : throttle * speed < -0.6 ? 'BRAKING'
      : speed < -0.5 ? 'REVERSE' : boosting ? 'BOOST' : Math.abs(speed) < 0.5 ? 'READY'
      : Math.abs(throttle) < 0.05 ? 'COAST' : 'DRIVE';
    if (this.driveMode.textContent !== mode) this.driveMode.textContent = mode;
    this.driveFeedback.dataset.mode = mode.toLowerCase();
    const angle = Number.isFinite(relativeYaw) ? Math.atan2(Math.sin(relativeYaw), Math.cos(relativeYaw)) : 0;
    this.driveHeading.style.transform = `rotate(${angle}rad)`;
  }

  setStatus(text: string, error = false): void {
    this.splashStatus.textContent = text;
    this.splashStatus.classList.toggle('error', error);
  }

  // ------------------------------------------------------------- vitals

  updateVitals(hp: number, maxHp: number, level: number, xp: number, xpToNext: number, boost: number, alive: boolean): void {
    const frac = maxHp > 0 ? Math.max(0, hp) / maxHp : 0;
    this.hpFill.style.transform = `scaleX(${frac})`;
    if (frac < this.lastHpFrac) this.hpGhost.style.transform = `scaleX(${frac})`;
    else this.hpGhost.style.transform = `scaleX(${frac})`;
    this.lastHpFrac = frac;
    this.hpValue.textContent = `${Math.ceil(Math.max(0, hp))}/${maxHp}`;
    this.hpBar.classList.toggle('low', frac < 0.3);
    this.lowHpEl.classList.toggle('show', alive && frac < 0.3);
    const maxed = level >= MAX_LEVEL;
    this.xpFill.style.transform = `scaleX(${maxed ? 1 : Math.min(1, xp / xpToNext)})`;
    this.xpValue.textContent = maxed ? 'MAX' : `${xp}/${xpToNext}`;
    this.levelBadge.textContent = String(level);
    this.levelBadge.classList.toggle('max', maxed);
    this.boostFill.style.transform = `scaleX(${Math.max(0, Math.min(1, boost / 100))})`;
  }

  updateAbilities(list: AbilityDisplay[]): void {
    const key = list.map((a) => a.id).join(',');
    if (key !== this.abilityKey) {
      this.abilityKey = key;
      this.abilities.textContent = '';
      this.abilityNodes.clear();
      for (const a of list) {
        const root = el('div', 'ability', this.abilities);
        el('span', '', root, a.icon);
        const cd = el('div', 'cd', root);
        const timer = el('div', 'timer', root);
        el('div', 'key', root, a.key);
        this.abilityNodes.set(a.id, { root, cd, timer });
      }
    }
    for (const a of list) {
      const n = this.abilityNodes.get(a.id);
      if (!n) continue;
      const p = a.max > 0 ? Math.min(1, a.cooldown / a.max) : 0;
      n.cd.style.setProperty('--p', `${p * 100}%`);
      n.timer.textContent = a.cooldown > 0.05 ? a.cooldown.toFixed(1) : '';
      n.root.classList.toggle('ready', a.cooldown <= 0.05);
    }
  }

  setTimer(seconds: number, results: boolean): void {
    const s = Math.max(0, Math.ceil(seconds));
    this.timer.textContent = results ? `NEXT ${s}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.timer.classList.toggle('urgent', !results && s <= 30);
  }

  setNetInfo(text: string): void {
    this.netInfo.textContent = text;
  }

  // ------------------------------------------------------------- feed & scores

  addKill(killer: PlayerInfo | undefined, victim: PlayerInfo | undefined, assists: PlayerInfo[], involvesMe: boolean): void {
    const row = el('div', `kill panel${involvesMe ? ' me' : ''}`, this.killfeed);
    const name = (p: PlayerInfo | undefined, fallback: string): HTMLSpanElement => {
      const s = el('span', '', row, p ? p.name : fallback);
      if (p) s.style.color = inkHex(p.color);
      return s;
    };
    if (killer && killer !== victim) name(killer, '');
    el('span', 'icon', row, killer ? '✖' : '☠');
    name(victim, 'Unknown');
    if (assists.length) el('span', 'assist', row, `+ ${assists.map((a) => a.name).join(', ')}`);
    while (this.killfeed.children.length > 6) this.killfeed.firstElementChild?.remove();
    window.setTimeout(() => {
      row.style.opacity = '0';
      window.setTimeout(() => row.remove(), 700);
    }, 5500);
  }

  updateScores(players: PlayerInfo[], myId: number): void {
    const sorted = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.miniScore.textContent = '';
    const top = sorted.slice(0, 4);
    const me = sorted.find((p) => p.id === myId);
    if (me && !top.includes(me)) top.push(me);
    for (const p of top) {
      const line = el('div', `line${p.id === myId ? ' me' : ''}`, this.miniScore);
      el('div', 'swatch', line).style.background = hex(p.color);
      el('div', 'name', line, `${sorted.indexOf(p) + 1}. ${p.name}`);
      el('div', 'k', line, `${p.kills}`);
    }

    this.scoreboard.textContent = '';
    el('h2', '', this.scoreboard, 'SCOREBOARD');
    const head = el('div', 'line head', this.scoreboard);
    el('div', 'swatch', head);
    el('div', 'name', head, 'PILOT');
    el('div', 'pups', head, 'UPGRADES');
    el('div', 'col', head, 'LVL');
    el('div', 'col', head, 'K');
    el('div', 'col', head, 'D');
    for (const p of sorted) {
      const line = el('div', `line${p.id === myId ? ' me' : ''}`, this.scoreboard);
      el('div', 'swatch', line).style.background = hex(p.color);
      el('div', 'name', line, `${p.name}${p.isBot ? ' [BOT]' : ''}`);
      const pups = Object.entries(p.stacks)
        .map(([id, n]) => `${getPowerUp(id)?.icon ?? '?'}${(n ?? 0) > 1 ? n : ''}`)
        .join(' ');
      el('div', 'pups', line, pups || '—');
      el('div', 'col', line, String(p.level));
      el('div', 'col', line, String(p.kills));
      el('div', 'col', line, String(p.deaths));
    }
  }

  setScoreboardVisible(v: boolean): void {
    this.scoreboard.classList.toggle('show', v);
  }

  // ------------------------------------------------------------- crosshair & status

  setCrosshair(x: number, y: number, visible: boolean): void {
    this.crosshair.style.display = visible ? 'block' : 'none';
    this.crosshair.style.left = `${x}px`;
    this.crosshair.style.top = `${y}px`;
    this.hitmarker.style.left = `${x}px`;
    this.hitmarker.style.top = `${y}px`;
  }

  /** 'enemy' = the aim ray is on an enemy; 'clamped' = the barrel cannot pitch far enough to reach the point. */
  setCrosshairState(state: 'none' | 'enemy' | 'clamped'): void {
    this.crosshair.classList.toggle('enemy', state === 'enemy');
    this.crosshair.classList.toggle('clamped', state === 'clamped');
  }

  /** Server-confirmed hit (kill = larger, longer marker). */
  showHitmarker(kill = false): void {
    this.hitTimer = kill ? 0.35 : 0.12;
    this.hitmarker.classList.add('show');
    this.hitmarker.classList.toggle('kill', kill);
    this.crosshair.classList.add('hit');
  }

  /** Damage direction relative to the view: 0 = in front, +PI/2 = to the right. */
  showHitIndicator(angle: number, strength: number): void {
    const a = this.hitArcs[this.nextArc];
    this.nextArc = (this.nextArc + 1) % this.hitArcs.length;
    a.t = 0.9;
    a.node.style.transform = `translate(-50%, -50%) rotate(${angle}rad) translateY(-120px)`;
    a.node.style.opacity = String(Math.min(1, 0.5 + strength / 40));
    a.node.classList.add('show');
  }

  showKillBanner(name: string, color: number, sub: string): void {
    this.killBannerName.textContent = name;
    this.killBannerName.style.color = hex(color);
    this.killBannerSub.textContent = sub;
    this.killBanner.classList.remove('show');
    // Restart the CSS animation.
    void this.killBanner.offsetWidth;
    this.killBanner.classList.add('show');
    this.killBannerT = 2.2;
  }

  setCenterMessage(text: string, small = '', countdown = false): void {
    if (!text) {
      this.centerMsg.textContent = '';
      this.centerMsg.classList.remove('countdown');
      return;
    }
    const big = this.centerMsg.firstElementChild;
    // Called every frame: only rebuild (and re-trigger the countdown pop) when the text changes.
    if (big?.textContent === text && (this.centerMsg.querySelector('small')?.textContent ?? '') === small
      && this.centerMsg.classList.contains('countdown') === countdown) return;
    this.centerMsg.innerHTML = '';
    this.centerMsg.classList.toggle('countdown', countdown);
    el('div', '', this.centerMsg, text);
    if (small) el('small', '', this.centerMsg, small);
  }

  setStunned(v: boolean): void {
    this.statusTag.classList.toggle('show', v);
  }

  damageFlash(): void {
    this.flashTimer = 0.08;
    this.damageFlashEl.classList.add('show');
  }

  // ------------------------------------------------------------- damage numbers

  spawnNumber(world: THREE.Vector3, text: string, kind: 'dealt' | 'crit' | 'taken' | 'heal'): void {
    const node = el('div', `dmg-num${kind === 'dealt' ? '' : ` ${kind}`}`, this.numbers, text);
    this.dmgNumbers.push({ node, world: world.clone().add(new THREE.Vector3(0, 1.4, 0)), age: 0, life: 0.95, drift: (Math.random() - 0.5) * 40 });
    while (this.dmgNumbers.length > 40) {
      const old = this.dmgNumbers.shift();
      old?.node.remove();
    }
  }

  // ------------------------------------------------------------- cards

  showCards(offer: CardOfferMsg, stacks: PowerUpStacks): void {
    this.activeOffer = offer;
    this.cardDuration = offer.expiresIn;
    this.cardExpiry = performance.now() + offer.expiresIn * 1000;
    this.cardsRow.textContent = '';
    offer.cards.forEach((id: PowerUpId, i) => {
      const def = getPowerUp(id);
      if (!def) return;
      const card = el('div', 'card', this.cardsRow);
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Choose ${def.name}: ${def.description}`);
      card.style.setProperty('--rc', RARITY_COLORS[def.rarity]);
      el('div', 'icon', card, def.icon);
      el('div', 'name', card, def.name);
      el('div', 'rarity', card, def.rarity);
      el('div', 'desc', card, def.description);
      el('div', 'stack', card, `${stacks[id] ?? 0}/${def.maxStacks}`);
      el('div', 'hotkey', card, `[${i + 1}]`);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPick?.(i);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        this.onPick?.(i);
      });
    });
    this.cardsQueued.textContent = offer.queued > 0 ? `+${offer.queued} more upgrade${offer.queued > 1 ? 's' : ''} queued` : '';
    this.cards.classList.add('show');
  }

  markChosen(index: number): void {
    const c = this.cardsRow.children[index];
    if (c) c.classList.add('chosen');
  }

  hideCards(): void {
    this.activeOffer = null;
    this.cards.classList.remove('show');
  }

  // ------------------------------------------------------------- results

  showResults(msg: ResultsMsg, myId: number): void {
    this.resultsBox.textContent = '';
    el('h2', '', this.resultsBox, 'MATCH OVER');
    const winner = msg.standings[0];
    const w = el('div', 'winner', this.resultsBox, winner ? `${winner.name} wins with ${winner.kills} kills` : '');
    if (winner) w.style.color = inkHex(winner.color);
    msg.standings.forEach((s, i) => {
      const line = el('div', `line${s.id === myId ? ' me' : ''}`, this.resultsBox);
      el('div', 'rank', line, `${i + 1}`);
      el('div', 'swatch', line).style.background = hex(s.color);
      el('div', 'name', line, s.name);
      el('div', 'col', line, `L${s.level}`);
      el('div', 'col', line, `${s.kills} K`);
      el('div', 'col', line, `${s.deaths} D`);
    });
    this.resultsNext = el('div', 'next', this.resultsBox, '');
    this.resultsEndsAt = performance.now() + msg.duration * 1000;
    this.resultsOverlay.classList.remove('hidden');
  }

  hideResults(): void {
    this.resultsOverlay.classList.add('hidden');
  }

  // ------------------------------------------------------------- per-frame

  update(dt: number, camera: THREE.Camera, width: number, height: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) {
        this.hitmarker.classList.remove('show', 'kill');
        this.crosshair.classList.remove('hit');
      }
    }
    for (const a of this.hitArcs) {
      if (a.t <= 0) continue;
      a.t -= dt;
      if (a.t <= 0) a.node.classList.remove('show');
    }
    if (this.killBannerT > 0) {
      this.killBannerT -= dt;
      if (this.killBannerT <= 0) this.killBanner.classList.remove('show');
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.damageFlashEl.classList.remove('show');
    }
    if (this.activeOffer) {
      const left = Math.max(0, (this.cardExpiry - performance.now()) / 1000);
      this.cardsTimerFill.style.transform = `scaleX(${left / this.cardDuration})`;
    }
    if (this.resultsNext) {
      const left = Math.max(0, (this.resultsEndsAt - performance.now()) / 1000);
      this.resultsNext.textContent = `Next match in ${Math.ceil(left)}s`;
    }
    for (let i = this.dmgNumbers.length - 1; i >= 0; i--) {
      const d = this.dmgNumbers[i];
      d.age += dt;
      const t = d.age / d.life;
      if (t >= 1) {
        d.node.remove();
        this.dmgNumbers.splice(i, 1);
        continue;
      }
      tmp.copy(d.world).project(camera);
      if (tmp.z > 1) {
        d.node.style.opacity = '0';
        continue;
      }
      const x = (tmp.x * 0.5 + 0.5) * width + d.drift * t;
      const y = (-tmp.y * 0.5 + 0.5) * height - t * 60;
      const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.7 : 1.3 - (t - 0.15) * 0.4;
      d.node.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      d.node.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
      d.node.style.left = '0';
      d.node.style.top = '0';
    }
  }
}
