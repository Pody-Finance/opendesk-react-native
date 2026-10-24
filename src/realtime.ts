import { Socket } from 'phoenix';
import type { LiveEvent, RealtimeEvent, TypingEvent } from './types';

/** The parts of a Phoenix socket and channel the SDK uses, so tests can swap them. */
export interface RealtimeChannel {
  on(event: string, callback: (payload: any) => void): unknown;
  join(): unknown;
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

export type SocketFactory = (url: string, params: () => { token: string }) => RealtimeSocket;

/**
 * The gateway reads the token from Phoenix's `authToken` (sent in the `Sec-WebSocket-Protocol`
 * header) and refuses a connect that carries it in the query string. Phoenix calls the function
 * on every connect, so a refreshed token is used on the next attempt.
 */
export const phoenixSocketFactory: SocketFactory = (url, params) =>
  new Socket(url, {
    authToken: () => params().token,
    reconnectAfterMs: (tries: number) => [1000, 2000, 5000, 10000][tries - 1] ?? 15000,
  });

export interface RealtimeHandlers {
  onEvent(event: RealtimeEvent): void;
  onLive(event: LiveEvent): void;
  onTyping(event: TypingEvent): void;
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

  constructor(
    private readonly factory: SocketFactory,
    private readonly gatewayUrl: string,
    private token: string,
    private readonly contactId: string,
    private readonly refreshToken: () => Promise<string>,
    private readonly handlers: RealtimeHandlers,
  ) {}

  start(): void {
    const workspaceId = jwtClaim(this.token, 'wid');
    if (!workspaceId || !this.gatewayUrl) {
      return;
    }

    const socket = this.factory(this.gatewayUrl, () => ({ token: this.token }));
    let dropped = false;

    socket.onOpen(() => {
      this.handlers.onStatus(true);
      if (dropped) {
        this.handlers.onReconnect();
      }
      dropped = false;
    });

    const onDrop = (): void => {
      dropped = true;
      this.handlers.onStatus(false);
      if (this.refreshing) {
        return;
      }
      this.refreshing = true;
      this.refreshToken()
        .then((token) => {
          this.token = token;
        })
        .catch(() => undefined)
        .finally(() => {
          this.refreshing = false;
        });
    };
    socket.onError(onDrop);
    socket.onClose(onDrop);
    socket.connect();

    const channel = socket.channel(`contact:${workspaceId}:${this.contactId}`, {});
    channel.on('event', (payload: RealtimeEvent) => this.handlers.onEvent(payload));
    channel.on('typing', (payload: TypingEvent) => this.handlers.onTyping(payload));
    channel.on('live', (payload: LiveEvent) => {
      if (payload && typeof payload.type === 'string' && payload.data) {
        this.handlers.onLive(payload);
      }
    });
    channel.join();

    this.socket = socket;
    this.channel = channel;
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
    this.channel?.leave();
    this.socket?.disconnect();
    this.channel = null;
    this.socket = null;
  }
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
