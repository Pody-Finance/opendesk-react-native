import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, LayoutAnimation, Platform, type KeyboardEvent, type View } from 'react-native';

/**
 * How far the keyboard covers the view in `ref`, for use as its bottom padding.
 *
 * KeyboardAvoidingView compares the keyboard with a layout relative to its parent, so it misses
 * anything above that parent (a header, a sheet), and on Android it relies on the window
 * shrinking, which edge-to-edge apps no longer do. This measures the view in window coordinates
 * instead and works the same on both platforms. Call `onLayout` from the view's `onLayout` so a
 * window that does shrink is measured again and the padding drops back.
 */
export function useKeyboardInset(ref: RefObject<View | null>, extraOffset = 0): { inset: number; onLayout: () => void } {
  const [inset, setInset] = useState(0);
  const keyboard = useRef<KeyboardEvent | null>(null);

  const measure = useCallback(() => {
    const event = keyboard.current;
    const view = ref.current;
    if (!event || !view) {
      setInset(0);

      return;
    }
    view.measureInWindow((_x, y, _width, height) => {
      if (keyboard.current !== event) {
        return;
      }
      const next = Math.max(0, Math.round(y + height - event.endCoordinates.screenY + extraOffset));
      setInset((current) => {
        if (current !== next) {
          animateWithKeyboard(event);
        }

        return next;
      });
    });
  }, [ref, extraOffset]);

  useEffect(() => {
    const show = (event: KeyboardEvent) => {
      keyboard.current = event;
      measure();
    };
    const hide = (event: KeyboardEvent) => {
      keyboard.current = null;
      animateWithKeyboard(event);
      setInset(0);
    };
    const subscriptions =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', show), Keyboard.addListener('keyboardWillHide', hide)]
        : [Keyboard.addListener('keyboardDidShow', show), Keyboard.addListener('keyboardDidHide', hide)];

    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, [measure]);

  return { inset, onLayout: measure };
}

/** iOS reports the keyboard's own curve, so the padding can move in step with it. */
function animateWithKeyboard(event: KeyboardEvent | null | undefined): void {
  if (Platform.OS !== 'ios' || !event?.duration) {
    return;
  }
  const type = LayoutAnimation.Types[event.easing] ?? LayoutAnimation.Types.keyboard;
  LayoutAnimation.configureNext({ duration: event.duration, update: { duration: event.duration, type } });
}
