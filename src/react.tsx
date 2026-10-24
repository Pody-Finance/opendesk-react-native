import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { OpenDesk, type AIReply, type OpenDeskState } from './client';
import type { Conversation, Identity, Message } from './types';

const OpenDeskContext = createContext<OpenDesk | null>(null);

export interface OpenDeskProviderProps {
  client: OpenDesk;
  /**
   * The signed-in user, fetched from your backend (it holds the widget secret). Pass `null`
   * after sign-out to end the session; leave it undefined for anonymous chat.
   */
  identity?: Identity | null;
  /** Starts the session on mount; turn off to boot lazily when the chat is first opened. */
  autoBoot?: boolean;
  children: ReactNode;
}

export function OpenDeskProvider({ client, identity, autoBoot = true, children }: OpenDeskProviderProps) {
  const identityKey = identity ? JSON.stringify(identity) : identity;
  const previousKey = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (identityKey === previousKey.current) {
      return;
    }
    const hadIdentity = typeof previousKey.current === 'string';
    previousKey.current = identityKey;

    if (identity === null && hadIdentity) {
      void client.shutdown();
    } else if (identity) {
      void client.identify(identity).catch(() => undefined);
    }
  }, [client, identity, identityKey]);

  useEffect(() => {
    if (autoBoot) {
      client.boot().catch(() => undefined);
    }
  }, [client, autoBoot]);

  // The OS suspends the socket in the background; fetch what arrived meanwhile on return.
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && previous !== 'active') {
        client.resume();
      }
      previous = next;
    });

    return () => subscription.remove();
  }, [client]);

  return <OpenDeskContext.Provider value={client}>{children}</OpenDeskContext.Provider>;
}

export function useOpenDesk(): OpenDesk {
  const client = useContext(OpenDeskContext);
  if (!client) {
    throw new Error('useOpenDesk must be used inside <OpenDeskProvider>');
  }

  return client;
}

export function useOpenDeskState<T>(selector: (state: OpenDeskState) => T): T {
  const client = useOpenDesk();

  return useSyncExternalStore(client.subscribe, () => selector(client.getState()));
}

export function useUnreadCount(): number {
  return useOpenDeskState((state) => Object.values(state.unread).reduce((total, count) => total + count, 0));
}

export function useConversations(): { conversations: Conversation[]; ready: boolean; error: string | null } {
  const conversations = useOpenDeskState((state) => state.conversations);
  const status = useOpenDeskState((state) => state.status);
  const error = useOpenDeskState((state) => state.error);

  return { conversations, ready: status === 'ready', error };
}

const noMessages: Message[] = [];

export interface ConversationView {
  messages: Message[];
  /** AI answers still streaming in this conversation. */
  aiReplies: AIReply[];
  /** Name of the agent typing, if any. */
  typing: string | null;
  conversation: Conversation | null;
}

/** Opens a conversation while mounted: loads its messages, keeps it read, and closes it on unmount. */
export function useConversation(conversationId: string | null): ConversationView {
  const client = useOpenDesk();
  const messages = useOpenDeskState((state) => (conversationId ? state.messages[conversationId] : undefined) ?? noMessages);
  const replies = useOpenDeskState((state) => state.aiReplies);
  const typing = useOpenDeskState((state) => (conversationId ? state.typing[conversationId] : undefined) ?? null);
  const conversation = useOpenDeskState(
    (state) => state.conversations.find((c) => c.id === conversationId) ?? null,
  );

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    client.openConversation(conversationId).catch(() => undefined);

    return () => client.closeConversation();
  }, [client, conversationId]);

  const aiReplies = useMemo(
    () => Object.values(replies).filter((reply) => reply.conversationId === conversationId),
    [replies, conversationId],
  );

  return { messages, aiReplies, typing, conversation };
}
