import { View, type ViewStyle } from 'react-native';

/**
 * The widget's line icons drawn with plain Views, so the SDK needs no react-native-svg.
 * Each fits a square of `size` with 1.6px strokes, like the web widget's 1.6 stroke SVGs.
 */
interface IconProps {
  color: string;
  size?: number;
}

const stroke = 1.6;

function Box({ size, children }: { size: number; children: React.ReactNode }) {
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>{children}</View>;
}

function Line({ length, color, style }: { length: number; color: string; style?: ViewStyle }) {
  return (
    <View
      style={[{ position: 'absolute', width: length, height: stroke, borderRadius: stroke, backgroundColor: color }, style]}
    />
  );
}

export function CloseIcon({ color, size = 16 }: IconProps) {
  const length = size * 0.78;

  return (
    <Box size={size}>
      <Line length={length} color={color} style={{ transform: [{ rotate: '45deg' }] }} />
      <Line length={length} color={color} style={{ transform: [{ rotate: '-45deg' }] }} />
    </Box>
  );
}

/** A chevron; `direction` is where it points. */
export function ChevronIcon({ color, size = 16, direction = 'left' }: IconProps & { direction?: 'left' | 'right' }) {
  const arm = size * 0.42;

  return (
    <Box size={size}>
      <View
        style={{
          width: arm,
          height: arm,
          borderLeftWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          borderBottomLeftRadius: 1,
          transform: [{ translateX: direction === 'left' ? arm * 0.2 : -arm * 0.2 }, { rotate: direction === 'left' ? '45deg' : '-135deg' }],
        }}
      />
    </Box>
  );
}

/** An arrow; `angle` is the clockwise rotation from pointing right. */
export function ArrowIcon({ color, size = 16, angle = 0 }: IconProps & { angle?: number }) {
  const shaft = size * 0.7;
  const head = size * 0.36;

  return (
    <Box size={size}>
      <View style={{ width: shaft, height: shaft, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: `${angle}deg` }] }}>
        <Line length={shaft} color={color} />
        <View
          style={{
            position: 'absolute',
            right: stroke / 2,
            width: head,
            height: head,
            borderTopWidth: stroke,
            borderRightWidth: stroke,
            borderColor: color,
            borderTopRightRadius: 1,
            transform: [{ rotate: '45deg' }],
          }}
        />
      </View>
    </Box>
  );
}

export function PaperclipIcon({ color, size = 16 }: IconProps) {
  const width = size * 0.42;
  const height = size * 0.86;

  return (
    <Box size={size}>
      <View style={{ transform: [{ rotate: '40deg' }] }}>
        <View
          style={{ width, height, borderWidth: stroke, borderColor: color, borderRadius: width / 2, borderBottomColor: color }}
        />
        <View
          style={{
            position: 'absolute',
            left: width / 2 - stroke / 2,
            top: height * 0.22,
            width: stroke,
            height: height * 0.5,
            borderRadius: stroke,
            backgroundColor: color,
          }}
        />
      </View>
    </Box>
  );
}

/** A speech bubble, used on the launcher. */
export function ChatIcon({ color, size = 22 }: IconProps) {
  const width = size * 0.86;
  const height = size * 0.66;

  return (
    <Box size={size}>
      <View style={{ width, height, borderWidth: 2, borderColor: color, borderRadius: height * 0.38 }} />
      <View
        style={{
          position: 'absolute',
          left: size * 0.2,
          bottom: size * 0.06,
          width: size * 0.22,
          height: size * 0.22,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          borderBottomLeftRadius: 2,
          transform: [{ skewY: '-20deg' }],
        }}
      />
    </Box>
  );
}

export function PersonIcon({ color, size = 16 }: IconProps) {
  return (
    <Box size={size}>
      <View style={{ width: size * 0.38, height: size * 0.38, borderRadius: size, borderWidth: stroke, borderColor: color, marginBottom: 1 }} />
      <View
        style={{
          width: size * 0.66,
          height: size * 0.3,
          borderTopLeftRadius: size,
          borderTopRightRadius: size,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderColor: color,
        }}
      />
    </Box>
  );
}

export function SparkIcon({ color, size = 10 }: IconProps) {
  return (
    <Box size={size}>
      <View style={{ width: size * 0.5, height: size * 0.5, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '45deg' }] }} />
    </Box>
  );
}
