import { OpenDeskError } from './errors';
import type {
  Attachment,
  Conversation,
  Identity,
  Message,
  SendMessageInput,
  StartConversationInput,
  UploadFile,
  WidgetConfig,
  WidgetSession,
} from './types';

export type Fetcher = typeof fetch;

export interface OpenDeskApiOptions {
  /** The openDesk origin, e.g. `https://desk.example.com`. `/v1` is added. */
  baseUrl: string;
  /** The chat widget's public key (`wk_…`). */
  widgetKey: string;
  fetcher?: Fetcher;
}

/**
 * Thin REST client for openDesk's visitor endpoints. Holds the visitor token once a
 * session exists and sends it as `Authorization: Visitor <token>`.
 */
export class OpenDeskApi {
  readonly baseUrl: string;
  readonly widgetKey: string;
  visitorToken: string | null = null;
  private readonly fetcher: Fetcher;

  constructor(options: OpenDeskApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/widget\/v1\.js$/, '').replace(/\/+$/, '').replace(/\/v1$/, '');
    this.widgetKey = options.widgetKey;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  config(): Promise<WidgetConfig> {
    return this.request('GET', `/v1/widget/config?key=${encodeURIComponent(this.widgetKey)}`, undefined, false);
  }

  /** Starts a session, or resumes the current one when a visitor token is held. */
  async session(identity: Identity = {}): Promise<WidgetSession> {
    const session = await this.request<WidgetSession>(
      'POST',
      '/v1/widget/session',
      { key: this.widgetKey, ...(this.visitorToken ? { visitor_token: this.visitorToken } : {}), ...identity },
      false,
    );
    this.visitorToken = session.visitor_token;

    return session;
  }

  async endSession(): Promise<void> {
    if (this.visitorToken) {
      await this.request('DELETE', '/v1/widget/session');
    }
  }

  async conversations(): Promise<Conversation[]> {
    const response = await this.request<{ data: Conversation[] | null }>('GET', '/v1/widget/conversations');

    return response.data ?? [];
  }

  startConversation(input: StartConversationInput): Promise<{ conversation: Conversation; message: Message }> {
    return this.request('POST', '/v1/widget/conversations', input);
  }

  async messages(conversationId: string): Promise<Message[]> {
    const response = await this.request<{ data: Message[] | null }>(
      'GET',
      `/v1/widget/conversations/${encodeURIComponent(conversationId)}/messages`,
    );

    return response.data ?? [];
  }

  sendMessage(conversationId: string, input: SendMessageInput): Promise<Message> {
    return this.request('POST', `/v1/widget/conversations/${encodeURIComponent(conversationId)}/messages`, input);
  }

  async markSeen(conversationId: string): Promise<void> {
    await this.request('POST', `/v1/widget/conversations/${encodeURIComponent(conversationId)}/seen`, {});
  }

  /** Asks for a person after an AI answer. */
  async handoff(conversationId: string): Promise<void> {
    await this.request('POST', `/v1/widget/conversations/${encodeURIComponent(conversationId)}/handoff`, {});
  }

  /** Confirms or declines an action the AI proposed. */
  async decideAction(conversationId: string, actionId: string, decision: 'confirm' | 'decline'): Promise<void> {
    await this.request(
      'POST',
      `/v1/widget/conversations/${encodeURIComponent(conversationId)}/actions/${encodeURIComponent(actionId)}`,
      { decision },
    );
  }

  async rateMessage(conversationId: string, messageId: string, rating: 'up' | 'down'): Promise<void> {
    await this.request(
      'POST',
      `/v1/widget/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/rating`,
      { rating },
    );
  }

  /**
   * Uploads one file as multipart `file`. React Native's FormData takes `{ uri, name, type }`;
   * a browser needs a real Blob, so web Files are passed through as they are.
   */
  upload(file: UploadFile): Promise<Attachment> {
    const form = new FormData();
    if (isBlob(file)) {
      form.append('file', file, 'name' in file && typeof file.name === 'string' ? file.name : 'upload');
    } else {
      form.append('file', { uri: file.uri, name: file.name, type: file.type || 'application/octet-stream' } as unknown as Blob);
    }

    return this.request('POST', '/v1/widget/attachments', form);
  }

  private async request<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let payload: BodyInit | undefined;

    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    if (authenticated && this.visitorToken) {
      headers.Authorization = `Visitor ${this.visitorToken}`;
    }

    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, { method, headers, body: payload });
    } catch {
      throw new OpenDeskError(0, 'network_error', "Can't reach the server");
    }

    if (!response.ok) {
      let code = 'error';
      let message = `Request failed (${response.status})`;
      try {
        const problem = (await response.json()) as { code?: string; detail?: string; title?: string };
        code = problem.code ?? code;
        message = problem.detail || problem.title || message;
      } catch {
        // Not a problem+json body.
      }
      throw new OpenDeskError(response.status, code, message);
    }

    if (response.status === 204 || !(response.headers.get('content-type') ?? '').includes('json')) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function isBlob(file: UploadFile): file is Blob {
  return typeof Blob !== 'undefined' && file instanceof Blob;
}
