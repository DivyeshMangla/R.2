import { CHARACTERS, WEAPONS, MAPS, getCharacter, getWeapon, getMap, type CharacterId, type MapId, type WeaponId, type LobbySelection, type MapBiome } from '@robot-arena/shared';
import './lobby.css';

const KEY = 'robot-arena.lobby.v1';
const ATLAS = '/assets/atlas/world-atlas.png';
const BIOME_ICONS: Record<MapBiome, string> = { volcanic: '♜', urban: '⌘', forest: '♧', desert: '☀', arctic: '❄', ancient: '◈' };

/** An illustrated world atlas; entering a realm is an explicit multiplayer join. */
export class Lobby {
  onDeploy: ((selection: LobbySelection) => void) | null = null;
  private readonly root = document.createElement('main');
  private readonly name: HTMLInputElement;
  private readonly deploy: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly preview: HTMLElement;
  private characterId: CharacterId = 'striker';
  private mapId: MapId = 'foundry';
  private weaponId: WeaponId = 'pulse';
  private busy = false;
  private reconnect = false;

  constructor() {
    let saved: Partial<LobbySelection> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LobbySelection>; } catch { /* Defaults also work with storage disabled. */ }
    this.characterId = getCharacter(saved?.characterId).id;
    this.mapId = getMap(saved?.mapId).id;
    this.weaponId = getWeapon(saved?.weaponId ?? getCharacter(this.characterId).starterWeapon).id;
    this.root.className = 'garage atlas-lobby';
    this.root.innerHTML = `
      <header class="atlas-header">
        <a class="atlas-brand" href="/" aria-label="Robot Expeditions home"><span class="atlas-brand-symbol">✣</span><span>ROBOT<span class="brand-serif">expeditions</span></span></a>
        <span class="atlas-header-title">THE WORLD ATLAS</span>
        <div class="atlas-edition"><i></i> SIX REALMS. ENDLESS RIVALRIES.<span>VOL. 01 / THE FRACTURED ISLES</span></div>
      </header>
      <div class="atlas-intro"><div><p class="atlas-kicker">A WORLD WORTH FIGHTING FOR</p><h1>Choose a realm.<br><em>Leave your mark.</em></h1></div><p>From frozen strongholds to forgotten forests.<br>A different battlefield. A machine made to belong.</p><div class="atlas-intro-mark">06<span>EXPLORE THE REALMS</span></div></div>
      <div class="atlas-layout">
        <section class="atlas-world" aria-label="World map selection">
          <div class="world-frame">
            <img class="world-illustration" src="${ATLAS}" width="1536" height="1024" alt="An illustrated island with a volcanic citadel, icy mountains, forest, desert, ancient ruins, and a futuristic harbor" fetchpriority="high">
            <div class="world-topline"><span>THE FRACTURED ISLES</span><span>SELECT YOUR BATTLEFIELD</span></div>
            <svg class="atlas-routes" viewBox="0 0 100 66.667" preserveAspectRatio="none" aria-hidden="true"><path d="M30 14.7Q48 5 74 13.3T68 28Q49 31 27 29.3T31 45.3Q53 55 76 46"/></svg>
            ${MAPS.map((m, i) => `<button type="button" class="atlas-pin pin-${m.biome}" data-map="${m.id}" aria-label="Select ${m.name}" style="left:${m.atlas.x}%;top:${m.atlas.y}%;--pin-color:#${m.palette.accent.toString(16).padStart(6, '0')}"><span class="pin-symbol">${BIOME_ICONS[m.biome]}</span><span class="pin-label"><small>${String(i + 1).padStart(2, '0')}</small>${m.name}</span></button>`).join('')}
            <div class="atlas-compass" aria-hidden="true"><span>N</span>✥</div>
            <div class="world-footline"><span>⌖ <strong class="world-current-name"></strong></span><span>6 COMBATANTS / WEAPON PICKUPS</span></div>
          </div>
          <div class="realm-section-label"><span>EXPLORE THE REALMS</span><span>ALL SIX BATTLEFIELDS ARE PLAYABLE <i>↘</i></span></div>
          <div class="realm-index">${MAPS.map((m, i) => `<button type="button" class="realm-card" data-map="${m.id}" style="--realm-color:#${m.palette.accent.toString(16).padStart(6, '0')}"><span class="realm-number">${String(i + 1).padStart(2, '0')}</span><span class="realm-card-icon">${BIOME_ICONS[m.biome]}</span><span><strong>${m.name}</strong><small>${m.biome} / ${m.difficulty}</small></span><span class="realm-card-arrow">↗</span></button>`).join('')}</div>
          <div class="atlas-field-note"><span>FIELD NOTE / 001</span><p>Every realm has its own terrain, atmosphere, and machine finish.<br>Find weapon shrines in the field. Press <kbd>E</kbd> to claim a new role.</p><span class="field-note-symbol">✧</span></div>
        </section>
        <aside class="expedition-sheet" aria-label="Character and loadout selection">
          <div class="sheet-heading"><span>YOUR NEXT EXPEDITION</span><span class="sheet-seal">✣</span></div>
          <div class="realm-heading"><span class="selected-biome"></span><h2 class="selected-realm-name"></h2><p class="selected-realm-description"></p></div>
          <div class="expedition-machine"><div class="machine-ground"></div><div class="machine-preview"></div><div class="machine-caption"><span class="machine-model"></span><span class="machine-finish"></span></div></div>
          <div class="sheet-section machine-section"><div class="sheet-section-title"><h3><span>01</span> YOUR MACHINE</h3><span>3 CLASSES</span></div><div class="atlas-character-options">${CHARACTERS.map((c) => `<button type="button" class="atlas-character" data-character="${c.id}"><span>${c.id === 'striker' ? '➤' : c.id === 'bulwark' ? '⛨' : '⌖'}</span><strong>${c.name}</strong><small>${c.role}</small></button>`).join('')}</div><p class="selected-character-description"></p></div>
          <div class="sheet-section gear-section"><div class="sheet-section-title"><h3><span>02</span> STARTER WEAPON</h3><span>SWAP IN THE FIELD</span></div><div class="atlas-weapon-options">${WEAPONS.map((w) => `<button type="button" class="atlas-weapon" data-weapon="${w.id}"><span>${({ pulse: '◈', scatter: '⋮', rail: '⟶', repeater: '»' })[w.id]}</span><span><strong>${w.name}</strong><small>${w.role}</small></span></button>`).join('')}</div><p class="selected-weapon-description"></p></div>
          <label class="atlas-callsign"><span><b>03</b> YOUR CALLSIGN</span><input aria-label="Your callsign" placeholder="What should we call you?" maxlength="16" autocomplete="nickname"></label>
          <div class="expedition-deploy"><button type="button" class="deploy-button">ENTER THE REALM <span>↗</span></button><p class="atlas-status" role="status" aria-live="polite">Your expedition begins when you're ready.</p></div>
        </aside>
      </div>
      <footer class="atlas-footer"><span>ROBOT EXPEDITIONS <i>©</i> WORLD ATLAS / 01</span><span><kbd>WASD</kbd> DRIVE <b>·</b> MOUSE AIM <b>·</b> <kbd>E</kbd> CLAIM A WEAPON</span><span>CHOOSE WELL. EXPLORE BOLDLY.</span></footer>`;
    document.body.appendChild(this.root);
    this.name = this.root.querySelector('input')!;
    this.name.value = new URLSearchParams(location.search).get('name')?.slice(0, 16) ?? (typeof saved?.name === 'string' ? saved.name.slice(0, 16) : '');
    this.deploy = this.root.querySelector('.deploy-button')!;
    this.status = this.root.querySelector('.atlas-status')!;
    this.preview = this.root.querySelector('.machine-preview')!;
    this.root.querySelectorAll<HTMLButtonElement>('[data-character]').forEach((button) => button.addEventListener('click', () => {
      if (this.busy) return;
      this.characterId = getCharacter(button.dataset.character).id;
      this.weaponId = getCharacter(this.characterId).starterWeapon;
      this.refresh();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((button) => button.addEventListener('click', () => {
      if (!this.busy) { this.mapId = getMap(button.dataset.map).id; this.refresh(); }
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-weapon]').forEach((button) => button.addEventListener('click', () => {
      if (!this.busy) { this.weaponId = getWeapon(button.dataset.weapon).id; this.refresh(); }
    }));
    const submit = (): void => {
      if (this.busy) return;
      const selection: LobbySelection = { name: this.name.value.trim().slice(0, 16), characterId: this.characterId, mapId: this.mapId, weaponId: this.weaponId };
      try { localStorage.setItem(KEY, JSON.stringify(selection)); } catch { /* Preference persistence is optional. */ }
      this.onDeploy?.(selection);
    };
    this.deploy.addEventListener('click', submit);
    this.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    this.refresh();
  }

  private refresh(): void {
    const character = getCharacter(this.characterId);
    const weapon = getWeapon(this.weaponId);
    const map = getMap(this.mapId);
    const p = map.palette;
    this.root.dataset.biome = map.biome;
    this.root.style.setProperty('--realm-accent', `#${p.accent.toString(16).padStart(6, '0')}`);
    this.root.style.setProperty('--realm-ground', `#${p.ground.toString(16).padStart(6, '0')}`);
    this.root.style.setProperty('--realm-robot', `#${p.robotPaint.toString(16).padStart(6, '0')}`);
    for (const [key, value] of [['character', this.characterId], ['map', this.mapId], ['weapon', this.weaponId]]) {
      this.root.querySelectorAll<HTMLButtonElement>(`[data-${key}]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === value)));
    }
    this.root.querySelector('.selected-biome')!.textContent = `${BIOME_ICONS[map.biome]} ${map.biome.toUpperCase()} REALM / ${map.difficulty}`;
    this.root.querySelector('.selected-realm-name')!.textContent = map.name;
    this.root.querySelector('.world-current-name')!.textContent = map.name;
    this.root.querySelector('.selected-realm-description')!.textContent = map.description;
    this.root.querySelector('.selected-character-description')!.textContent = character.description;
    this.root.querySelector('.selected-weapon-description')!.textContent = weapon.description;
    this.root.querySelector('.machine-model')!.textContent = `${character.name} / ${character.role}`;
    this.root.querySelector('.machine-finish')!.textContent = map.robotFinish;
    this.preview.innerHTML = robotSVG(this.characterId, false, this.mapId);
    if (!this.busy && !this.reconnect) this.deploy.innerHTML = `ENTER ${map.name.toUpperCase()} <span>↗</span>`;
  }

  setBusy(busy: boolean, message = ''): void {
    this.busy = busy;
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach((node) => { node.disabled = busy; });
    this.deploy.innerHTML = busy ? 'PREPARING EXPEDITION <span class="deploy-spinner"></span>' : this.reconnect ? 'RETURN TO THE ATLAS <span>↗</span>' : `ENTER ${getMap(this.mapId).name.toUpperCase()} <span>↗</span>`;
    if (message) this.setStatus(message);
  }

  setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }

  showDisconnected(reason: string): void {
    this.reconnect = true;
    this.show();
    this.setBusy(false);
    this.setStatus(`${reason}. Return to the atlas to rejoin.`, true);
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
}

/** Lightweight vector portrait; the playable machines use corresponding 3D attachments. */
function robotSVG(id: CharacterId, compact = false, mapId: MapId = 'foundry'): string {
  const c = getCharacter(id);
  const map = getMap(mapId);
  const paint = `#${map.palette.robotPaint.toString(16).padStart(6, '0')}`;
  const accent = `#${map.palette.robotAccent.toString(16).padStart(6, '0')}`;
  const detail = biomeDetail(map.biome, accent);
  const armor = id === 'bulwark' ? '<path d="M96 179 75 227 111 245 143 198M278 181 307 225 275 247 244 202" fill="#3c4450" stroke="#9ba6b3" stroke-width="3"/><path d="M128 194 193 174 253 195 247 235 192 259 133 234Z" fill="url(#body-bulwark)" stroke="#b1b5b7" stroke-width="2"/><path d="M147 213 192 198 232 213 192 237Z" fill="#111b25"/><path d="M182 207v21m-10-11h40" stroke="#f9d593" stroke-width="4"/>' : id === 'spectre' ? '<path d="m102 175-20-42 37 27 9 38m141-23 22-43-5 49-27 19" fill="#51576a" stroke="#99a1b5" stroke-width="2"/><path d="m179 105-1-42m4 9 20-9" fill="none" stroke="#a9a6ce" stroke-width="4"/><circle cx="177" cy="60" r="5" fill="#d3b9ff"/>' : '<path d="m108 178-14-43 37 23 7 36m111-17 29-39-2 50-26 20" fill="#53616c" stroke="#a8c8cd" stroke-width="2"/><path d="m145 223 43 12 55-20" fill="none" stroke="#b0f9ff" stroke-width="5"/>';
  return `<svg class="robot-portrait${compact ? ' compact' : ''}" viewBox="0 0 380 300" role="img" aria-label="${c.name} robot"><defs><linearGradient id="body-${id}" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="${paint}"/><stop offset="1" stop-color="#26313d"/></linearGradient></defs><ellipse cx="193" cy="260" rx="124" ry="16" fill="#000" opacity=".4"/><g stroke-linejoin="round"><g fill="#10151d" stroke="#4f5a68" stroke-width="4"><path d="m67 197 24-14 32 17v46l-25 15-31-17Z"/><path d="m255 182 27-14 32 19v43l-28 18-31-18Z"/><path d="m83 153 24-11 31 16v37l-26 14-29-15Z"/></g><g stroke="#667280" stroke-width="4"><path d="m76 205 21 11v32m-22-29 20 10m170-26 20 11 22-13m-22 13v25m-196-78 22 11v27"/></g><path d="m102 161 96-39 92 49-13 55-84 36-91-43Z" fill="url(#body-${id})" stroke="#9fbbc5" stroke-width="2"/><path d="m102 161 91 48 97-38m-97 38v53" fill="none" stroke="#1a252e" stroke-width="3"/><path d="m119 158 78-29 74 40-78 30Z" fill="#53606b"/><path d="m142 144 52-20 54 29-9 36-47 20-48-26Z" fill="url(#body-${id})" stroke="#9bacba" stroke-width="2"/><path d="m143 144 49 27 56-18m-56 18v38" fill="none" stroke="#1c2632" stroke-width="3"/><path d="m182 128 15-7 14 8-14 7Z" fill="#131c24"/><path d="m211 151 54-27 13 7v13l-54 29-13-8Z" fill="#555f70" stroke="#a7afbc" stroke-width="2"/><path d="m265 124 13 7v13l-13-7Z" fill="${paint}"/><path d="m269 130 6 3v6l-6-3Z" fill="#0d1720"/>${id === 'spectre' ? '<path d="m274 130 51-26 7 4v7l-54 29Z" fill="#8995a9"/><path d="m325 104 7 4v7l-7-3Z" fill="#c8abff"/>' : ''}${armor}${detail}<path d="m113 199 16 8v9l-16-8m139-4 14-6v9l-14 6" fill="#d5ffff"/><path d="m153 180 17 9m59-15 10-4" stroke="${accent}" stroke-width="4"/><g fill="#b4bec7"><circle cx="111" cy="177" r="2"/><circle cx="274" cy="187" r="2"/><circle cx="142" cy="215" r="2"/><circle cx="233" cy="225" r="2"/></g></g></svg>`;
}


function biomeDetail(biome: MapBiome, accent: string): string {
  if (biome === 'forest') return `<path d="m112 180 25 20 47 21 60-26" fill="none" stroke="#477348" stroke-width="6"/><g fill="${accent}"><ellipse cx="129" cy="190" rx="8" ry="4" transform="rotate(35 129 190)"/><ellipse cx="162" cy="211" rx="8" ry="4"/><ellipse cx="224" cy="203" rx="8" ry="4" transform="rotate(-30 224 203)"/></g>`;
  if (biome === 'arctic') return `<path d="m103 165 26-7 18 26-20 13Zm147 22 21-20 18 9-14 26Z" fill="#edf9f4" stroke="#a5ccd0" stroke-width="2"/><path d="m148 211 38 18m23-15 24-9" stroke="${accent}" stroke-width="5"/>`;
  if (biome === 'desert') return '<path d="m130 182 59 27 48-22v18l-48 24-59-28Z" fill="#d8bd8d" stroke="#b3925b" stroke-width="2"/><path d="m146 195v18m17-11v18m17-9v15" stroke="#7f6846" stroke-width="3"/>';
  if (biome === 'ancient') return `<path d="m128 180 63 31 52-27m-105 11 53 27 42-22" fill="none" stroke="#c7ab65" stroke-width="4"/><circle cx="192" cy="176" r="10" fill="#5b765c" stroke="${accent}" stroke-width="3"/><path d="m187 176 5-6 5 6-5 6Z" fill="${accent}"/>`;
  if (biome === 'volcanic') return `<path d="m111 174 25 12-3 22-24-13Zm145 14 20-12-3 22-19 11Z" fill="#3a3430" stroke="#846b54" stroke-width="2"/><path d="m116 182 13 7m-14 1 13 7m132-6 9-6m-10 13 9-6" stroke="${accent}" stroke-width="3"/>`;
  return `<path d="m133 182 53 28m22-8 31-15" stroke="${accent}" stroke-width="5"/><path d="m152 137-5-29m87 33 9-29" stroke="#9baeb6" stroke-width="3"/><circle cx="147" cy="107" r="4" fill="${accent}"/>`;
}
