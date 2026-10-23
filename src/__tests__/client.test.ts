import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenDesk } from '../client';
import { OpenDeskError } from '../errors';
import { jwtClaim, type RealtimeChannel, type RealtimeSocket, type SocketFactory } from '../realtime';
import { memoryStorage } from '../storage';
import type { Message } from '../types';

const BASE = 'https://desk.test';
const KEY = 'wk_test';

function jwt(claims: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${encode({ alg: 'HS256' })}.${encode(claims)}.sig`;
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    ticket_id: 'c1',
    kind: 'reply',
    direction: 'outbound',
    author: { type: 'user', user: { id: 'u1', name: 'Sam', email: 'sam@example.com', avatar_url: null } },
    body_text: 'Hello',
    body_html: '<p>Hello</p>',
    attachments: null,
    created_at: '2026-10-23T10:00:00Z',
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

class FakeServer {
  calls: Call[] = [];
  tokens = 0;
  wsTokens = 0;
  revoked = new Set<string>();
  conversations = [
    { id: 'c1', subject: 'Wallet', status: 'open', last_message_at: '2026-10-23T09:00:00Z', last_message_preview: 'Hi', ai_handoff: false },
  ];
  messages: Message[] = [message({ id: 'm0', direction: 'inbound', author: { type: 'contact' }, created_at: '2026-10-23T09:00:00Z' })];
  failNextSend = false;

  fetcher = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.slice(BASE.length);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    this.calls.push({ method: init.method ?? 'GET', path, headers, body });
    const visitor = headers.Authorization?.replace('Visitor ', '');

    if (path.startsWith('/v1/widget/config')) {
      return json({ workspace_name: 'Acme', brand_color: '#123456', greeting: 'Hi' });
    }
    if (path === '/v1/widget/session' && init.method === 'POST') {
      if (body.visitor_token && this.revoked.has(body.visitor_token)) {
        return problem(401, 'invalid_visitor');
      }
      const token = body.visitor_token ?? `od_vis_${++this.tokens}`;

      return json({
        visitor_token: token,
        contact: { id: 'contact-1', name: body.name ?? '', email: body.email ?? null, avatar_url: null },
        ws_token: jwt({ wid: 'ws-1', typ: 'widget_ws', n: ++this.wsTokens }),
        gateway_url: 'wss://desk.test/socket/widget',
      });
    }
    if (visitor && this.revoked.has(visitor)) {
      return problem(401, 'invalid_visitor');
    }
    if (path === '/v1/widget/session' && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/widget/conversations' && init.method === 'GET') {
      return json({ data: this.conversations });
    }
    if (path === '/v1/widget/conversations' && init.method === 'POST') {
      return json(
        {
          conversation: { id: 'c2', subject: '', status: 'open', last_message_at: '2026-10-23T11:00:00Z', last_message_preview: body.body, ai_handoff: false },
          message: message({ id: 'm9', ticket_id: 'c2', direction: 'inbound', body_text: body.body }),
        },
        201,
      );
    }
    if (path === '/v1/widget/conversations/c1/messages' && init.method === 'GET') {
      return json({ data: this.messages });
    }
    if (path === '/v1/widget/conversations/c1/messages' && init.method === 'POST') {
      if (this.failNextSend) {
        this.failNextSend = false;

        return problem(422, 'invalid', 'Body is required');
      }

      return json(message({ id: 'm-sent', direction: 'inbound', body_text: body.body, author: { type: 'contact' } }), 201);
    }
    if (path === '/v1/widget/attachments' && init.method === 'POST') {
      return json({ id: 'att1', filename: 'receipt.png', content_type: 'image/png', size_bytes: 3, inline: false, url: 'https://desk.test/f/att1' }, 201);
    }
    if (path.endsWith('/seen') || path.endsWith('/handoff')) {
      return new Response(null, { status: 204 });
    }

    return problem(404, 'not_found');
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function problem(status: number, code: string, detail = ''): Response {
  return new Response(JSON.stringify({ status, title: 'Error', code, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

class FakeChannel implements RealtimeChannel {
  handlers: Record<string, (payload: any) => void> = {};
  pushes: { event: string; payload: object }[] = [];
  joined = false;

  constructor(readonly topic: string) {}

  on(event: string, callback: (payload: any) => void) {
    this.handlers[event] = callback;
  }

  join() {
    this.joined = true;
  }

  leave() {
    this.joined = false;
  }

  push(event: string, payload: object) {
    this.pushes.push({ event, payload });
  }

  emit(event: string, payload: unknown) {
    this.handlers[event]?.(payload);
  }
}

class FakeSocket implements RealtimeSocket {
  channels: FakeChannel[] = [];
  callbacks: Record<'open' | 'close' | 'error', (() => void)[]> = { open: [], close: [], error: [] };
  connected = false;

  constructor(
    readonly url: string,
    readonly params: () => { token: string },
  ) {}

  onOpen(callback: () => void) {
    this.callbacks.open.push(callback);
  }

  onClose(callback: () => void) {
    this.callbacks.close.push(callback);
  }

  onError(callback: () => void) {
    this.callbacks.error.push(callback);
  }

  connect() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }

  channel(topic: string) {
    const channel = new FakeChannel(topic);
    this.channels.push(channel);

    return channel;
  }
}

let server: FakeServer;
let sockets: FakeSocket[];
let socketFactory: SocketFactory;

beforeEach(() => {
  server = new FakeServer();
  sockets = [];
  socketFactory = (url, params) => {
    const socket = new FakeSocket(url, params);
    sockets.push(socket);

    return socket;
  };
});

function makeClient(storage = memoryStorage()): OpenDesk {
  return new OpenDesk({ baseUrl: `${BASE}/widget/v1.js`, widgetKey: KEY, storage, fetcher: server.fetcher as any, socketFactory });
}

function channel(): FakeChannel {
  const socket = sockets[sockets.length - 1]!;

  return socket.channels[socket.channels.length - 1]!;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('boot', () => {
  it('loads config, opens a session, persists the token and joins the contact topic', async () => {
    const storage = memoryStorage();
    const client = makeClient(storage);

    await client.boot();

    const state = client.getState();
    expect(state.status).toBe('ready');
    expect(state.config?.workspace_name).toBe('Acme');
    expect(state.conversations).toHaveLength(1);
    expect(await storage.getItem(`opendesk.visitor.${KEY}`)).toBe('od_vis_1');
    expect(channel().topic).toBe('contact:ws-1:contact-1');
    expect(channel().joined).toBe(true);
    expect(sockets[0]!.url).toBe('wss://desk.test/socket/widget');
    expect(server.calls.find((c) => c.path === '/v1/widget/conversations')?.headers.Authorization).toBe('Visitor od_vis_1');
  });

  it('resumes the stored visitor token', async () => {
    const storage = memoryStorage();
    await storage.setItem(`opendesk.visitor.${KEY}`, 'od_vis_saved');

    await makeClient(storage).boot();

    expect(server.calls.find((c) => c.path === '/v1/widget/session')?.body.visitor_token).toBe('od_vis_saved');
  });

  it('starts a fresh session when the stored token was revoked', async () => {
    const storage = memoryStorage();
    await storage.setItem(`opendesk.visitor.${KEY}`, 'od_vis_old');
    server.revoked.add('od_vis_old');

    const client = makeClient(storage);
    await client.boot();

    expect(client.api.visitorToken).toBe('od_vis_1');
    expect(await storage.getItem(`opendesk.visitor.${KEY}`)).toBe('od_vis_1');
  });

  it('sends the verified identity with the session request', async () => {
    const client = makeClient();
    await client.identify({ user_id: 'user-42', user_hash: 'abc', email: 'ada@example.com', name: 'Ada' });
    await client.boot();

    expect(server.calls.find((c) => c.path === '/v1/widget/session')?.body).toMatchObject({
      key: KEY,
      user_id: 'user-42',
      user_hash: 'abc',
      email: 'ada@example.com',
      name: 'Ada',
    });
  });

  it('reports an error state when openDesk is unreachable', async () => {
    const client = new OpenDesk({
      baseUrl: BASE,
      widgetKey: KEY,
      fetcher: (async () => {
        throw new TypeError('Network request failed');
      }) as any,
      socketFactory,
    });

    await expect(client.boot()).rejects.toBeInstanceOf(OpenDeskError);
    expect(client.getState()).toMatchObject({ status: 'error', error: "Can't reach the server" });
  });
});

describe('identity', () => {
  it('drops the previous visitor when a different user signs in', async () => {
    const storage = memoryStorage();
    const client = makeClient(storage);
    await client.identify({ user_id: 'user-1', user_hash: 'h1' });
    await client.boot();
    expect(client.api.visitorToken).toBe('od_vis_1');

    await client.identify({ user_id: 'user-2', user_hash: 'h2' });

    const sessions = server.calls.filter((c) => c.path === '/v1/widget/session' && c.method === 'POST');
    expect(sessions[sessions.length - 1]!.body.visitor_token).toBeUndefined();
    expect(sessions[sessions.length - 1]!.body.user_id).toBe('user-2');
    expect(client.api.visitorToken).toBe('od_vis_2');
  });

  it('keeps the visitor when the same user re-identifies', async () => {
    const client = makeClient();
    await client.identify({ user_id: 'user-1', user_hash: 'h1' });
    await client.boot();

    await client.identify({ user_id: 'user-1', user_hash: 'h1', name: 'Ada' });

    const sessions = server.calls.filter((c) => c.path === '/v1/widget/session' && c.method === 'POST');
    expect(sessions[sessions.length - 1]!.body).toMatchObject({ visitor_token: 'od_vis_1', name: 'Ada' });
  });

  it('shutdown ends the session and forgets the token', async () => {
    const storage = memoryStorage();
    const client = makeClient(storage);
    await client.boot();

    await client.shutdown();

    expect(server.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/widget/session')).toBe(true);
    expect(await storage.getItem(`opendesk.visitor.${KEY}`)).toBeNull();
    expect(client.getState().status).toBe('idle');
    expect(client.getState().conversations).toEqual([]);
    expect(sockets[0]!.connected).toBe(false);
  });
});

describe('messages', () => {
  it('shows a sent message at once and swaps in the server copy', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    const sending = client.sendMessage('c1', { body: 'Where is my deposit?' });
    const optimistic = client.getState().messages.c1!;
    expect(optimistic[optimistic.length - 1]!.id).toMatch(/^local-/);

    await sending;

    const ids = client.getState().messages.c1!.map((m) => m.id);
    expect(ids).toContain('m-sent');
    expect(ids.some((id) => id.startsWith('local-'))).toBe(false);
  });

  it('does not duplicate a message that arrives over the socket before the POST returns', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    const sending = client.sendMessage('c1', { body: 'Hi' });
    channel().emit('event', {
      type: 'message.created',
      data: { ticket_id: 'c1', message: message({ id: 'm-sent', direction: 'inbound', author: { type: 'contact' } }) },
    });
    await sending;

    expect(client.getState().messages.c1!.filter((m) => m.id === 'm-sent')).toHaveLength(1);
  });

  it('keeps the optimistic render key on the stored message', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    const sending = client.sendMessage('c1', { body: 'Where is my deposit?' });
    const localId = client.getState().messages.c1!.slice(-1)[0]!.id;
    await sending;

    expect(client.getState().messages.c1!.find((m) => m.id === 'm-sent')?.client_id).toBe(localId);
  });

  it('keeps the optimistic render key when the socket copy arrives first', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    const sending = client.sendMessage('c1', { body: 'Hi' });
    const localId = client.getState().messages.c1!.slice(-1)[0]!.id;
    channel().emit('event', {
      type: 'message.created',
      data: { ticket_id: 'c1', message: message({ id: 'm-sent', direction: 'inbound', body_text: 'Hi', author: { type: 'contact' } }) },
    });

    expect(client.getState().messages.c1!.some((m) => m.id === localId)).toBe(false);
    expect(client.getState().messages.c1!.find((m) => m.id === 'm-sent')?.client_id).toBe(localId);
    await sending;
    expect(client.getState().messages.c1!.find((m) => m.id === 'm-sent')?.client_id).toBe(localId);
  });

  it('keeps render keys across a full refresh', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');
    const localId = (await client.sendMessage('c1', { body: 'Hi' })) && client.getState().messages.c1!.slice(-1)[0]!.client_id;
    server.messages.push(message({ id: 'm-sent', direction: 'inbound', body_text: 'Hi', author: { type: 'contact' } }));

    await client.refreshMessages('c1');

    expect(client.getState().messages.c1!.find((m) => m.id === 'm-sent')?.client_id).toBe(localId);
  });

  it('removes the optimistic message when sending fails', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');
    server.failNextSend = true;

    await expect(client.sendMessage('c1', { body: '' })).rejects.toMatchObject({ status: 422, message: 'Body is required' });

    expect(client.getState().messages.c1!.some((m) => m.id.startsWith('local-'))).toBe(false);
  });

  it('starts a conversation and makes it active', async () => {
    const client = makeClient();
    await client.boot();

    const conversation = await client.startConversation({ body: 'New issue', topic_id: 't1' });

    expect(conversation.id).toBe('c2');
    expect(client.getState().activeConversationId).toBe('c2');
    expect(client.getState().conversations[0]!.id).toBe('c2');
    expect(server.calls.find((c) => c.method === 'POST' && c.path === '/v1/widget/conversations')?.body).toEqual({
      body: 'New issue',
      topic_id: 't1',
    });
  });

  it('marks the conversation handed off once a person is requested', async () => {
    const client = makeClient();
    await client.boot();

    await client.requestHuman('c1');

    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/v1/widget/conversations/c1/handoff')).toBe(true);
    expect(client.getState().conversations[0]!.ai_handoff).toBe(true);
  });

  it('re-opens the session once when the visitor token is revoked mid-session', async () => {
    const client = makeClient();
    await client.boot();
    server.revoked.add('od_vis_1');

    const conversations = await client.loadConversations();

    expect(conversations).toHaveLength(1);
    expect(client.api.visitorToken).toBe('od_vis_2');
  });
});

describe('realtime', () => {
  it('counts agent replies as unread when the conversation is not open and notifies listeners', async () => {
    const client = makeClient();
    await client.boot();
    const listener = vi.fn();
    client.onMessage(listener);

    channel().emit('event', { type: 'message.created', data: { ticket_id: 'c1', message: message({ id: 'm5' }) } });

    expect(client.unreadCount).toBe(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', from: 'Sam' }));
    expect(client.getState().conversations[0]!.last_message_preview).toBe('Hello');

    await client.openConversation('c1');
    expect(client.unreadCount).toBe(0);
  });

  it('marks replies seen instead of unread while the conversation is open', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    channel().emit('event', { type: 'message.created', data: { ticket_id: 'c1', message: message({ id: 'm6' }) } });
    await flush();

    expect(client.unreadCount).toBe(0);
    expect(server.calls.filter((c) => c.path === '/v1/widget/conversations/c1/seen')).toHaveLength(2);
  });

  it('ignores internal notes and applies withdrawals', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');

    channel().emit('event', { type: 'message.created', data: { ticket_id: 'c1', message: message({ id: 'n1', kind: 'note' }) } });
    expect(client.getState().messages.c1!.some((m) => m.id === 'n1')).toBe(false);

    channel().emit('event', { type: 'message.withdrawn', data: { ticket_id: 'c1', message_id: 'm0' } });
    expect(client.getState().messages.c1!.some((m) => m.id === 'm0')).toBe(false);
  });

  it('streams AI replies and clears them when the message lands', async () => {
    const client = makeClient();
    await client.boot();

    channel().emit('live', { type: 'ai.reply.started', data: { reply_id: 'r1', ticket_id: 'c1', bot: { id: 'b', name: 'Acme Bot', avatar_url: '' } } });
    channel().emit('live', { type: 'ai.reply.delta', data: { reply_id: 'r1', ticket_id: 'c1', text: 'Your wallet ' } });
    channel().emit('live', { type: 'ai.reply.tool', data: { reply_id: 'r1', ticket_id: 'c1', tool: 'get_wallet' } });
    channel().emit('live', { type: 'ai.reply.delta', data: { reply_id: 'r1', ticket_id: 'c1', text: 'is funded.' } });

    expect(client.getState().aiReplies.r1).toMatchObject({
      text: 'Your wallet is funded.',
      phase: 'streaming',
      tools: [{ name: 'get_wallet', status: 'running' }],
      bot: { name: 'Acme Bot' },
    });

    channel().emit('live', { type: 'ai.reply.ended', data: { reply_id: 'r1', ticket_id: 'c1', message_id: 'm-ai' } });
    expect(client.getState().aiReplies.r1).toMatchObject({ phase: 'done', messageId: 'm-ai', tools: [{ status: 'done' }] });

    channel().emit('event', { type: 'message.created', data: { ticket_id: 'c1', message: message({ id: 'm-ai', ai: true }) } });
    expect(client.getState().aiReplies.r1).toBeUndefined();
    expect(client.getState().messages.c1!.find((m) => m.id === 'm-ai')?.client_id).toBe('ai-r1');
  });

  it('shows and expires agent typing', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      await client.boot();

      channel().emit('typing', { ticket_id: 'c1', user: { name: 'Sam' } });
      expect(client.getState().typing.c1).toBe('Sam');

      vi.advanceTimersByTime(6001);
      expect(client.getState().typing.c1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles visitor typing pushes', async () => {
    const client = makeClient();
    await client.boot();

    client.typing('c1');
    client.typing('c1');

    expect(channel().pushes).toEqual([{ event: 'typing', payload: { ticket_id: 'c1' } }]);
  });

  it('refreshes the socket token after a drop and catches up on reconnect', async () => {
    const client = makeClient();
    await client.boot();
    const socket = sockets[0]!;
    const before = socket.params().token;
    const conversationCalls = () => server.calls.filter((c) => c.path === '/v1/widget/conversations').length;
    const callsBefore = conversationCalls();

    socket.callbacks.close.forEach((cb) => cb());
    expect(client.getState().connected).toBe(false);
    await flush();
    await flush();
    expect(server.calls.filter((c) => c.path === '/v1/widget/session').length).toBe(2);
    expect(socket.params().token).not.toBe(before);

    socket.callbacks.open.forEach((cb) => cb());
    await flush();
    expect(client.getState().connected).toBe(true);
    expect(conversationCalls()).toBe(callsBefore + 1);
  });
});

describe('attachments', () => {
  it('uploads a web File as multipart `file` with the visitor token', async () => {
    const client = makeClient();
    await client.boot();

    const attachment = await client.upload(new File(['png'], 'receipt.png', { type: 'image/png' }));

    const call = server.calls.find((c) => c.path === '/v1/widget/attachments')!;
    expect(attachment.id).toBe('att1');
    expect(call.headers.Authorization).toBe('Visitor od_vis_1');
    expect(call.headers['Content-Type']).toBeUndefined();
    const file = (call.body as FormData).get('file') as File;
    expect(file.name).toBe('receipt.png');
    expect(file.type).toBe('image/png');
  });

  it('uploads a React Native picked file as { uri, name, type }', async () => {
    const appended: [string, unknown][] = [];
    const RealFormData = globalThis.FormData;
    globalThis.FormData = class {
      append(name: string, value: unknown) {
        appended.push([name, value]);
      }
    } as unknown as typeof FormData;
    try {
      const client = makeClient();
      await client.boot();

      await client.upload({ uri: 'file:///tmp/receipt.jpg', name: 'receipt.jpg', type: '' });
    } finally {
      globalThis.FormData = RealFormData;
    }

    expect(appended).toEqual([['file', { uri: 'file:///tmp/receipt.jpg', name: 'receipt.jpg', type: 'application/octet-stream' }]]);
  });

  it('shows uploaded attachments on the optimistic message', async () => {
    const client = makeClient();
    await client.boot();
    await client.openConversation('c1');
    const attachment = await client.upload(new File(['png'], 'receipt.png', { type: 'image/png' }));

    const sending = client.sendMessage('c1', { attachment_ids: [attachment.id] });
    const optimistic = client.getState().messages.c1!.slice(-1)[0]!;
    await sending;

    expect(optimistic.attachments).toEqual([attachment]);
    expect(server.calls.find((c) => c.method === 'POST' && c.path === '/v1/widget/conversations/c1/messages')?.body).toEqual({
      attachment_ids: ['att1'],
    });
  });

  it('surfaces a rejected upload as an OpenDeskError', async () => {
    const client = makeClient();
    await client.boot();
    server.fetcher.mockImplementationOnce(async () => problem(415, 'unsupported_type', 'This file type is not allowed'));

    await expect(client.upload(new File(['x'], 'a.exe'))).rejects.toMatchObject({ status: 415, message: 'This file type is not allowed' });
  });
});

describe('jwtClaim', () => {
  it('reads a claim from a base64url payload', () => {
    expect(jwtClaim(jwt({ wid: 'wörkspace-ü' }), 'wid')).toBe('wörkspace-ü');
  });

  it('returns null for malformed tokens', () => {
    expect(jwtClaim('nope', 'wid')).toBeNull();
    expect(jwtClaim('a.!!!.c', 'wid')).toBeNull();
  });
});
