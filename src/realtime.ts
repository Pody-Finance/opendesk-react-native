import { Socket } from 'phoenix';
import type { LiveEvent, RealtimeEvent, TypingEvent } from './types';

/** The parts of a Phoenix socket and channel the SDK uses, so tests can swap them. */
/** What `join()` returns on a Phoenix channel: callbacks for the server's join reply. */
export interface RealtimePush {
  receive(status: string, callback: (response: any) => void): RealtimePush;
}

export interface RealtimeChannel {
  on(event: string, callback: (payload: any) => void): unknown;
  /** Phoenix returns a push to hear the join reply on; a stand-in may return nothing. */
  join(): RealtimePush | unknown;
  onError?(callback: (reason?: unknown) => void): unknown;
  onClose?(callback: () => void): unknown;
  leave(): unknown;
  push(event: string, payload: object): unknown;
}

export interface RealtimeSocket {
  onOpen(callback: () => void): unknown;
  onClose(callback: () => void): unknown;
  onError(callback: () => void): unknown;
  connect(): void;
  disconnect(): void;
  channel(topic: string, params?: object): RealtimeChannel;
}

export type RealtimeLogger = (message: string, data?: unknown) => void;

export type SocketFactory = (url: string, params: () => { token: string }, logger?: RealtimeLogger) => RealtimeSocket;

export const phoenixSocketFactory: SocketFactory = (url, params, logger) =>
  new Socket(url, {
    params,
    reconnectAfterMs: (tries: number) => [1000, 2000, 5000, 10000][tries - 1] ?? 15000,
    ...(logger ? { logger: (kind: string, message: string, data: unknown) => logger(`phoenix ${kind}: ${message}`, data) } : {}),
  });

export interface RealtimeHandlers {
  onEvent(event: RealtimeEvent): void;
  onLive(event: LiveEvent): void;
  onTyping(event: TypingEvent): void;
  /** True once the contact channel is joined, false when the socket or the channel drops. */
  onStatus(connected: boolean): void;
  /** Fired when the socket comes back after a drop, so missed events can be fetched over REST. */
  onReconnect(): void;
}

const TYPING_THROTTLE_MS = 3000;

/**
 * Joins `contact:<wid>:<contact_id>` on the widget gateway. The `ws_token` lasts five minutes
 * and is checked only on connect, so every drop fetches a fresh one before the next attempt.
 */
export class OpenDeskRealtime {
  private socket: RealtimeSocket | null = null;
  private channel: RealtimeChannel | null = null;
  private refreshing = false;
  private lastTypingAt = 0;
  private stopped = false;

  constructor(
    private readonly factory: SocketFactory,
    private readonly gatewayUrl: string,
    private token: string,
    private readonly contactId: string,
    private readonly refreshToken: () => Promise<string>,
    private readonly handlers: RealtimeHandlers,
    private readonly log: RealtimeLogger = () => undefined,
  ) {}

  /** Returns false when there is nothing to connect to, so the caller can fall back to polling. */
  start(): boolean {
    const workspaceId = jwtClaim(this.token, 'wid');
    if (!workspaceId || !this.gatewayUrl) {
      this.log('realtime off: the session has no gateway_url or its ws_token has no wid claim', {
        gatewayUrl: this.gatewayUrl,
        hasWorkspaceId: Boolean(workspaceId),
      });

      return false;
    }

    const url = socketUrl(this.gatewayUrl);
    const topic = `contact:${workspaceId}:${this.contactId}`;
    this.log('realtime connecting', { url, topic });
    const socket = this.factory(url, () => ({ token: this.token }), this.log);
    let dropped = false;
    let joined = false;
    // With a real Phoenix channel, "connected" waits for the join reply, not just the socket.
    let canHearJoinReply = false;

    // Callbacks from a socket that was stopped (a new session replaced it) must not touch state.
    const live = (): boolean => !this.stopped && this.socket === socket;

    const setJoined = (value: boolean): void => {
      if (joined !== value && live()) {
        joined = value;
        this.handlers.onStatus(value);
      }
    };

    socket.onOpen(() => {
      if (!live()) {
        return;
      }
      this.log('realtime socket open');
      if (canHearJoinReply) {
        return;
      }
      setJoined(true);
      if (dropped) {
        this.handlers.onReconnect();
      }
      dropped = false;
    });

    const onDrop = (): void => {
      if (!live()) {
        return;
      }
      this.log('realtime socket dropped, fetching a fresh ws_token before the next attempt');
      dropped = true;
      setJoined(false);
      if (this.refreshing) {
        return;
      }
      this.refreshing = true;
      this.refreshToken()
        .then((token) => {
          this.token = token;
        })
        .catch((error: unknown) => this.log('realtime token refresh failed', error))
        .finally(() => {
          this.refreshing = false;
        });
    };
    socket.onError(onDrop);
    socket.onClose(onDrop);

    const channel = socket.channel(topic, {});
    channel.on('event', (payload: RealtimeEvent) => {
      this.log('realtime event', payload?.type);
      this.handlers.onEvent(payload);
    });
    channel.on('typing', (payload: TypingEvent) => this.handlers.onTyping(payload));
    channel.on('live', (payload: LiveEvent) => {
      if (payload && typeof payload.type === 'string' && payload.data) {
        this.handlers.onLive(payload);
      }
    });
    channel.onError?.((reason) => {
      this.log('realtime channel error', reason);
      setJoined(false);
    });

    this.socket = socket;
    this.channel = channel;

    const reply = channel.join();
    canHearJoinReply = isPush(reply);
    if (isPush(reply)) {
      reply
        .receive('ok', () => {
          this.log('realtime joined', topic);
          setJoined(true);
          if (dropped) {
            this.handlers.onReconnect();
            dropped = false;
          }
        })
        .receive('error', (response) => {
          this.log('realtime join refused', response);
          setJoined(false);
        })
        .receive('timeout', () => {
          this.log('realtime join timed out');
          setJoined(false);
        });
    }
    socket.connect();

    return true;
  }

  /** Tells agents the visitor is typing in a conversation; throttled to one push per 3s. */
  typing(conversationId: string): void {
    const now = Date.now();
    if (!this.channel || now - this.lastTypingAt < TYPING_THROTTLE_MS) {
      return;
    }
    this.lastTypingAt = now;
    this.channel.push('typing', { ticket_id: conversationId });
  }

  typingDone(): void {
    this.lastTypingAt = 0;
  }

  stop(): void {
    this.stopped = true;
    this.channel?.leave();
    this.socket?.disconnect();
    this.channel = null;
    this.socket = null;
  }
}

function isPush(value: unknown): value is RealtimePush {
  return typeof value === 'object' && value !== null && typeof (value as RealtimePush).receive === 'function';
}

/**
 * Phoenix adds `/websocket` itself and needs a `ws(s)://` URL, so a gateway URL given as
 * `https://…/socket/widget` or ending in `/websocket` still lands on the right endpoint.
 */
export function socketUrl(gatewayUrl: string): string {
  return gatewayUrl
    .trim()
    .replace(/^http(s?):\/\//i, 'ws$1://')
    .replace(/\/+$/, '')
    .replace(/\/websocket$/, '');
}

export function jwtClaim(token: string, claim: string): string | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) {
      return null;
    }
    const value = JSON.parse(decodeBase64Url(segment))[claim];

    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes base64url to a UTF-8 string without relying on `atob`, which older Hermes lacks. */
function decodeBase64Url(input: string): string {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const index = BASE64.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base64');
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}
