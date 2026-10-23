import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';
import { useOpenDeskState, useUnreadCount } from '../react';
import { ChatIcon, CloseIcon } from './icons';
import { makeTheme } from './theme';

export interface OpenDeskLauncherProps {
  onPress: () => void;
  /** Shows the close icon instead of the chat bubble. */
  open?: boolean;
  accentColor?: string;
  accessibilityLabel?: string;
  /** Position it yourself, e.g. `{ position: 'absolute', right: 20, bottom: 20 }`. */
  style?: StyleProp<ViewStyle>;
}

/** The web widget's launcher button: brand colour, rounded square, unread badge. */
export function OpenDeskLauncher({ onPress, open = false, accentColor, accessibilityLabel, style }: OpenDeskLauncherProps) {
  const config = useOpenDeskState((state) => state.config);
  const unread = useUnreadCount();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = useMemo(() => makeTheme(config, config?.theme === 'light' || config?.theme === 'dark' ? config.theme : scheme, accentColor), [accentColor, config, scheme]);
  const radius = { square: 10, soft: 16, round: 27 }[config?.radius ?? 'soft'] ?? 16;
  const label = accessibilityLabel ?? (open ? 'Close chat' : unread > 0 ? `Open chat, ${unread} new` : 'Open chat');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.launcher, { backgroundColor: theme.accent, borderRadius: radius }, pressed && styles.pressed, style]}
    >
      {open ? <CloseIcon color={theme.accentFg} size={22} /> : <ChatIcon color={theme.accentFg} size={24} />}
      {!open && unread > 0 ? (
        <View style={[styles.badge, { backgroundColor: theme.danger, borderColor: theme.bg }]}>
          <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  launcher: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  pressed: { transform: [{ scale: 0.96 }] },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
});
