import { OpenDeskApi, type Fetcher } from './api';
import { OpenDeskError } from './errors';
import { OpenDeskRealtime, phoenixSocketFactory, type RealtimeLogger, type SocketFactory } from './realtime';
import { memoryStorage, type TokenStorage } from './storage';
import type {
  Attachment,
  BotRef,
  Conversation,
  Identity,
  LiveEvent,
  Message,
  RealtimeEvent,
  SendMessageInput,
  StartConversationInput,
  UploadFile,
  WidgetConfig,
  WidgetSession,
} from './types';

export interface OpenDeskOptions {
  /** The openDesk origin, e.g. `https://desk.example.com`. */
  baseUrl: string;
  /** The chat widget's public key (`wk_…`). */
  widgetKey: string;
  /** Persists the visitor token so conversations survive restarts. Defaults to memory. */
  storage?: TokenStorage;
  fetcher?: Fetcher;
  socketFactory?: SocketFactory;
  /**
   * Logs the realtime connection (socket, channel join, events) and fallback polling.
   * `true` writes to `console.log` with an `[opendesk]` prefix; a function receives each line.
   */
  debug?: boolean | RealtimeLogger;
}

/** An AI answer being streamed before it lands as a message. */
export interface AIReply {
  id: string;
  conversationId: string;
  text: string;
  phase: 'typing' | 'streaming' | 'done';
  tools: { name: string; status: 'running' | 'done' | 'error' }[];
  bot: BotRef | null;
  messageId: string | null;
  handoff: boolean;
  actionId: string | null;
  updatedAt: number;
}

export interface OpenDeskState {
  status: 'idle' | 'booting' | 'ready' | 'error';
  error: string | null;
  config: WidgetConfig | null;
  session: WidgetSession | null;
  connected: boolean;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  /** Conversation id → name of the agent currently typing. */
  typing: Record<string, string>;
  aiReplies: Record<string, AIReply>;
  /** Conversation id → agent replies received while that conversation was not open. */
  unread: Record<string, number>;
  activeConversationId: string | null;
}

export interface IncomingMessage {
  conversationId: string;
  message: Message;
  from: string;
}

const TYPING_TTL_MS = 6000;
const AI_REPLY_TTL_MS = 60000;
/** How often the open conversation is checked while realtime is down or unconfirmed. */
const POLL_TICK_MS = 3000;
/** After a send, poll every tick until realtime proves it is delivering, for up to this long. */
const AWAIT_REPLY_MS = 60000;
/** With realtime up, the open conversation is still re-fetched this often as a safety net. */
const SAFETY_POLL_MS = 30000;

const initialState: OpenDeskState = {
  status: 'idle',
  error: null,
  config: null,
  session: null,
  connected: false,
  conversations: [],
  messages: {},
  typing: {},
  aiReplies: {},
  unread: {},
  activeConversationId: null,
};

let localIds = 0;

/**
 * Headless openDesk chat client: owns the visitor session, the realtime socket and the
 * conversation state. Subscribe with `subscribe` (or the React hooks) to render it.
 */
export class OpenDesk {
  readonly api: OpenDeskApi;
  private state: OpenDeskState = initialState;
  private identity: Identity = {};
  private realtime: OpenDeskRealtime | null = null;
  private bootPromise: Promise<void> | null = null;
  private readonly storage: TokenStorage;
  private readonly storageKey: string;
  private readonly socketFactory: SocketFactory;
  private readonly subscribers = new Set<() => void>();
  private readonly messageListeners = new Set<(incoming: IncomingMessage) => void>();
  private readonly typingTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** Files uploaded this session, so a message can show its attachments before the server answers. */
  private readonly uploads = new Map<string, Attachment>();
  private readonly log: RealtimeLogger;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private lastPollAt = 0;
  /** When the visitor last sent a message; cleared once a realtime frame arrives after it. */
  private awaitingReplySince = 0;

  constructor(options: OpenDeskOptions) {
    this.api = new OpenDeskApi(options);
    this.storage = options.storage ?? memoryStorage();
    this.storageKey = `opendesk.visitor.${options.widgetKey}`;
    this.socketFactory = options.socketFactory ?? phoenixSocketFactory;
    this.log =
      typeof options.debug === 'function'
        ? options.debug
        : options.debug
          ? (message, data) => console.log(`[opendesk] ${message}`, ...(data === undefined ? [] : [data]))
          : () => undefined;
  }

  getState = (): OpenDeskState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);

    return () => this.subscribers.delete(listener);
  };

  /** Called for every agent or AI reply, e.g. to show an in-app banner. */
  onMessage(listener: (incoming: IncomingMessage) => void): () => void {
    this.messageListeners.add(listener);

    return () => this.messageListeners.delete(listener);
  }

  get unreadCount(): number {
    return Object.values(this.state.unread).reduce((total, count) => total + count, 0);
  }

  /** Loads the widget config and starts (or resumes) the visitor session. Safe to call repeatedly. */
  boot(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.runBoot().catch((error: unknown) => {
        this.bootPromise = null;
        this.set({ status: 'error', error: errorMessage(error) });
        throw error;
      });
    }

    return this.bootPromise;
  }

  /**
   * Attaches the signed-in user. A different `user_id` from the one before drops the stored
   * visitor token, so one user never resumes another's conversations on a shared device.
   */
  async identify(identity: Identity): Promise<void> {
    const switchedUser = Boolean(this.identity.user_id) && this.identity.user_id !== identity.user_id;
    this.identity = { ...(switchedUser ? {} : this.identity), ...identity };

    if (switchedUser) {
      this.resetConversations();
      await this.forgetToken();
    }

    if (this.bootPromise) {
      await this.bootPromise.catch(() => undefined);
      if (this.state.status === 'ready') {
        await this.startSession();
      }
    }
  }

  /** Ends the session and forgets the visitor. Call it when the user signs out. */
  async shutdown(): Promise<void> {
    this.realtime?.stop();
    this.realtime = null;
    this.stopPolling();
    Object.values(this.typingTimers).forEach(clearTimeout);
    await this.api.endSession().catch(() => undefined);
    await this.forgetToken();
    this.identity = {};
    this.bootPromise = null;
    this.state = { ...initialState, config: this.state.config };
    this.emitChange();
  }

  loadConversations(): Promise<Conversation[]> {
    return this.authorized(() => this.fetchConversations());
  }

  /** Marks a conversation as on screen: loads its messages and clears its unread count. */
  async openConversation(conversationId: string): Promise<Message[]> {
    this.set((state) => ({
      activeConversationId: conversationId,
      unread: withoutKey(state.unread, conversationId),
    }));
    this.startPolling();
    const messages = await this.refreshMessages(conversationId);
    this.lastPollAt = Date.now();
    this.api.markSeen(conversationId).catch(() => undefined);

    return messages;
  }

  closeConversation(): void {
    this.realtime?.typingDone();
    this.stopPolling();
    this.set({ activeConversationId: null });
    if (!this.state.connected && this.state.status === 'ready') {
      // Without realtime the list's previews and order are only as fresh as the last fetch.
      void this.loadConversations().catch(() => undefined);
    }
  }

  /**
   * Re-fetches what may have been missed, e.g. when the app returns to the foreground.
   * `OpenDeskProvider` calls it on AppState changes.
   */
  resume(): void {
    if (this.state.status === 'ready') {
      this.log('resume: catching up over REST');
      void this.catchUp();
    }
  }

  async refreshMessages(conversationId: string): Promise<Message[]> {
    const messages = await this.authorized(() => this.api.messages(conversationId));
    this.applyMessages(conversationId, messages, true);

    return this.state.messages[conversationId] ?? [];
  }

  async startConversation(input: StartConversationInput): Promise<Conversation> {
    const { conversation, message } = await this.authorized(() => this.api.startConversation(input));
    this.awaitingReplySince = Date.now();
    this.set((state) => ({
      conversations: [conversation, ...state.conversations.filter((c) => c.id !== conversation.id)],
      activeConversationId: conversation.id,
    }));
    if (message) {
      this.applyMessages(conversation.id, [message], false);
    }

    return conversation;
  }

  /** Sends a reply, showing it at once and swapping in the server copy when it returns. */
  async sendMessage(conversationId: string, input: SendMessageInput): Promise<Message> {
    const localId = `local-${++localIds}`;
    const local: Message = {
      id: localId,
      ticket_id: conversationId,
      kind: 'reply',
      direction: 'inbound',
      author: { type: 'contact', contact: this.state.session?.contact ?? null },
      body_text: input.body ?? '',
      body_html: '',
      attachments: (input.attachment_ids ?? []).flatMap((id) => this.uploads.get(id) ?? []),
      created_at: new Date().toISOString(),
    };
    this.applyMessages(conversationId, [local], false);
    this.realtime?.typingDone();
    this.awaitingReplySince = Date.now();

    try {
      const message = await this.authorized(() => this.api.sendMessage(conversationId, input));
      this.applyMessages(conversationId, [message], false, localId);
      this.touchConversation(conversationId, message);

      return message;
    } catch (error) {
      this.set((state) => ({
        messages: {
          ...state.messages,
          [conversationId]: (state.messages[conversationId] ?? []).filter((m) => m.id !== localId),
        },
      }));
      throw error;
    }
  }

  async upload(file: UploadFile): Promise<Attachment> {
    const attachment = await this.authorized(() => this.api.upload(file));
    this.uploads.set(attachment.id, attachment);

    return attachment;
  }

  typing(conversationId: string): void {
    this.realtime?.typing(conversationId);
  }

  async requestHuman(conversationId: string): Promise<void> {
    await this.authorized(() => this.api.handoff(conversationId));
    this.set((state) => ({
      conversations: state.conversations.map((c) => (c.id === conversationId ? { ...c, ai_handoff: true } : c)),
    }));
  }

  decideAction(conversationId: string, actionId: string, decision: 'confirm' | 'decline'): Promise<void> {
    return this.authorized(() => this.api.decideAction(conversationId, actionId, decision));
  }

  rateMessage(conversationId: string, messageId: string, rating: 'up' | 'down'): Promise<void> {
    return this.authorized(() => this.api.rateMessage(conversationId, messageId, rating));
  }

  private async runBoot(): Promise<void> {
    this.set({ status: 'booting', error: null });
    if (!this.api.visitorToken) {
      this.api.visitorToken = await this.storage.getItem(this.storageKey).catch(() => null);
    }
    const config = await this.api.config();
    this.set({ config });
    await this.startSession();
    this.set({ status: 'ready' });
  }

  private async startSession(): Promise<void> {
    const session = await this.openSession();
    this.set({ session, error: null, connected: false });

    this.realtime?.stop();
    this.realtime = new OpenDeskRealtime(
      this.socketFactory,
      this.gatewayUrl(session.gateway_url),
      session.ws_token,
      session.contact.id,
      async () => (await this.openSession()).ws_token,
      {
        onEvent: (event) => {
          this.heardRealtime();
          this.onRealtimeEvent(event);
        },
        onLive: (event) => {
          this.heardRealtime();
          this.onLiveEvent(event);
        },
        onTyping: (event) => {
          this.heardRealtime();
          this.onAgentTyping(event.ticket_id, event.user?.name || 'Support');
        },
        onStatus: (connected) => {
          this.log(connected ? 'realtime live' : 'realtime down, polling the open conversation');
          this.set({ connected });
        },
        onReconnect: () => void this.catchUp(),
      },
      this.log,
    );
    this.realtime.start();

    await this.fetchConversations();
  }

  private async fetchConversations(): Promise<Conversation[]> {
    const conversations = await this.api.conversations();
    conversations.sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at));
    this.set({ conversations });

    return conversations;
  }

  /** Resumes the stored session; a revoked or expired token falls back to a new one. */
  private async openSession(): Promise<WidgetSession> {
    let session: WidgetSession;
    try {
      session = await this.api.session(this.identity);
    } catch (error) {
      if (!(error instanceof OpenDeskError) || !this.api.visitorToken || error.status < 400 || error.status >= 500) {
        throw error;
      }
      this.api.visitorToken = null;
      session = await this.api.session(this.identity);
    }
    await this.storage.setItem(this.storageKey, session.visitor_token).catch(() => undefined);

    return session;
  }

  /** Runs a visitor request, re-opening the session once if the token was revoked. */
  private async authorized<T>(request: () => Promise<T>): Promise<T> {
    await this.boot();
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof OpenDeskError) || !error.isUnauthorized) {
        throw error;
      }
      this.api.visitorToken = null;
      await this.startSession();

      return request();
    }
  }

  /** A relative gateway URL is resolved against the openDesk origin. */
  private gatewayUrl(url: string | null | undefined): string {
    if (!url) {
      return '';
    }

    return url.startsWith('/') && !url.startsWith('//') ? `${this.api.baseUrl}${url}` : url;
  }

  private heardRealtime(): void {
    this.awaitingReplySince = 0;
  }

  /**
   * While a conversation is open, re-fetches it on a short tick when realtime is down, or when
   * a message was sent and no realtime frame has arrived since, and on a long tick otherwise.
   * A socket that connects but never delivers (a refused join, a proxy that drops frames)
   * therefore still shows replies within seconds instead of only after reopening the chat.
   */
  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => void this.pollTick(), POLL_TICK_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollTick(): Promise<void> {
    const active = this.state.activeConversationId;
    if (!active || this.polling || this.state.status !== 'ready') {
      return;
    }
    const now = Date.now();
    const sinceSend = this.awaitingReplySince ? now - this.awaitingReplySince : Infinity;
    if (sinceSend >= AWAIT_REPLY_MS) {
      this.awaitingReplySince = 0;
    }
    const reason = !this.state.connected
      ? 'realtime down'
      : sinceSend < AWAIT_REPLY_MS
        ? 'no realtime frame since the last send'
        : now - this.lastPollAt >= SAFETY_POLL_MS
          ? 'safety refresh'
          : null;
    if (!reason) {
      return;
    }

    this.polling = true;
    this.lastPollAt = now;
    try {
      this.log(`poll ${active}: ${reason}`);
      await this.refreshMessages(active);
    } catch (error) {
      this.log('poll failed', error);
    } finally {
      this.polling = false;
    }
  }

  private async catchUp(): Promise<void> {
    await this.loadConversations().catch(() => undefined);
    const active = this.state.activeConversationId;
    if (active) {
      await this.refreshMessages(active).catch(() => undefined);
    }
  }

  private onRealtimeEvent(event: RealtimeEvent): void {
    const conversationId = event.data.ticket_id ?? event.data.message?.ticket_id;

    if (event.type === 'message.withdrawn') {
      const messageId = event.data.message_id;
      if (conversationId && messageId) {
        this.set((state) => ({
          messages: {
            ...state.messages,
            [conversationId]: (state.messages[conversationId] ?? []).filter((m) => m.id !== messageId),
          },
        }));
      }

      return;
    }

    if (event.type !== 'message.created' && event.type !== 'message.updated') {
      return;
    }

    const message = event.data.message;
    if (!message || !conversationId || message.kind === 'note') {
      return;
    }

    this.applyMessages(conversationId, [message], false);
    if (event.type === 'message.updated') {
      return;
    }

    if (this.state.conversations.some((c) => c.id === conversationId)) {
      this.touchConversation(conversationId, message);
    } else {
      void this.loadConversations().catch(() => undefined);
    }

    if (message.direction !== 'outbound') {
      return;
    }

    this.clearTyping(conversationId);
    if (this.state.activeConversationId === conversationId) {
      this.api.markSeen(conversationId).catch(() => undefined);
    } else {
      this.set((state) => ({
        unread: { ...state.unread, [conversationId]: (state.unread[conversationId] ?? 0) + 1 },
      }));
    }

    const from =
      message.author.user?.name || message.author.bot?.name || this.state.config?.workspace_name || 'Support';
    this.messageListeners.forEach((listener) => {
      try {
        listener({ conversationId, message, from });
      } catch {
        // A listener's failure must not break the stream.
      }
    });
  }

  private onLiveEvent(event: LiveEvent): void {
    const { reply_id: replyId, ticket_id: conversationId } = event.data;
    if (typeof replyId !== 'string' || typeof conversationId !== 'string') {
      return;
    }

    const now = Date.now();
    this.set((state) => {
      const replies = pruneReplies(state.aiReplies, now);
      const current: AIReply = replies[replyId] ?? {
        id: replyId,
        conversationId,
        text: '',
        phase: 'typing',
        tools: [],
        bot: null,
        messageId: null,
        handoff: false,
        actionId: null,
        updatedAt: now,
      };

      switch (event.type) {
        case 'ai.reply.started':
          return { aiReplies: { ...replies, [replyId]: { ...current, bot: event.data.bot ?? current.bot, updatedAt: now } } };
        case 'ai.reply.delta':
          if (!event.data.text) {
            return {};
          }

          return {
            aiReplies: {
              ...replies,
              [replyId]: { ...current, text: current.text + event.data.text, phase: 'streaming', updatedAt: now },
            },
          };
        case 'ai.reply.tool': {
          const name = event.data.tool;
          if (!name) {
            return {};
          }
          const status = event.data.status === 'done' || event.data.status === 'error' ? event.data.status : 'running';
          const tools = [...current.tools];
          const running = tools.map((t) => t.name === name && t.status === 'running').lastIndexOf(true);
          if (running >= 0) {
            tools[running] = { name, status };
          } else {
            tools.push({ name, status });
          }

          return { aiReplies: { ...replies, [replyId]: { ...current, tools, updatedAt: now } } };
        }
        case 'ai.reply.ended': {
          const messageId = event.data.message_id || null;
          const landed =
            !messageId || (state.messages[conversationId] ?? []).some((m) => m.id === messageId);
          if (landed) {
            return { aiReplies: withoutKey(replies, replyId) };
          }

          return {
            aiReplies: {
              ...replies,
              [replyId]: {
                ...current,
                phase: 'done',
                tools: current.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)),
                messageId,
                handoff: event.data.handoff === true,
                actionId: event.data.action_id ?? null,
                updatedAt: now,
              },
            },
          };
        }
        default:
          return {};
      }
    });
  }

  private onAgentTyping(conversationId: string, name: string): void {
    this.set((state) => ({ typing: { ...state.typing, [conversationId]: name } }));
    clearTimeout(this.typingTimers[conversationId]);
    this.typingTimers[conversationId] = setTimeout(() => this.clearTyping(conversationId), TYPING_TTL_MS);
  }

  private clearTyping(conversationId: string): void {
    clearTimeout(this.typingTimers[conversationId]);
    delete this.typingTimers[conversationId];
    if (conversationId in this.state.typing) {
      this.set((state) => ({ typing: withoutKey(state.typing, conversationId) }));
    }
  }

  /**
   * Merges messages by id in time order; `replace` makes the list exactly the server's copy.
   * A stored message takes over the render key of the optimistic copy (`replacesLocalId`, or
   * a pending copy with the same text) or of the AI stream it finishes, so its row never remounts.
   */
  private applyMessages(conversationId: string, incoming: Message[], replace: boolean, replacesLocalId?: string): void {
    this.set((state) => {
      const existing = state.messages[conversationId] ?? [];
      const existingById = new Map(existing.map((m) => [m.id, m]));
      const pending = existing.filter((m) => m.id.startsWith('local-'));
      const usedLocalIds = new Set<string>();
      const finishedReplyIds = new Set<string>();

      const keyed = incoming.map((message): Message => {
        if (message.client_id) {
          return message;
        }
        const previous = existingById.get(message.id);
        if (previous?.client_id) {
          return { ...message, client_id: previous.client_id };
        }
        if (message.direction === 'inbound' && !message.id.startsWith('local-')) {
          const local =
            pending.find((m) => m.id === replacesLocalId) ??
            pending.find((m) => !usedLocalIds.has(m.id) && (m.body_text ?? '') === (message.body_text ?? ''));
          if (local) {
            usedLocalIds.add(local.id);

            return { ...message, client_id: local.client_id ?? local.id };
          }
        }
        if (message.ai && message.direction === 'outbound') {
          const reply = Object.values(state.aiReplies).find(
            (r) =>
              !finishedReplyIds.has(r.id) &&
              (r.messageId === message.id || (r.conversationId === conversationId && r.phase !== 'done')),
          );
          if (reply) {
            finishedReplyIds.add(reply.id);

            return { ...message, client_id: `ai-${reply.id}` };
          }
        }

        return message;
      });

      const base = (replace ? pending : existing).filter((m) => !usedLocalIds.has(m.id));
      const byId = new Map(base.map((m) => [m.id, m]));
      keyed.forEach((m) => byId.set(m.id, m));
      const merged = [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

      const landedIds = new Set(incoming.map((m) => m.id));
      const aiReplies = Object.fromEntries(
        Object.entries(state.aiReplies).filter(
          ([id, reply]) => !finishedReplyIds.has(id) && !(reply.messageId && landedIds.has(reply.messageId)),
        ),
      );

      return { messages: { ...state.messages, [conversationId]: merged }, aiReplies };
    });
  }

  private touchConversation(conversationId: string, message: Message): void {
    this.set((state) => {
      const conversation = state.conversations.find((c) => c.id === conversationId);
      if (!conversation) {
        return {};
      }

      return {
        conversations: [
          {
            ...conversation,
            last_message_at: message.created_at,
            last_message_preview: previewOf(message),
          },
          ...state.conversations.filter((c) => c.id !== conversationId),
        ],
      };
    });
  }

  private resetConversations(): void {
    this.realtime?.stop();
    this.realtime = null;
    this.stopPolling();
    this.set({
      session: null,
      connected: false,
      conversations: [],
      messages: {},
      typing: {},
      aiReplies: {},
      unread: {},
      activeConversationId: null,
    });
  }

  private async forgetToken(): Promise<void> {
    this.api.visitorToken = null;
    await this.storage.removeItem(this.storageKey).catch(() => undefined);
  }

  private set(patch: Partial<OpenDeskState> | ((state: OpenDeskState) => Partial<OpenDeskState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    if (Object.keys(next).length === 0) {
      return;
    }
    this.state = { ...this.state, ...next };
    this.emitChange();
  }

  private emitChange(): void {
    this.subscribers.forEach((listener) => listener());
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const copy = { ...record };
  delete copy[key];

  return copy;
}

function pruneReplies(replies: Record<string, AIReply>, now: number): Record<string, AIReply> {
  return Object.fromEntries(Object.entries(replies).filter(([, reply]) => now - reply.updatedAt < AI_REPLY_TTL_MS));
}

/** A list preview for a message; an attachment-only message shows its file names. */
function previewOf(message: Message): string {
  const text = (message.body_text ?? '').trim();

  return (text || (message.attachments ?? []).map((a) => a.filename).join(', ')).slice(0, 140);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Support is unavailable right now';
}
