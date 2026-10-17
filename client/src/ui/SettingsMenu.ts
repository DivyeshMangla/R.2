import { QUALITY_ORDER, settingsForPreset, TOGGLE_LABELS, type GraphicsSettings, type QualityName, type ToggleKey } from '../render/Quality';

export interface SettingsMenuHooks {
  getSettings(): GraphicsSettings;
  onSettings(s: GraphicsSettings): void;
  getSensitivity(): number;
  onSensitivity(v: number): void;
  getVolume(): number;
  onVolume(v: number): void;
  onResume(): void;
}

/**
 * Pause/settings overlay. Opens when the pointer lock is lost (Esc) and offers
 * the graphics preset, every per-feature toggle, mouse sensitivity and volume.
 * Changing a toggle marks the preset as custom; picking a preset resets them.
 */
export class SettingsMenu {
  private readonly root: HTMLDivElement;
  private readonly preset: HTMLSelectElement;
  private readonly toggles = new Map<ToggleKey, HTMLInputElement>();
  private readonly sens: HTMLInputElement;
  private readonly vol: HTMLInputElement;
  private readonly hooks: SettingsMenuHooks;
  private open = false;

  constructor(hooks: SettingsMenuHooks) {
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.className = 'overlay hidden';
    const box = document.createElement('div');
    box.className = 'settings panel';
    this.root.appendChild(box);
    box.addEventListener('click', (e) => e.stopPropagation());
    this.root.addEventListener('click', () => this.resume());

    const h = document.createElement('h2');
    h.textContent = 'PAUSED — SETTINGS';
    box.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'grid';
    box.appendChild(grid);
    const section = (text: string): void => {
      const s = document.createElement('div');
      s.className = 'section';
      s.textContent = text;
      grid.appendChild(s);
    };
    const row = (label: string, control: HTMLElement): void => {
      const l = document.createElement('label');
      l.textContent = label;
      grid.append(l, control);
    };

    section('GRAPHICS');
    this.preset = document.createElement('select');
    for (const q of QUALITY_ORDER) {
      const o = document.createElement('option');
      o.value = q;
      o.textContent = q;
      this.preset.appendChild(o);
    }
    this.preset.addEventListener('change', () => {
      hooks.onSettings(settingsForPreset(this.preset.value as QualityName));
      this.sync();
    });
    row('Preset', this.preset);
    for (const key of Object.keys(TOGGLE_LABELS) as ToggleKey[]) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        const s = { ...hooks.getSettings() };
        s[key] = cb.checked;
        hooks.onSettings(s);
      });
      this.toggles.set(key, cb);
      row(TOGGLE_LABELS[key], cb);
    }

    section('CONTROLS & AUDIO');
    this.sens = document.createElement('input');
    this.sens.type = 'range';
    this.sens.min = '0.0006';
    this.sens.max = '0.006';
    this.sens.step = '0.0001';
    this.sens.addEventListener('input', () => hooks.onSensitivity(Number(this.sens.value)));
    row('Mouse sensitivity', this.sens);
    this.vol = document.createElement('input');
    this.vol.type = 'range';
    this.vol.min = '0';
    this.vol.max = '1';
    this.vol.step = '0.01';
    this.vol.addEventListener('input', () => hooks.onVolume(Number(this.vol.value)));
    row('Volume', this.vol);

    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const resume = document.createElement('button');
    resume.textContent = 'RESUME';
    resume.addEventListener('click', () => this.resume());
    buttons.appendChild(resume);
    box.appendChild(buttons);
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.sync();
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
  }

  private resume(): void {
    this.hide();
    this.hooks.onResume();
  }

  private sync(): void {
    const s = this.hooks.getSettings();
    this.preset.value = s.preset;
    for (const [key, cb] of this.toggles) cb.checked = s[key];
    this.sens.value = String(this.hooks.getSensitivity());
    this.vol.value = String(this.hooks.getVolume());
  }
}
