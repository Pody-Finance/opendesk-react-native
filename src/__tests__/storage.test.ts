import { describe, expect, it } from 'vitest';
import { keychainStorage, secureStoreStorage, type ExpoSecureStoreModule, type KeychainModule } from '../storage';

const ACCESSIBLE = 'AccessibleAfterFirstUnlockThisDeviceOnly';

function fakeSecureStore() {
  const items = new Map<string, string>();
  const calls: { method: string; key: string; options?: object }[] = [];
  const module: ExpoSecureStoreModule = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: ACCESSIBLE,
    getItemAsync: async (key, options) => {
      calls.push({ method: 'get', key, options });

      return items.get(key) ?? null;
    },
    setItemAsync: async (key, value, options) => {
      if (!/^[A-Za-z0-9._-]+$/.test(key)) {
        throw new Error('Invalid key provided to SecureStore');
      }
      calls.push({ method: 'set', key, options });
      items.set(key, value);
    },
    deleteItemAsync: async (key, options) => {
      calls.push({ method: 'delete', key, options });
      items.delete(key);
    },
  };

  return { module, items, calls };
}

function fakeKeychain() {
  const entries = new Map<string, { username: string; password: string; options?: object }>();
  const module: KeychainModule = {
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: ACCESSIBLE },
    getGenericPassword: async (options) => {
      const entry = entries.get((options as { service: string }).service);

      return entry ? { username: entry.username, password: entry.password } : false;
    },
    setGenericPassword: async (username, password, options) => {
      entries.set((options as { service: string }).service, { username, password, options });

      return { service: (options as { service: string }).service };
    },
    resetGenericPassword: async (options) => entries.delete((options as { service: string }).service),
  };

  return { module, entries };
}

describe('secureStoreStorage', () => {
  it('stores, reads and removes the token with device-only accessibility', async () => {
    const store = fakeSecureStore();
    const storage = secureStoreStorage(store.module);

    expect(await storage.getItem('opendesk.visitor.wk_abc')).toBeNull();
    await storage.setItem('opendesk.visitor.wk_abc', 'od_vis_1');
    expect(await storage.getItem('opendesk.visitor.wk_abc')).toBe('od_vis_1');
    await storage.removeItem('opendesk.visitor.wk_abc');
    expect(await storage.getItem('opendesk.visitor.wk_abc')).toBeNull();

    expect(store.calls.find((c) => c.method === 'set')?.options).toEqual({ keychainAccessible: ACCESSIBLE });
  });

  it('maps keys SecureStore would reject to allowed characters', async () => {
    const store = fakeSecureStore();
    const storage = secureStoreStorage(store.module);

    await storage.setItem('opendesk.visitor.wk:with/odd key', 'od_vis_2');

    expect([...store.items.keys()]).toEqual(['opendesk.visitor.wk_with_odd_key']);
    expect(await storage.getItem('opendesk.visitor.wk:with/odd key')).toBe('od_vis_2');
  });

  it('works with modules that lack the accessibility constant', async () => {
    const store = fakeSecureStore();
    delete store.module.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
    const storage = secureStoreStorage(store.module);

    await storage.setItem('k', 'v');

    expect(store.calls[0]!.options).toBeUndefined();
  });
});

describe('keychainStorage', () => {
  it('keeps each key in its own service entry, device-only', async () => {
    const keychain = fakeKeychain();
    const storage = keychainStorage(keychain.module);

    await storage.setItem('opendesk.visitor.wk_a', 'od_vis_a');
    await storage.setItem('opendesk.visitor.wk_b', 'od_vis_b');

    expect(await storage.getItem('opendesk.visitor.wk_a')).toBe('od_vis_a');
    expect(await storage.getItem('opendesk.visitor.wk_b')).toBe('od_vis_b');
    expect(keychain.entries.get('opendesk.visitor.wk_a')?.options).toEqual({
      service: 'opendesk.visitor.wk_a',
      accessible: ACCESSIBLE,
    });
  });

  it('returns null for a missing entry and removes entries', async () => {
    const keychain = fakeKeychain();
    const storage = keychainStorage(keychain.module);

    expect(await storage.getItem('missing')).toBeNull();
    await storage.setItem('k', 'v');
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });
});
