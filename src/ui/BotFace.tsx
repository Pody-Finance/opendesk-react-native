import { Image, Text, View, type ViewStyle } from 'react-native';
import type { BotLook } from '../types';

/** The widget's default bot when none is configured: a violet blob with pill eyes. */
export const defaultBotLook: BotLook = {
  kind: 'built',
  shape: 'blob',
  fill: { type: 'gradient', color: '#c9bcff', to: '#4a2bc4' },
  eyes: 'pills',
  mouth: 'none',
};

/**
 * The bot avatar the web widget draws from its `look` settings: an uploaded image, an emoji,
 * or a built face. The face is laid out on the widget's 64-unit grid (body from 7 to 57) with
 * plain Views, so it needs no SVG library.
 */
export function BotFace({ size, look, avatarUrl }: { size: number; look?: BotLook | null; avatarUrl?: string | null }) {
  const resolved = look ?? defaultBotLook;
  const u = size / 64;

  if (avatarUrl && (resolved.kind === 'image' || !look)) {
    return <Image source={{ uri: avatarUrl }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }

  const body = 50 * u;
  const radius = { circle: body / 2, blob: body / 2, cloud: body * 0.42, squircle: body * 0.38, rounded: body * 0.28, hexagon: body * 0.3 }[
    resolved.shape ?? 'blob'
  ] ?? body / 2;
  const top = resolved.fill?.color ?? '#c9bcff';
  const bottom = resolved.fill?.type === 'gradient' ? (resolved.fill.to ?? top) : top;

  if (resolved.kind === 'emoji' && resolved.emoji) {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: size * 0.72, lineHeight: size }}>{resolved.emoji}</Text>
      </View>
    );
  }

  const at = (x: number, y: number, w: number, h: number): ViewStyle => ({
    position: 'absolute',
    left: x * u,
    top: y * u,
    width: w * u,
    height: h * u,
  });

  return (
    <View style={{ width: size, height: size }}>
      <View style={[at(7, 7, 50, 50), { borderRadius: radius, overflow: 'hidden', backgroundColor: bottom }]}>
        {top === bottom
          ? null
          : BANDS.map((index) => (
              <View
                key={index}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: `${(index * 100) / BANDS.length}%`,
                  height: `${100 / BANDS.length + 1}%`,
                  backgroundColor: mixHex(top, bottom, index / (BANDS.length - 1)),
                }}
              />
            ))}
      </View>
      <View style={[at(15.5, 12.8, 13, 7), { borderRadius: 4 * u, backgroundColor: '#ffffff', opacity: 0.38, transform: [{ rotate: '-24deg' }] }]} />
      <Eyes kind={resolved.eyes ?? 'pills'} at={at} u={u} />
      <Mouth kind={resolved.mouth ?? 'none'} at={at} u={u} />
    </View>
  );
}

type At = (x: number, y: number, w: number, h: number) => ViewStyle;

/** Enough horizontal bands that a two-stop gradient reads smooth at avatar sizes, without an SVG library. */
const BANDS = Array.from({ length: 24 }, (_, index) => index);

/** Interpolates two hex colours; `amount` 0 is `from`, 1 is `to`. */
function mixHex(from: string, to: string, amount: number): string {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);

    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(from);
  const b = parse(to);

  return `#${a.map((channel, i) => Math.round(channel + (b[i]! - channel) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function Eyes({ kind, at, u }: { kind: string; at: At; u: number }) {
  const eye = (style: ViewStyle) => <View style={[style, { backgroundColor: '#ffffff' }]} />;

  switch (kind) {
    case 'dots':
      return (
        <>
          {eye({ ...at(20.6, 26.6, 6.8, 6.8), borderRadius: 3.4 * u })}
          {eye({ ...at(36.6, 26.6, 6.8, 6.8), borderRadius: 3.4 * u })}
        </>
      );
    case 'ovals':
    case 'glasses':
    case 'sparkle':
    case 'star':
      return (
        <>
          {eye({ ...at(21.3, 25.9, 5.4, 8.2), borderRadius: 2.7 * u })}
          {eye({ ...at(37.3, 25.9, 5.4, 8.2), borderRadius: 2.7 * u })}
        </>
      );
    case 'happy':
    case 'sleepy':
    case 'wink':
      return (
        <>
          {eye({ ...at(19.5, 27, 9, 5), borderTopLeftRadius: 4.5 * u, borderTopRightRadius: 4.5 * u })}
          {eye({ ...at(35.5, 27, 9, 5), borderTopLeftRadius: 4.5 * u, borderTopRightRadius: 4.5 * u })}
        </>
      );
    default:
      return (
        <>
          {eye({ ...at(24.4, 28.35, 4.4, 7.3), borderRadius: 2.2 * u })}
          {eye({ ...at(35.2, 28.35, 4.4, 7.3), borderRadius: 2.2 * u })}
        </>
      );
  }
}

function Mouth({ kind, at, u }: { kind: string; at: At; u: number }) {
  switch (kind) {
    case 'smile':
    case 'cat':
      return (
        <View
          style={[
            at(26.4, 37.6, 11.2, 6.2),
            { borderBottomWidth: 1.6 * u, borderColor: '#ffffff', borderBottomLeftRadius: 6 * u, borderBottomRightRadius: 6 * u },
          ]}
        />
      );
    case 'grin':
    case 'tongue':
      return (
        <View
          style={[at(25.4, 38.4, 13.2, 8.2), { backgroundColor: '#ffffff', borderBottomLeftRadius: 6.6 * u, borderBottomRightRadius: 6.6 * u }]}
        />
      );
    case 'open':
      return <View style={[at(28.7, 38.1, 6.6, 7.8), { backgroundColor: '#ffffff', borderRadius: 3.3 * u }]} />;
    case 'flat':
    case 'tiny':
    case 'smirk':
      return <View style={[at(28, 41, 8, 1.6), { backgroundColor: '#ffffff', borderRadius: 0.8 * u }]} />;
    default:
      return null;
  }
}
