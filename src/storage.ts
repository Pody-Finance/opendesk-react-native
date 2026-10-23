/**
 * Where the visitor token is kept between launches. The token is a bearer credential for the
 * visitor's conversations, so prefer `secureStoreStorage` or `keychainStorage`, which keep it in
 * the iOS Keychain / Android Keystore. Without a storage the session lasts until the app quits.
 */
export interface TokenStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function memoryStorage(): TokenStorage {
  const items = new Map<string, string>();

  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
}

/** The parts of `expo-secure-store` the adapter uses; pass the module itself. */
export interface ExpoSecureStoreModule {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown;
}

/**
 * Keeps the token in `expo-secure-store`. Takes the module as an argument, so the SDK has no
 * dependency on Expo:
 *
 *     import * as SecureStore from 'expo-secure-store';
 *     new OpenDesk({ …, storage: secureStoreStorage(SecureStore) });
 *
 * On iOS the item is readable after the first unlock and never leaves the device in backups.
 */
export function secureStoreStorage(SecureStore: ExpoSecureStoreModule): TokenStorage {
  const options =
    SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY === undefined
      ? undefined
      : { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

  return {
    getItem: (key) => SecureStore.getItemAsync(secureStoreKey(key), options),
    setItem: (key, value) => SecureStore.setItemAsync(secureStoreKey(key), value, options),
    removeItem: (key) => SecureStore.deleteItemAsync(secureStoreKey(key), options),
  };
}

/** The parts of `react-native-keychain` the adapter uses; pass the module itself. */
export interface KeychainModule {
  getGenericPassword(options?: object): Promise<false | { username: string; password: string }>;
  setGenericPassword(username: string, password: string, options?: object): Promise<unknown>;
  resetGenericPassword(options?: object): Promise<unknown>;
  ACCESSIBLE?: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: unknown };
}

/**
 * Keeps the token in `react-native-keychain`, one Keychain/Keystore entry per key (the key is
 * the entry's `service`). Takes the module as an argument, so the SDK has no native dependency:
 *
 *     import * as Keychain from 'react-native-keychain';
 *     new OpenDesk({ …, storage: keychainStorage(Keychain) });
 */
export function keychainStorage(Keychain: KeychainModule): TokenStorage {
  const accessible = Keychain.ACCESSIBLE?.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  const options = (key: string) => ({ service: key, ...(accessible === undefined ? {} : { accessible }) });

  return {
    getItem: async (key) => {
      const entry = await Keychain.getGenericPassword({ service: key });

      return entry ? entry.password : null;
    },
    setItem: async (key, value) => {
      await Keychain.setGenericPassword('opendesk', value, options(key));
    },
    removeItem: async (key) => {
      await Keychain.resetGenericPassword({ service: key });
    },
  };
}

/** SecureStore keys may only hold letters, digits, `.`, `-` and `_`. */
function secureStoreKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}
