# opendesk-react-native

React Native SDK for [openDesk](https://opendesk.sh) live chat. It uses the same visitor API and realtime gateway as openDesk's web widget (`/widget/v1.js`), with no WebView:

- `OpenDesk`: a headless client for the session, conversations, messages, attachments, AI streaming, handoff and unread counts
- `OpenDeskProvider` and hooks: `useConversations`, `useConversation`, `useUnreadCount` and `useOpenDeskState`
- `OpenDeskChat` and `OpenDeskLauncher`: drop-in UI that mirrors the web widget. It reads the brand colour, radius, theme, bot, team and copy from your widget's settings, and is built only from React Native core components.

## Install

```bash
npm install opendesk-react-native expo-secure-store
```

## Set up

```tsx
import * as SecureStore from 'expo-secure-store';
import { OpenDesk, OpenDeskProvider, secureStoreStorage } from 'opendesk-react-native';

export const support = new OpenDesk({
  baseUrl: 'https://desk.example.com', // your openDesk origin (https://app.opendesk.sh on cloud)
  widgetKey: 'wk_…', // Settings → Brands and widgets → Chat widgets
  storage: secureStoreStorage(SecureStore), // keeps the visitor's conversations across launches
});

export function App() {
  const identity = useSupportIdentity(); // see below
  return (
    <OpenDeskProvider client={support} identity={identity}>
      <Navigation />
    </OpenDeskProvider>
  );
}
```

## Where the visitor token is kept

The SDK stores one value: the visitor token (`od_vis_…`). It is a bearer credential, so anyone holding it can read that visitor's conversations and post as them. Keep it in the iOS Keychain or Android Keystore with one of the two adapters. Each adapter takes the native module as an argument, so the SDK itself depends on neither:

| Your app uses | Install | Pass as `storage` |
| --- | --- | --- |
| Expo | `npx expo install expo-secure-store` | `secureStoreStorage(SecureStore)` (`import * as SecureStore from 'expo-secure-store'`) |
| Bare React Native | `npm install react-native-keychain`, then `pod install` | `keychainStorage(Keychain)` (`import * as Keychain from 'react-native-keychain'`) |

Both adapters store the token as *after first unlock, this device only*. It's readable in the background after the first unlock, and it's left out of iCloud and device-transfer backups.

Leave `storage` out and the token lives in memory only, so every launch starts a new visitor. Any `{ getItem, setItem, removeItem }` object also works. AsyncStorage fits that shape, but it writes plain text, so don't use it for this.

## Reply sound

The SDK can play the web widget's reply chime when an agent or AI replies in a conversation the visitor doesn't have open. It follows the widget's **Sound** setting in openDesk, the same as on the web. Install `expo-audio` and pass it in:

```tsx
// npx expo install expo-audio
import * as ExpoAudio from 'expo-audio';
import { expoAudioSound } from 'opendesk-react-native';

export const support = new OpenDesk({
  // …
  sound: expoAudioSound(ExpoAudio), // or expoAudioSound(ExpoAudio, { volume: 0.5 })
});
```

The chime ships with the package (`assets/chime.wav`). The SDK leaves your app's audio mode alone; under expo-audio's default the chime mixes with other audio rather than pausing it. To play something else, pass any function as `sound`. Leave `sound` out for no sound.

## Identify the signed-in user

To attach chats to a known contact, pass `{ user_id, user_hash, email, name }` as `identity`. `user_hash` is `hex(HMAC-SHA256(widget_secret, user_id))`, as described in [Identity verification](https://docs.opendesk.sh/guides/live-chat/identity-verification/). Compute it on your server, never in the app, and serve it from an authenticated endpoint of your own:

```tsx
function useSupportIdentity() {
  const { user } = useAuth();
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    if (!user) return setIdentity(null);
    // Your backend returns { user_id, user_hash, email, name } for the signed-in user.
    fetchMySupportIdentity().then(setIdentity).catch(() => {});
  }, [user?.id]);

  return identity;
}
```

When the user signs out, pass `null` (or call `support.shutdown()`) so the next person on the device never sees their conversations. If a different `user_id` signs in, the SDK drops the previous visitor by itself. Leave `identity` undefined for anonymous chat.

## Show the chat

```tsx
import * as DocumentPicker from 'expo-document-picker';
import { OpenDeskChat, OpenDeskLauncher } from 'opendesk-react-native';

<OpenDeskChat
  onClose={() => navigation.goBack()}
  pickAttachment={async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'] });
    const file = result.assets?.[0];
    return file ? { uri: file.uri, name: file.name, type: file.mimeType ?? 'application/octet-stream', size: file.size } : null;
  }}
/>

<OpenDeskLauncher onPress={() => navigation.navigate('Support')} style={{ position: 'absolute', right: 20, bottom: 20 }} />
```

`OpenDeskChat` also takes these props:

- `theme`: `'light' | 'dark' | 'auto'`, which overrides the widget setting
- `accentColor`
- `strings`: replaces any of the built-in English copy (`defaultStrings` lists every key)
- `initialConversationId`
- `keyboardVerticalOffset`: extra space between the composer and the keyboard (see below)

The chat keeps its composer above the keyboard by measuring where it sits on screen, so it needs no offset under a navigation header. Two cases it can't measure past:

- **React Native's `<Modal>` on Android** is a separate window that gets no keyboard events, so the composer stays under the keyboard. Show the chat as a screen, or as a full-screen view over your app, instead.
- **An iOS page sheet** (`presentationStyle="pageSheet"`, or a sheet-style navigation modal) starts below the top of the screen. Pass the sheet's distance from the top as `keyboardVerticalOffset`, or present it full screen.

Tapping an attached image opens it inside the chat. On Android, the back button closes it.

For an in-app banner while the chat is closed, use `support.onMessage(({ conversationId, from, message }) => …)`.

## Build your own UI

```tsx
const { conversations } = useConversations();
const { messages, aiReplies, typing } = useConversation(conversationId); // marks it read while mounted
const client = useOpenDesk();

await client.startConversation({ body, topic_id });
await client.sendMessage(conversationId, { body, attachment_ids });
const attachment = await client.upload({ uri, name, type }); // or a File/Blob on the web
client.typing(conversationId);
await client.requestHuman(conversationId); // after an AI answer
await client.decideAction(conversationId, actionId, 'confirm');
await client.rateMessage(conversationId, messageId, 'up');
```

Render messages with `message.client_id ?? message.id` as the key. That keeps a bubble mounted when its optimistic copy or streamed AI answer is replaced by the stored message.

## Preview

```bash
npm run example
```

This runs `OpenDeskChat` in the browser on port 8774, through react-native-web, against a mock openDesk (`example/mockDesk.ts`). The mock covers AI streaming, tool checks, an AI action to confirm, agent typing, handoff, attachments and unread badges, and needs no server.

## Notes

- Realtime uses Phoenix Channels (the `phoenix` package, 1.8+) on `<gateway_url>` and the topic `contact:<wid>:<contact_id>`. The 5-minute `ws_token` goes in Phoenix's `authToken` (the `Sec-WebSocket-Protocol` header; the gateway refuses it in the URL), is refreshed before every reconnect, and missed messages are re-fetched over REST after a drop.
- If **Allowed sites** is set on the widget, openDesk checks the `Origin` header. Native requests send none, so check that your app can still reach the API.
- The widget API has no push notifications for replies sent while the app is closed. Use openDesk webhooks (`message.created`) to your backend for those.

## License

MIT
