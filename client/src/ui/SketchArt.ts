import { getArenaDefinition, getCharacter, getMap, getWeapon, rotateVec, type ArenaBlock, type CharacterId, type MapId } from '@robot-arena/shared';

export const inkIcons = {
  garage: '<path d="M4 11 16 3l12 8v18H4Zm5 18V15h14v14M9 20h14M9 25h14"/>',
  maps: '<path d="m3 7 8-3 10 4 8-3v22l-8 3-10-4-8 3Zm8-3v22M21 8v22M6 16l3-3m6 3 3 3m6-6 3-2"/>',
  robots: '<path d="M8 9h16v17H8ZM16 3v6M12 3h8M3 14h5m16 0h5M3 14v8m26-8v8M11 29v-3m10 3v-3"/><path d="M12 14v3m8-3v3m-8 5h8"/>',
  guide: '<path d="M5 5h22v25H5Zm5 7h3m5 0h5M10 18h13M10 24h8M2 8h3M2 15h3M2 22h3"/>',
  close: '<path d="m8 8 16 16M24 8 8 24"/>',
};

export function sketchIcon(name: keyof typeof inkIcons): string {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="round">${inkIcons[name]}</svg>`;
}

export function hex(color: number): string { return `#${color.toString(16).padStart(6, '0')}`; }

function mix(a: number, b: number, weight: number): string {
  const channel = (shift: number): number => Math.round(((a >> shift) & 255) * (1 - weight) + ((b >> shift) & 255) * weight);
  return hex((channel(16) << 16) | (channel(8) << 8) | channel(0));
}

/** Hand-authored, unarmed character art: flat ink, construction lines and crosshatching. */
export function robotSketch(id: CharacterId, mapId: MapId, key = 'hero'): string {
  const character = getCharacter(id), map = getMap(mapId), p = map.palette;
  const paint = mix(p.robotPaint, 0xdcb07a, 0.22), light = mix(p.robotPaint, 0xffe8a9, 0.48), dark = mix(p.robotPaint, 0x1b1927, 0.4);
  const accent = hex(p.robotAccent);
  const fittings = id === 'bulwark'
    ? `<path d="m162 269-32 34 18 55 53-8 23-50m236-16 48-5 24 40-25 49-40-19" fill="${dark}"/><path d="m208 309 106 42 122-43-6 56-112 50-105-48Z" fill="${paint}"/><path d="m288 349 28-5 27 17-27 26-27-17Z" fill="${light}"/>`
    : id === 'spectre'
      ? `<path d="m230 228-18-65 38 18 23 70m171-4 39-53 5 72-35 25" fill="${dark}"/><path d="m324 175-8-95 40-16m-40 25 29-5" fill="none" stroke="#d1c9a9" stroke-width="7"/><circle cx="354" cy="65" r="10" fill="${accent}"/><path d="m311 180 32-9 27 15-28 13Z" fill="#393d49"/>`
      : `<path d="m199 254-32-66 62 25 28 71m174-29 55-57 4 82-32 24" fill="${paint}"/><path d="m179 313 125 52 130-39-128 59-129-54" fill="${accent}"/>`;
  const biome = map.biome === 'forest'
    ? `<path d="m213 282 53 26 47 9 76-20" fill="none" stroke="#415b38" stroke-width="7"/><g fill="#a8bc6c"><path d="m245 299-20-20 29 7Zm53 15-17-21 26 8m47-3 13-20 8 17"/></g>`
    : map.biome === 'arctic'
      ? '<path d="m195 262 42-13 34 31-45 20Zm218 19 29-25 39 20-35 32Z" fill="#e1e8d8"/><path d="m247 333 58 24m30-7 48-19" stroke="#8cdce0" stroke-width="8"/>'
      : map.biome === 'desert'
        ? '<path d="m224 274 93 39 83-35 1 24-83 35-93-39Z" fill="#d8b77e"/><path d="m248 288 1 20m24-10 1 20m24-11 1 20" stroke="#6c5944" stroke-width="3"/>'
        : map.biome === 'ancient'
          ? `<path d="m230 278 83 35 85-31m-156 14 73 29 72-29" fill="none" stroke="${accent}" stroke-width="5"/><circle cx="314" cy="273" r="17" fill="#607c62"/><path d="m309 268 10 10m-10 0 10-10" stroke="${accent}"/>`
          : `<path d="m226 274 21 9m-18 0 21 9m143-13 19-8m-16 18 19-8" stroke="${accent}" stroke-width="6"/>`;
  return `<svg class="sketch-robot" viewBox="0 0 680 480" role="img" aria-label="Unarmed ${character.name}, ${map.robotFinish}">
    <defs><pattern id="hatch-${key}" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><path d="M0 0v9" stroke="#151321" stroke-width="1.5" opacity=".4"/></pattern><pattern id="dots-${key}" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#f6e1ad" opacity=".2"/></pattern><filter id="ink-${key}" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".025" numOctaves="2" seed="4" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.2" xChannelSelector="R" yChannelSelector="G"/></filter></defs>
    <ellipse cx="332" cy="421" rx="219" ry="27" fill="#111321" opacity=".35"/>
    <g filter="url(#ink-${key})" stroke="#171824" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
      <g fill="#28313a"><path d="m144 283 49-26 54 34 3 72-53 35-55-35Z"/><path d="m424 284 51-30 58 34 2 72-55 39-56-34Z"/><path d="m199 228 39-19 38 25 2 55-39 25-39-27Z"/><path d="m421 238 42-24 40 28-1 52-40 30-42-28Z"/></g>
      <g stroke="#77818a" stroke-width="4"><path d="m156 299 38 23 43-26m-80 18 36 23 43-25m-79 23 35 23 44-26m-78 22 34 23 44-26m-40-29v63m239-65 42 24 46-27m-89 20 42 25 47-27m-88 20 41 25 46-28m-87 20 40 26 47-30m-47-31v65"/></g>
      <path d="m177 277 140-66 177 73-17 82-160 62-145-75Z" fill="${paint}"/>
      <path d="m177 277 141 66 176-59-177-73Z" fill="${light}"/>
      <path d="m318 343-1 85 160-62 17-82Z" fill="${dark}"/>
      <path d="m177 277 141 66-1 85-145-75Z" fill="url(#hatch-${key})" opacity=".38"/>
      <path d="m213 227 108-54 144 58-21 62-122 46-111-57Z" fill="${paint}"/>
      <path d="m213 227 109 47 143-43-144-58Z" fill="${light}"/>
      <path d="m322 274 122-43-21 62-101 46Z" fill="${dark}"/>
      <path d="m264 222 54-23 62 24-58 23Z" fill="#55525a"/><path d="m284 221 34-13 36 15-32 12Z" fill="#9c9b8f"/>
      <path d="m216 233 104 44v58l-109-53Z" fill="url(#dots-${key})"/>
      ${fittings}${biome}
      <path d="m204 300 40 18v38l-40-16Zm186 22 43-16-2 35-42 17Z" fill="#5c6770"/>
      <ellipse cx="225" cy="328" rx="14" ry="19" fill="#e4d9a6"/><ellipse cx="410" cy="330" rx="15" ry="19" fill="#e4d9a6"/>
      <path d="m216 329 17 7m170-6 16-6" stroke="#ffffc4" stroke-width="5"/>
      <path d="m258 342 55 21 47-17-1 25-46 20-55-22Z" fill="#262e38"/><path d="m269 356 43 17 36-14" fill="none" stroke="#a9aaa0" stroke-width="5"/>
      <path d="m252 284 47 20-1 30-47-21Z" fill="${light}" stroke-width="3"/><path d="m267 298 16 6m-15 3 16 6" stroke="#f5edcf" stroke-width="4"/>
      <path d="m371 354 45-17-2 46-44 17Z" fill="${light}"/><path d="m383 358 17-6-1 23-18 7m10-26-1 23" stroke="#f4e7b7" stroke-width="5"/>
      <g fill="#bbb9a0" stroke-width="2"><circle cx="190" cy="300" r="4"/><circle cx="186" cy="343" r="4"/><circle cx="455" cy="300" r="4"/><circle cx="449" cy="350" r="4"/><circle cx="227" cy="239" r="3"/><circle cx="425" cy="249" r="3"/></g>
      <path d="m237 260 34 13m-21-4 7 5m90-37 24-7m-6 11 20-6M284 395l14 6m34-8 14-6" stroke="#eee0be" stroke-width="2" opacity=".65"/>
    </g><g fill="none" stroke="#d2cbaa" stroke-width="1" opacity=".4"><path d="m138 415 95 4m212-10 83-3M270 446h111m-43-17v30m-6-9h12"/></g>
  </svg>`;
}

type Point = { x: number; y: number };
function project(x: number, y: number, z: number): Point { return { x: 240 + (x - z), y: 146 + (x + z) * 0.45 - y * 3 }; }
function points(p: readonly Point[]): string { return p.map((v) => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' '); }

function blockSketch(block: ArenaBlock, fill: string, key: string): string {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => {
    const top = rotateVec(block.rotation, { x: x * block.half.x, y: block.half.y, z: z * block.half.z });
    const bottom = rotateVec(block.rotation, { x: x * block.half.x, y: -block.half.y, z: z * block.half.z });
    return { top: project(top.x + block.center.x, top.y + block.center.y, top.z + block.center.z), bottom: project(bottom.x + block.center.x, bottom.y + block.center.y, bottom.z + block.center.z) };
  });
  const top = points(corners.map((p) => p.top));
  return `<g stroke="#26282c" stroke-width=".8" stroke-linejoin="round"><polygon points="${points([corners[1].top, corners[2].top, corners[2].bottom, corners[1].bottom])}" fill="${fill}"/><polygon points="${points([corners[2].top, corners[3].top, corners[3].bottom, corners[2].bottom])}" fill="#726c5b"/><polygon points="${top}" fill="${fill}"/><polygon points="${top}" fill="url(#map-hatch-${key})" opacity=".32"/></g>`;
}

/** Isometric field drawings are generated from the real collision layout, not a painted backdrop. */
export function mapSketch(mapId: MapId, key: string): string {
  const map = getMap(mapId), definition = getArenaDefinition(mapId), p = map.palette;
  const ground = mix(p.ground, 0xd4c5a0, 0.24), stone = mix(p.stone, 0xdccba2, 0.25);
  const h = map.arenaSize / 2;
  const floor = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => project(x, 0, z));
  const cliff = points([floor[1], floor[2], floor[3], { x: floor[3].x, y: floor[3].y + 18 }, { x: floor[2].x, y: floor[2].y + 20 }, { x: floor[1].x, y: floor[1].y + 18 }]);
  const blocks = definition.blocks.filter((b) => b.kind !== 'floor').slice().sort((a, b) => a.center.x + a.center.z - b.center.x - b.center.z);
  return `<svg class="sketch-map" viewBox="0 0 480 285" role="img" aria-label="Field sketch of ${map.name}, ${map.arenaSize} meter arena"><defs><pattern id="map-hatch-${key}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(27)"><path d="M0 0v6" stroke="#343035" stroke-width=".8"/></pattern><pattern id="map-grid-${key}" width="20" height="10" patternUnits="userSpaceOnUse"><path d="M0 0 20 10M20 0 0 10" stroke="#f4e4be" stroke-width=".3" opacity=".5"/></pattern></defs><ellipse cx="240" cy="250" rx="174" ry="12" fill="#151623" opacity=".18"/><polygon points="${cliff}" fill="${mix(p.stone, 0x272532, 0.3)}" stroke="#26282c" stroke-width="2"/><polygon points="${points(floor)}" fill="${ground}" stroke="#26282c" stroke-width="2.2"/><polygon points="${points(floor)}" fill="url(#map-grid-${key})"/>${blocks.map((b) => blockSketch(b, b.kind === 'pillar' && map.biome === 'forest' ? hex(p.foliage) : stone, key)).join('')}${definition.pickups.map((pad) => { const q = project(pad.position.x, 1, pad.position.z); return `<circle cx="${q.x}" cy="${q.y}" r="2.7" fill="${hex(getWeapon(pad.weaponId).color)}" stroke="#282931" stroke-width=".8"/>`; }).join('')}<g stroke="#2c2c32" fill="none" stroke-width="1" opacity=".7"><path d="M37 225h42m-21-10v21m350-164h34m-17-16v33M201 267h78"/></g></svg>`;
}
