/**
 * Worker appearance V2 — named colour slots + explicit hat and body-variant types.
 * Replaces the old WorkerAppearance from @/components/Worker.
 */
import type { WorkerAppearance } from '@/components/Worker';

export type HatType =
  | 'none' // bare hair
  | 'cap' // small round cap
  | 'wide_brim' // current peasant straw hat
  | 'hood' // cloth hood
  | 'helmet_leather' // military rank-1 cap
  | 'helmet_steel' // military rank-2 metal helmet
  | 'crown'; // military rank-3 gold crown atop steel

export type BodyVariant = 'default' | 'dress';

export interface WorkerAppearanceV2 {
  skinColor: string;
  hairColor: string;
  shirtColor: string; // formerly "tunic"
  trouserColor: string; // formerly "pants"
  footColor: string; // formerly "boots"
  hatType: HatType;
  hatColor: string; // primary hat / helmet colour
  hatAccentColor?: string; // brim band, crown trim, visor notch, etc.
  bodyVariant: BodyVariant;
  /** When true, draw binoculars strapped to the chest (explorer specialist). */
  isExplorer?: boolean;
}

/** One-way migration helper from old WorkerAppearance to V2. */
export function migrateAppearance(old: WorkerAppearance): WorkerAppearanceV2 {
  let hatType: HatType = 'none';
  let bodyVariant: BodyVariant = 'default';

  if (old.variant === 'hat') {
    hatType = 'wide_brim';
  } else if (old.variant === 'dress') {
    bodyVariant = 'dress';
  }
  // 'default' and 'tunic2' both map to bodyVariant:'default', no hat

  return {
    skinColor: old.skin,
    hairColor: old.hair,
    shirtColor: old.tunic,
    trouserColor: old.pants,
    footColor: old.boots,
    hatType,
    hatColor: old.hair, // hat colour defaults to hair colour
    bodyVariant,
  };
}

/** Resolve a colour-slot name to its hex string from an appearance. */
export type AppearanceColorSlot = 'skin' | 'hair' | 'shirt' | 'trouser' | 'foot' | 'hat' | 'eye';

export function resolveColorSlot(slot: AppearanceColorSlot, a: WorkerAppearanceV2): string {
  switch (slot) {
    case 'skin':
      return a.skinColor;
    case 'hair':
      return a.hairColor;
    case 'shirt':
      return a.shirtColor;
    case 'trouser':
      return a.trouserColor;
    case 'foot':
      return a.footColor;
    case 'hat':
      return a.hatColor;
    case 'eye':
      return '#1a1008';
  }
}

/** Apply a hue-shift in degrees to all cloth colours (used for enemy tint). */
export function applyHueShift(a: WorkerAppearanceV2, deg: number): WorkerAppearanceV2 {
  if (deg === 0) return a;
  return {
    ...a,
    shirtColor: hueShiftHex(a.shirtColor, deg),
    trouserColor: hueShiftHex(a.trouserColor, deg),
    footColor: hueShiftHex(a.footColor, deg),
    hatColor: hueShiftHex(a.hatColor, deg),
  };
}

function hueShiftHex(hex: string, deg: number): string {
  const { r, g, b } = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb((h + deg / 360 + 1) % 1, s, l);
  return `rgb(${Math.round(nr)},${Math.round(ng)},${Math.round(nb)})`;
}

function parseHex(color: string): { r: number; g: number; b: number } {
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]! };
  const h = color.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}
