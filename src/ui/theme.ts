import { Platform } from 'react-native';
import type { WidgetConfig } from '../types';

/** Colour tokens from openDesk's web widget (`.root` and `.root[data-theme="dark"]`). */
export interface Palette {
  bg: string;
  bg2: string;
  bg3: string;
  line: string;
  line2: string;
  fg: string;
  fg2: string;
  fg3: string;
  fg4: string;
  ai: string;
  aiSoft: string;
  aiLine: string;
  danger: string;
  dangerSoft: string;
}

const light: Palette = {
  bg: '#ffffff',
  bg2: '#f4f4f5',
  bg3: '#fafafa',
  line: '#e7e7e9',
  line2: '#d6d6d9',
  fg: '#0a0a0a',
  fg2: '#525252',
  fg3: '#737373',
  fg4: '#a3a3a3',
  ai: '#6d4bd8',
  aiSoft: '#f4f0ff',
  aiLine: '#e4dcff',
  danger: '#dc2626',
  dangerSoft: '#fef2f2',
};

const dark: Palette = {
  bg: '#161616',
  bg2: '#242426',
  bg3: '#1c1c1d',
  line: '#2c2c2f',
  line2: '#3a3a3e',
  fg: '#fafafa',
  fg2: '#c4c4c6',
  fg3: '#8d8d92',
  fg4: '#5e5e63',
  ai: '#b9a3ff',
  aiSoft: '#231d33',
  aiLine: '#372d52',
  danger: '#f87171',
  dangerSoft: '#2a1515',
};

/** The widget's `radius` setting, in the same steps as the web widget. */
const radii = {
  square: { bubble: 6, ctl: 4, card: 4, bar: 4, av: 4 },
  soft: { bubble: 14, ctl: 8, card: 10, bar: 10, av: 6 },
  round: { bubble: 20, ctl: 999, card: 16, bar: 22, av: 999 },
} as const;

export interface ChatTheme extends Palette {
  accent: string;
  accentFg: string;
  headBg: string;
  radius: (typeof radii)[keyof typeof radii];
  mono: string;
}

export function makeTheme(config: WidgetConfig | null, scheme: 'light' | 'dark', accentOverride?: string): ChatTheme {
  const palette = scheme === 'dark' ? dark : light;
  const brand = normalizeHex(accentOverride ?? config?.brand_color ?? config?.brand?.color);
  const accent = brand ?? palette.fg;

  return {
    ...palette,
    accent,
    accentFg: brand ? readableOn(brand) : palette.bg,
    headBg: mix(accent, palette.bg3, 0.035),
    radius: radii[config?.radius ?? 'soft'] ?? radii.soft,
    mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' }),
  };
}

function normalizeHex(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const hex = value.trim().replace(/^#/, '');

  return /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? `#${hex}` : null;
}

function rgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h, 16);

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `color-mix(in srgb, a weight, b)`. */
function mix(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const channel = (x: number, y: number) => Math.round(x * weight + y * (1 - weight)).toString(16).padStart(2, '0');

  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/** White or near-black text, whichever reads better on the brand colour. */
function readableOn(hex: string): string {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  return luminance > 0.45 ? '#0a0a0a' : '#ffffff';
}
