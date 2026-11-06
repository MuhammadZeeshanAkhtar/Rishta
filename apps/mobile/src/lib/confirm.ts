import { Alert, Platform } from 'react-native';

/**
 * "Are you sure?", on every platform.
 *
 * `Alert.alert` does nothing at all in react-native-web: no dialog, no callback, no
 * error. So on the web build, Block, Report's confirmation, Leave conversation,
 * Decline, Withdraw, Remove photo and Revoke family access were all buttons that did
 * nothing when pressed. Every confirmation in the app goes through this instead.
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Shown as a destructive action where the platform has one. */
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmAction(options: ConfirmOptions): void {
  const { title, message, confirmLabel, cancelLabel, destructive = true, onConfirm } = options;

  if (Platform.OS === 'web') {
    const ask = (globalThis as { confirm?: (text: string) => boolean }).confirm;
    if (ask?.(`${title}\n\n${message}`)) onConfirm();
    return;
  }

  Alert.alert(
    title,
    message,
    [
      { text: cancelLabel, style: 'cancel' },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ],
    { cancelable: true },
  );
}
