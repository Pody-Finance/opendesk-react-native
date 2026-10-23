/**
 * Wire types for openDesk's visitor-facing widget API (`/v1/widget/*`), taken from
 * openDesk's OpenAPI document. Only the fields a chat client needs are listed.
 */

export type ConversationStatus = 'open' | 'pending' | 'on_hold' | 'solved' | 'closed';

export interface WidgetConfig {
  workspace_name: string;
  title: string;
  subtitle: string;
  greeting: string;
  intro: string;
  offline_message: string;
  brand_color: string;
  brand: { name: string; color: string };
  theme: 'auto' | 'light' | 'dark';
  radius: 'square' | 'soft' | 'round';
  locale: string;
  language: string;
  open: boolean;
  require_email: boolean;
  chat_welcome: boolean;
  help_center_url: string;
  avatar_url: string | null;
  attachments: boolean;
  attachment_extensions: string[] | null;
  voice_messages: boolean;
  voice_max_seconds: number;
  ai_answers: boolean;
  suggestions: string[] | null;
  topics: { id: string; label: string }[] | null;
  team: { name: string; avatar_url: string | null }[] | null;
  bot: { id: string; name: string; role: string; avatar_url: string; greeting: string; look?: BotLook | null } | null;
}

export interface ContactRef {
  id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
}

export interface UserRef {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

export interface BotRef {
  id: string;
  name: string;
  avatar_url: string;
  look?: BotLook | null;
}

/** How the widget draws a bot that has no uploaded image. */
export interface BotLook {
  kind?: 'built' | 'emoji' | 'image';
  shape?: 'blob' | 'circle' | 'rounded' | 'squircle' | 'hexagon' | 'cloud';
  fill?: { type?: 'solid' | 'gradient'; color?: string; to?: string };
  eyes?: string;
  mouth?: string;
  emoji?: string;
}

export interface WidgetSession {
  visitor_token: string;
  contact: ContactRef;
  ws_token: string;
  gateway_url: string;
}

/**
 * A verified identity: `user_hash` is hex(HMAC-SHA256(widget_secret, user_id)) and must be
 * computed on your server, never in the app.
 */
export interface Identity {
  user_id?: string;
  user_hash?: string;
  email?: string;
  name?: string;
  avatar_url?: string;
}

export interface Conversation {
  id: string;
  subject: string;
  status: ConversationStatus;
  last_message_at: string;
  last_message_preview: string;
  ai_handoff: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  inline: boolean;
  url: string;
}

export interface AIAction {
  id: string;
  status: 'pending' | 'confirmed' | 'declined' | 'expired' | 'failed';
  title: string;
  summary: string;
  tool: string;
}

export interface Message {
  id: string;
  ticket_id: string;
  kind: 'reply' | 'note';
  direction: 'inbound' | 'outbound';
  author: {
    type: 'contact' | 'user' | 'system' | 'api';
    contact?: ContactRef | null;
    user?: UserRef | null;
    bot?: BotRef | null;
  };
  body_text: string;
  body_html: string;
  attachments: Attachment[] | null;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  ai?: boolean;
  ai_action?: AIAction | null;
  ai_rating?: 'up' | 'down' | '';
  /**
   * Set by the SDK, not openDesk: a render key that stays the same when the optimistic copy
   * or the streaming AI answer is replaced by the stored message. Use `client_id ?? id` as a key.
   */
  client_id?: string;
}

/** A file picked on the device, in the shape React Native's FormData expects. */
export interface LocalFile {
  uri: string;
  name: string;
  type: string;
  /** Bytes, when the picker reports it; shown before the upload finishes. */
  size?: number;
}

/** What `upload` accepts: a picked file on iOS/Android, or a `File`/`Blob` on the web. */
export type UploadFile = LocalFile | Blob;

export interface StartConversationInput {
  body?: string;
  attachment_ids?: string[];
  topic_id?: string;
  page_url?: string;
}

export interface SendMessageInput {
  body?: string;
  attachment_ids?: string[];
  page_url?: string;
}

/** The envelope the gateway pushes as `event` on `contact:<wid>:<contact_id>`. */
export interface RealtimeEvent {
  id: string;
  seq: number;
  type: string;
  visibility?: string;
  occurred_at: string;
  data: {
    ticket_id?: string;
    message_id?: string;
    message?: Message;
    [key: string]: unknown;
  };
}

/** Ephemeral AI streaming frames pushed as `live`. */
export interface LiveEvent {
  type: 'ai.reply.started' | 'ai.reply.delta' | 'ai.reply.tool' | 'ai.reply.ended' | string;
  data: {
    reply_id?: string;
    ticket_id?: string;
    text?: string;
    tool?: string;
    status?: string;
    message_id?: string;
    handoff?: boolean;
    action_id?: string;
    bot?: BotRef;
    [key: string]: unknown;
  };
}

export interface TypingEvent {
  ticket_id: string;
  user?: { name?: string } | null;
}
