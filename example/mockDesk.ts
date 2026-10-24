import type { Fetcher } from '../src/api';
import type { RealtimeChannel, RealtimeSocket, SocketFactory } from '../src/realtime';
import type { Attachment, Conversation, Message } from '../src/types';

/**
 * An in-memory openDesk for the preview: answers the widget REST calls and plays an agent
 * on the realtime channel (typing, AI streaming, a human reply) so the UI can be seen offline.
 * The config mirrors the shape a real `GET /v1/widget/config` returns.
 */
export function createMockDesk() {
  const channels = new Set<MockChannel>();
  /** Off: the socket stays connected but no frame reaches the app, like a refused join or a proxy that drops frames. */
  let realtimeDelivers = true;
  let seq = 0;
  let ids = 0;
  const now = () => new Date().toISOString();
  const agent = { id: 'u1', name: 'Sam Lee', email: 'sam@example.com', avatar_url: null };
  const bot = { id: 'b1', name: 'Acme Bot', avatar_url: '' };
  const uploads = new Map<string, Attachment>();
  const attached = (list: string[] | undefined) => (list ?? []).flatMap((id) => uploads.get(id) ?? []);

  const conversations: Conversation[] = [
    {
      id: 'c1',
      subject: 'Order confirmation',
      status: 'solved',
      last_message_at: minutesAgo(42),
      last_message_preview: 'Got it now, thanks!',
      ai_handoff: true,
    },
  ];
  const messages: Record<string, Message[]> = {
    c1: [
      msg('c1', 'inbound', "I placed an order this morning but haven't received a confirmation email.", minutesAgo(50)),
      msg('c1', 'outbound', 'Sorry about that, Jamie. I found your order and resent the confirmation. Can you check your inbox?', minutesAgo(45), { user: agent }),
      msg('c1', 'inbound', 'Got it now, thanks!', minutesAgo(42)),
    ],
  };

  function msg(
    ticket: string,
    direction: Message['direction'],
    body: string,
    at = now(),
    extra: Partial<Message['author']> & { ai?: boolean; ai_action?: Message['ai_action'] } = {},
  ): Message {
    const { ai, ai_action, ...author } = extra;

    return {
      id: `m${++ids}`,
      ticket_id: ticket,
      kind: 'reply',
      direction,
      author: { type: direction === 'inbound' ? 'contact' : author.bot ? 'system' : 'user', ...author },
      body_text: body,
      body_html: '',
      attachments: null,
      created_at: at,
      ai,
      ai_action,
    };
  }

  function push(event: string, payload: object) {
    if (realtimeDelivers) {
      channels.forEach((channel) => channel.emit(event, payload));
    }
  }

  function deliver(message: Message, type = 'message.created') {
    const list = messages[message.ticket_id] ?? [];
    messages[message.ticket_id] = list.some((m) => m.id === message.id)
      ? list.map((m) => (m.id === message.id ? message : m))
      : [...list, message];
    const conversation = conversations.find((c) => c.id === message.ticket_id);
    if (conversation && type === 'message.created') {
      conversation.last_message_at = message.created_at;
      conversation.last_message_preview = message.body_text.slice(0, 140);
    }
    push('event', { id: `e${++seq}`, seq, type, occurred_at: now(), data: { ticket_id: message.ticket_id, message } });
  }

  /** The bot checks the help center, streams an answer word by word, then the stored message lands. */
  async function aiAnswer(ticket: string, text: string) {
    const replyId = `r${++seq}`;
    push('live', { type: 'ai.reply.started', data: { reply_id: replyId, ticket_id: ticket, bot } });
    await sleep(500);
    push('live', { type: 'ai.reply.tool', data: { reply_id: replyId, ticket_id: ticket, tool: 'help_center' } });
    await sleep(1100);
    push('live', { type: 'ai.reply.tool', data: { reply_id: replyId, ticket_id: ticket, tool: 'help_center', status: 'done' } });
    for (const word of text.split(/(?<= )/)) {
      push('live', { type: 'ai.reply.delta', data: { reply_id: replyId, ticket_id: ticket, text: word } });
      await sleep(40);
    }
    const message = msg(ticket, 'outbound', text, now(), { bot, ai: true });
    push('live', { type: 'ai.reply.ended', data: { reply_id: replyId, ticket_id: ticket, message_id: message.id } });
    deliver(message);
  }

  async function agentReply(ticket: string, text: string) {
    push('typing', { ticket_id: ticket, user: { name: agent.name } });
    await sleep(1800);
    deliver(msg(ticket, 'outbound', text, now(), { user: agent }));
  }

  const latestConversation = () => conversations[0]?.id ?? 'c1';

  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    await sleep(120);

    if (path === '/v1/widget/attachments' && init?.body instanceof FormData) {
      const file = init.body.get('file');
      if (!(file instanceof Blob)) {
        return json({ status: 422, title: 'Unprocessable', detail: 'file is required' }, 422);
      }
      await sleep(600);
      const attachment: Attachment = {
        id: `att${++ids}`,
        filename: file instanceof File ? file.name : 'upload',
        content_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        inline: false,
        url: URL.createObjectURL(file),
      };
      uploads.set(attachment.id, attachment);

      return json(attachment, 201);
    }

    if (path === '/v1/widget/config') {
      return json({
        workspace_name: 'Acme',
        title: 'Acme',
        subtitle: '',
        greeting: 'Hi! How can we help?',
        intro: '',
        offline_message: '',
        brand_color: '#111111',
        brand: { name: 'Acme', color: '#111111' },
        theme: 'auto',
        radius: 'soft',
        open: true,
        chat_welcome: true,
        help_center_url: 'https://example.com/help',
        avatar_url: null,
        attachments: true,
        attachment_extensions: ['.png', '.jpg', '.jpeg', '.pdf'],
        ai_answers: true,
        bot: { id: bot.id, name: bot.name, role: '', avatar_url: '', greeting: '' },
        team: [{ name: 'Sam Lee', avatar_url: null }],
        topics: [],
        suggestions: [],
      });
    }
    if (path === '/v1/widget/session') {
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      return json({
        visitor_token: 'od_vis_preview',
        contact: { id: 'contact-1', name: body.name ?? 'Jamie Rivera', email: body.email ?? null, avatar_url: null },
        ws_token: `x.${btoa(JSON.stringify({ wid: 'ws-preview' }))}.y`,
        gateway_url: 'wss://preview.invalid/socket/widget',
      });
    }
    if (path === '/v1/widget/conversations' && method === 'GET') {
      return json({ data: conversations });
    }
    if (path === '/v1/widget/conversations' && method === 'POST') {
      const id = `c${conversations.length + 1}`;
      const first = { ...msg(id, 'inbound', body.body ?? ''), attachments: attached(body.attachment_ids) };
      const conversation: Conversation = {
        id,
        subject: body.body?.slice(0, 40) || 'New conversation',
        status: 'open',
        last_message_at: first.created_at,
        last_message_preview: first.body_text,
        ai_handoff: false,
      };
      conversations.unshift(conversation);
      messages[id] = [first];
      void aiAnswer(
        id,
        "Thanks for reaching out. Order confirmations usually arrive within 10 minutes. If yours hasn't, check your spam folder or share your order number and I'll look it up.",
      );

      return json({ conversation, message: first }, 201);
    }

    const thread = path.match(/^\/v1\/widget\/conversations\/([^/]+)\/(messages|seen|handoff|actions\/[^/]+)$/);
    if (thread) {
      const [, id, action] = thread as unknown as [string, string, string];
      if (action === 'messages' && method === 'GET') {
        return json({ data: messages[id] ?? [] });
      }
      if (action === 'messages') {
        const sent = { ...msg(id, 'inbound', body.body ?? ''), attachments: attached(body.attachment_ids) };
        messages[id] = [...(messages[id] ?? []), sent];
        void agentReply(id, 'Thanks, give me a moment to check that for you.');

        return json(sent, 201);
      }
      if (action === 'handoff') {
        const conversation = conversations.find((c) => c.id === id);
        if (conversation) {
          conversation.ai_handoff = true;
        }
        void agentReply(id, "Hi Jamie, I'm Sam from the support team. I'm picking this up now.");
      }
      if (action.startsWith('actions/')) {
        const actionId = action.slice('actions/'.length);
        const target = (messages[id] ?? []).find((m) => m.ai_action?.id === actionId);
        if (target?.ai_action) {
          deliver({ ...target, ai_action: { ...target.ai_action, status: body.decision === 'confirm' ? 'confirmed' : 'declined' } }, 'message.updated');
        }
      }

      return new Response(null, { status: 204 });
    }

    return json({ status: 404, title: 'Not found' }, 404);
  };

  const socketFactory: SocketFactory = () => new MockSocket(channels);

  return {
    fetcher,
    socketFactory,
    setRealtimeDelivers: (value: boolean) => {
      realtimeDelivers = value;
    },
    simulateAgentReply: () =>
      deliver(msg(latestConversation(), 'outbound', 'Quick follow-up: your order has shipped and should arrive on Friday.', now(), { user: agent })),
    simulateAction: () =>
      deliver(
        msg(latestConversation(), 'outbound', 'I can resend the confirmation email to jamie@example.com.', now(), {
          bot,
          ai: true,
          ai_action: {
            id: `act${++ids}`,
            status: 'pending',
            title: 'Resend order confirmation',
            summary: 'Sends the confirmation for order #1042 to jamie@example.com.',
            tool: 'resend_confirmation',
          },
        }),
      ),
  };
}

class MockChannel implements RealtimeChannel {
  private handlers: Record<string, (payload: any) => void> = {};

  constructor(private readonly registry: Set<MockChannel>) {}

  on(event: string, callback: (payload: any) => void) {
    this.handlers[event] = callback;
  }

  join() {
    this.registry.add(this);
  }

  leave() {
    this.registry.delete(this);
  }

  push() {}

  emit(event: string, payload: unknown) {
    this.handlers[event]?.(payload);
  }
}

class MockSocket implements RealtimeSocket {
  private opened: (() => void)[] = [];

  constructor(private readonly registry: Set<MockChannel>) {}

  onOpen(callback: () => void) {
    this.opened.push(callback);
  }

  onClose() {}

  onError() {}

  connect() {
    setTimeout(() => this.opened.forEach((callback) => callback()), 50);
  }

  disconnect() {}

  channel() {
    return new MockChannel(this.registry);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}
