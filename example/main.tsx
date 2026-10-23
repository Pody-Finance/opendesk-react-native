import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StyleSheet, Text, View } from 'react-native';
import { OpenDesk, OpenDeskChat, OpenDeskLauncher, OpenDeskProvider } from '../src';
import { BotFace } from '../src/ui/BotFace';
import { createMockDesk } from './mockDesk';

const desk = createMockDesk();
const client = new OpenDesk({
  baseUrl: 'https://desk.example.com',
  widgetKey: 'wk_preview',
  fetcher: desk.fetcher,
  socketFactory: desk.socketFactory,
});

const identity = { user_id: 'user-42', user_hash: 'preview', email: 'jamie@example.com', name: 'Jamie Rivera' };

/** The browser's file dialog, standing in for expo-image-picker / expo-document-picker on a device. */
function pickWebFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.pdf';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function Preview() {
  const [open, setOpen] = useState(true);

  return (
    <OpenDeskProvider client={client} identity={identity}>
      <div className="stage">
        <div className="phone">
          {open ? (
            <OpenDeskChat onClose={() => setOpen(false)} pickAttachment={pickWebFile} />
          ) : (
            <View style={styles.app}>
              <Text style={styles.appTitle}>Your app</Text>
              <Text style={styles.appText}>The launcher opens the chat and shows the unread count.</Text>
              <OpenDeskLauncher onPress={() => setOpen(true)} style={styles.launcher} />
            </View>
          )}
        </div>
        <aside className="controls">
          <h1>openDesk RN SDK preview</h1>
          <p>
            <code>OpenDeskChat</code> through react-native-web against a mock openDesk. Start a conversation to see the bot stream an
            answer, attach a file, or ask for a person after an AI answer.
          </p>
          <View style={styles.faces}>
            <BotFace size={64} />
            <BotFace size={64} look={{ kind: 'built', shape: 'circle', fill: { type: 'gradient', color: '#a7f3d0', to: '#047857' }, eyes: 'dots', mouth: 'smile' }} />
            <BotFace size={64} look={{ kind: 'built', shape: 'squircle', fill: { type: 'solid', color: '#f59e0b' }, eyes: 'ovals', mouth: 'grin' }} />
          </View>
          <button onClick={desk.simulateAgentReply}>Simulate an agent reply</button>
          <button onClick={desk.simulateAction}>Simulate an AI action to confirm</button>
          <button onClick={() => setOpen((value) => !value)}>{open ? 'Close chat (show launcher)' : 'Open chat'}</button>
        </aside>
      </div>
    </OpenDeskProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, padding: 24, backgroundColor: '#f4f4f5' },
  appTitle: { fontSize: 28, fontWeight: '700', color: '#0a0a0a', marginTop: 24 },
  appText: { fontSize: 15, color: '#525252', marginTop: 8, lineHeight: 21 },
  launcher: { position: 'absolute', right: 20, bottom: 20 },
  faces: { flexDirection: 'row', gap: 12, marginVertical: 8 },
});

/** A hot update re-runs this module; unmount the previous root so only one client renders. */
const host = window as unknown as { __openDeskRoot?: Root };
host.__openDeskRoot?.unmount();
host.__openDeskRoot = createRoot(document.getElementById('root')!);
host.__openDeskRoot.render(<Preview />);
