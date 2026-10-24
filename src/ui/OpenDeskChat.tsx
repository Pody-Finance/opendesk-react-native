import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { AIReply } from '../client';
import { useConversation, useConversations, useOpenDesk, useOpenDeskState } from '../react';
import type { Attachment, Conversation, Message, UploadFile, WidgetConfig } from '../types';
import { BotFace } from './BotFace';
import { ArrowIcon, ChevronIcon, CloseIcon, PaperclipIcon, PersonIcon, SparkIcon } from './icons';
import { defaultStrings, format, type ChatStrings } from './strings';
import { makeTheme, type ChatTheme } from './theme';

export interface OpenDeskChatProps {
  /** Opens straight into this conversation instead of the home screen. */
  initialConversationId?: string;
  /** Shown as a close button in the header when given. */
  onClose?: () => void;
  /**
   * Lets the visitor attach a file. Wire it to your picker (expo-image-picker,
   * expo-document-picker…) and resolve `{ uri, name, type }`, a web `File`, or null when cancelled.
   * Without it the attach button is hidden.
   */
  pickAttachment?: () => Promise<UploadFile | null>;
  /** Overrides the widget's brand colour. */
  accentColor?: string;
  /** Overrides the widget's theme setting. */
  theme?: 'light' | 'dark' | 'auto';
  /** Replaces any of the built-in English strings. */
  strings?: Partial<ChatStrings>;
  /** Height of any navigation header above the chat, so the keyboard never covers the composer on iOS. */
  keyboardVerticalOffset?: number;
  /**
   * Safe-area insets, e.g. `useSafeAreaInsets()` from react-native-safe-area-context. `top` is
   * added inside the header, so its background runs under the status bar or notch; `bottom`
   * is added under the composer and the footer, clear of the home indicator.
   */
  insets?: { top?: number; bottom?: number };
  /** Styles the outer container, e.g. a background or margins. Use `insets` for the safe area. */
  style?: StyleProp<ViewStyle>;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const GROUP_GAP_MS = 5 * 60 * 1000;

/**
 * A drop-in support screen that mirrors openDesk's web widget: the home screen, the thread
 * with AI streaming, actions and handoff, and the composer with attachments.
 */
export function OpenDeskChat({
  initialConversationId,
  onClose,
  pickAttachment,
  accentColor,
  theme: themeSetting,
  strings: stringOverrides,
  keyboardVerticalOffset = 0,
  insets,
  style,
}: OpenDeskChatProps) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId ?? null);
  const [composing, setComposing] = useState(false);
  const config = useOpenDeskState((state) => state.config);
  const systemScheme = useColorScheme();
  const setting = themeSetting ?? config?.theme ?? 'auto';
  const scheme = setting === 'auto' ? (systemScheme === 'dark' ? 'dark' : 'light') : setting;
  const theme = useMemo(() => makeTheme(config, scheme, accentColor), [config, scheme, accentColor]);
  const strings = useMemo(() => ({ ...defaultStrings, ...stringOverrides }), [stringOverrides]);
  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;
  const styles = useMemo(() => createStyles(theme, insetTop, insetBottom), [theme, insetTop, insetBottom]);
  const ui = useMemo(() => ({ theme, strings, styles, bot: config?.bot ?? null }), [theme, strings, styles, config?.bot]);

  const inThread = conversationId !== null || composing;

  return (
    <KeyboardAvoidingView
      style={[styles.root, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      {inThread ? (
        <Thread
          ui={ui}
          conversationId={conversationId}
          pickAttachment={pickAttachment}
          onBack={() => {
            setConversationId(null);
            setComposing(false);
          }}
          onClose={onClose}
          onStarted={(id) => {
            setComposing(false);
            setConversationId(id);
          }}
        />
      ) : (
        <Home ui={ui} onClose={onClose} onOpen={setConversationId} onNew={() => setComposing(true)} />
      )}
    </KeyboardAvoidingView>
  );
}

interface Ui {
  theme: ChatTheme;
  strings: ChatStrings;
  styles: Styles;
  /** The widget's bot, for messages whose author carries no look of its own. */
  bot: WidgetConfig['bot'];
}

function subtitleFor(config: WidgetConfig | null, strings: ChatStrings): string {
  if (config?.subtitle) {
    return config.subtitle;
  }

  return config?.ai_answers && config.bot ? format(strings.replyTimeAi, { name: config.bot.name }) : strings.replyTime;
}

function Home({
  ui,
  onClose,
  onOpen,
  onNew,
}: {
  ui: Ui;
  onClose?: () => void;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { theme, strings, styles } = ui;
  const { conversations, ready, error } = useConversations();
  const unread = useOpenDeskState((state) => state.unread);
  const config = useOpenDeskState((state) => state.config);
  const name = config?.title || config?.workspace_name || strings.support;

  return (
    <View style={styles.flex}>
      <View style={[styles.head, styles.headHome]}>
        <View style={styles.headRow}>
          <View style={styles.ws}>
            <Glyph ui={ui} name={name} url={config?.avatar_url ?? null} />
            <Text style={styles.wsName} numberOfLines={1}>
              {name}
            </Text>
          </View>
          {onClose ? <IconButton ui={ui} label={strings.closeChat} onPress={onClose} icon={<CloseIcon color={theme.fg3} />} /> : null}
        </View>
        <Text style={styles.greet}>{config?.greeting || strings.greeting}</Text>
        <View style={styles.subRow}>
          <AvatarStack ui={ui} config={config} />
          <Text style={styles.sub}>{subtitleFor(config, strings)}</Text>
        </View>
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={styles.homeBody}>
        {!ready ? (
          error ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{strings.unavailable}</Text>
              <Text style={styles.emptyText}>{strings.unavailableHint}</Text>
            </View>
          ) : (
            <View style={[styles.card, styles.skeletonCard]}>
              <View style={[styles.skel, { width: '60%' }]} />
              <View style={[styles.skel, { width: '85%' }]} />
            </View>
          )
        ) : null}

        {ready && conversations.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardHead}>{strings.yourConversations}</Text>
            {conversations.map((conversation, index) => (
              <ConversationRow
                key={conversation.id}
                ui={ui}
                conversation={conversation}
                unread={unread[conversation.id] ?? 0}
                first={index === 0}
                onOpen={onOpen}
              />
            ))}
          </View>
        ) : null}

        {config?.open === false ? (
          <View style={styles.away}>
            <Text style={styles.awayText}>{config.offline_message || strings.offlineDefault}</Text>
          </View>
        ) : null}

        <Pressable accessibilityRole="button" onPress={onNew} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>{strings.sendMessage}</Text>
          <ArrowIcon color={theme.accentFg} size={15} />
        </Pressable>

        {config?.help_center_url ? (
          <View style={styles.card}>
            <Pressable
              accessibilityRole="link"
              onPress={() => Linking.openURL(config.help_center_url)}
              style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: theme.bg3 }]}
            >
              <Text style={styles.linkText}>{strings.searchHelp}</Text>
              <ArrowIcon color={theme.fg3} size={14} angle={-45} />
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      <Pressable accessibilityRole="link" onPress={() => Linking.openURL('https://opendesk.sh')} style={styles.foot}>
        <Text style={styles.footText}>{strings.poweredBy}</Text>
      </Pressable>
    </View>
  );
}

const ConversationRow = memo(function ConversationRow({
  ui,
  conversation,
  unread,
  first,
  onOpen,
}: {
  ui: Ui;
  conversation: Conversation;
  unread: number;
  first: boolean;
  onOpen: (id: string) => void;
}) {
  const { theme, strings, styles } = ui;
  const open = conversation.status === 'open' || conversation.status === 'pending';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onOpen(conversation.id)}
      style={({ pressed }) => [styles.conv, !first && styles.convBorder, pressed && { backgroundColor: theme.bg3 }]}
    >
      <View style={[styles.dot, open && { backgroundColor: theme.accent }]} />
      <View style={styles.convMain}>
        <View style={styles.convTop}>
          <Text style={[styles.convSubject, unread > 0 && styles.bold]} numberOfLines={1}>
            {conversation.subject || strings.conversation}
          </Text>
          <Text style={styles.time}>{relativeTime(conversation.last_message_at)}</Text>
        </View>
        <View style={styles.convTop}>
          <Text style={styles.convPrev} numberOfLines={1}>
            {conversation.last_message_preview || ' '}
          </Text>
          {unread > 0 ? (
            <View style={styles.unread}>
              <Text style={styles.unreadText}>{unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

type Row =
  | { kind: 'message'; key: string; message: Message; first: boolean; last: boolean; gap: boolean }
  | { kind: 'reply'; key: string; reply: AIReply }
  | { kind: 'day'; key: string; label: string }
  | { kind: 'typing'; key: string; name: string }
  | { kind: 'handed'; key: string };

function Thread({
  ui,
  conversationId,
  pickAttachment,
  onBack,
  onClose,
  onStarted,
}: {
  ui: Ui;
  conversationId: string | null;
  pickAttachment?: () => Promise<UploadFile | null>;
  onBack: () => void;
  onClose?: () => void;
  onStarted: (id: string) => void;
}) {
  const { theme, strings, styles } = ui;
  const client = useOpenDesk();
  const config = useOpenDeskState((state) => state.config);
  const { messages, aiReplies, typing, conversation } = useConversation(conversationId);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const topics = config?.topics ?? [];
  const topic = topics.find((t) => t.id === topicId) ?? null;
  const needsTopic = conversationId === null && topics.length > 0 && topic === null;
  const name = config?.title || config?.workspace_name || strings.support;
  const lastMessage = messages[messages.length - 1];
  const lastAiIndex = lastIndexWhere(messages, (m) => m.ai === true);
  const handedOff = conversation?.ai_handoff === true && !messages.slice(lastAiIndex + 1).some((m) => m.author.type === 'user');
  const handoffMessageId =
    conversation && !conversation.ai_handoff && aiReplies.length === 0 && lastMessage?.ai && lastMessage.direction === 'outbound'
      ? lastMessage.id
      : null;

  const rows = useMemo(() => buildRows(messages, aiReplies, typing, handedOff, strings), [messages, aiReplies, typing, handedOff, strings]);

  const decide = useCallback(
    (message: Message, decision: 'confirm' | 'decline') => {
      if (message.ai_action) {
        client.decideAction(message.ticket_id, message.ai_action.id, decision).catch(() => undefined);
      }
    },
    [client],
  );

  const requestHuman = useCallback(
    (message: Message) => {
      client.requestHuman(message.ticket_id).catch(() => setError(strings.handoffFailed));
    },
    [client, strings.handoffFailed],
  );

  const ready = (draft.trim().length > 0 || attachments.length > 0) && !sending && uploadingName === null && !needsTopic;

  const send = useCallback(async () => {
    if (!ready) {
      return;
    }
    const body = draft.trim();
    const attachmentIds = attachments.map((attachment) => attachment.id);
    setError(null);
    setDraft('');
    setAttachments([]);
    try {
      if (conversationId) {
        await client.sendMessage(conversationId, { ...(body ? { body } : {}), attachment_ids: attachmentIds });
      } else {
        setSending(true);
        const started = await client.startConversation({
          ...(body ? { body } : {}),
          attachment_ids: attachmentIds,
          ...(topicId ? { topic_id: topicId } : {}),
        });
        onStarted(started.id);
      }
    } catch (caught) {
      setDraft(body);
      setAttachments(attachments);
      setError(caught instanceof Error ? `${strings.notSent} ${caught.message}` : strings.notSent);
    } finally {
      setSending(false);
    }
  }, [attachments, client, conversationId, draft, onStarted, ready, strings.notSent, topicId]);

  const attach = useCallback(async () => {
    if (!pickAttachment) {
      return;
    }
    setError(null);
    let file: UploadFile | null;
    try {
      file = await pickAttachment();
    } catch {
      return;
    }
    if (!file) {
      return;
    }
    const fileName = 'name' in file && typeof file.name === 'string' ? file.name : 'file';
    const size = 'size' in file && typeof file.size === 'number' ? file.size : undefined;
    const allowed = config?.attachment_extensions;
    const dot = fileName.lastIndexOf('.');
    if (allowed && allowed.length > 0 && (dot < 1 || !allowed.includes(fileName.slice(dot).toLowerCase()))) {
      setError(format(strings.fileTypeRefused, { name: fileName }));

      return;
    }
    if (size !== undefined && size > MAX_UPLOAD_BYTES) {
      setError(format(strings.fileTooLarge, { name: fileName }));

      return;
    }
    setUploadingName(fileName);
    try {
      const uploaded = await client.upload(file);
      setAttachments((current) => [...current, uploaded]);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : format(strings.uploadFailed, { name: fileName }));
    } finally {
      setUploadingName(null);
    }
  }, [client, config?.attachment_extensions, pickAttachment, strings]);

  const showAttach = Boolean(pickAttachment) && config?.attachments !== false && (config?.attachment_extensions?.length ?? 1) > 0;
  const bot = config?.ai_answers ? config.bot : null;

  return (
    <View style={styles.flex}>
      <View style={styles.head}>
        <IconButton ui={ui} label={strings.back} onPress={onBack} icon={<ChevronIcon color={theme.fg3} direction="left" />} />
        {bot ? (
          <BotFace size={26} look={bot.look} avatarUrl={bot.avatar_url} />
        ) : (
          <Glyph ui={ui} name={name} url={config?.avatar_url ?? null} />
        )}
        <View style={styles.headMain}>
          <Text style={styles.title} numberOfLines={1}>
            {conversation?.subject || name}
          </Text>
          <Text style={styles.titleSub} numberOfLines={1}>
            {subtitleFor(config, strings)}
          </Text>
        </View>
        {onClose ? <IconButton ui={ui} label={strings.closeChat} onPress={onClose} icon={<CloseIcon color={theme.fg3} />} /> : null}
      </View>

      {rows.length === 0 ? (
        <ScrollView style={styles.flex} contentContainerStyle={styles.emptyScroll} keyboardShouldPersistTaps="handled">
          {needsTopic ? (
            <View style={[styles.card, styles.picker]}>
              <Text style={styles.pickerTitle}>{strings.topicsTitle}</Text>
              <Text style={styles.pickerHint}>{strings.topicsHint}</Text>
              {topics.map((item, index) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  onPress={() => setTopicId(item.id)}
                  style={({ pressed }) => [styles.topic, index > 0 && styles.convBorder, pressed && { backgroundColor: theme.bg2 }]}
                >
                  <Text style={styles.topicText}>{item.label}</Text>
                  <ChevronIcon color={theme.fg4} size={14} direction="right" />
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{config?.greeting || strings.greeting}</Text>
              <Text style={styles.emptyText}>{config?.intro || strings.emptyHint}</Text>
            </View>
          )}
        </ScrollView>
      ) : (
        <FlatList
          inverted
          style={styles.flex}
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.thread}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <ThreadRow
              ui={ui}
              row={item}
              showHandoff={item.kind === 'message' && item.message.id === handoffMessageId}
              onDecide={decide}
              onRequestHuman={requestHuman}
            />
          )}
        />
      )}

      <View style={styles.composer}>
        {topic && conversationId === null ? (
          <View style={styles.topicRow}>
            <View style={styles.topicChip}>
              <Text style={styles.topicChipText} numberOfLines={1}>
                {topic.label}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={strings.changeTopic}
                onPress={() => setTopicId(null)}
                style={styles.topicChipX}
              >
                <CloseIcon color={theme.fg3} size={10} />
              </Pressable>
            </View>
          </View>
        ) : null}

        {attachments.length > 0 || uploadingName ? (
          <View style={styles.pendingFiles}>
            {attachments.map((attachment) => (
              <View key={attachment.id} style={[styles.chip, styles.pendingChip]}>
                <Text style={styles.chipText} numberOfLines={1}>
                  {attachment.filename}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={format(strings.removeFile, { name: attachment.filename })}
                  onPress={() => setAttachments((current) => current.filter((a) => a.id !== attachment.id))}
                  hitSlop={8}
                >
                  <CloseIcon color={theme.fg3} size={10} />
                </Pressable>
              </View>
            ))}
            {uploadingName ? (
              <View style={[styles.chip, styles.pendingChip]}>
                <ActivityIndicator size="small" color={theme.fg3} style={styles.chipSpinner} />
                <Text style={styles.chipText} numberOfLines={1}>
                  {uploadingName}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {error ? <Text style={styles.err}>{error}</Text> : null}

        <View style={[styles.cbar, showAttach && styles.cbarLead, focused && styles.cbarFocus, needsTopic && styles.cbarOff]}>
          {showAttach ? (
            <IconButton
              ui={ui}
              label={strings.attach}
              onPress={attach}
              disabled={uploadingName !== null || needsTopic}
              icon={<PaperclipIcon color={theme.fg3} />}
            />
          ) : null}
          <TextInput
            style={[styles.input, { height: inputHeight }]}
            value={draft}
            onContentSizeChange={(event) => setInputHeight(Math.min(120, Math.max(30, Math.ceil(event.nativeEvent.contentSize.height))))}
            {...(Platform.OS === 'web' ? ({ rows: 1 } as object) : {})}
            editable={!needsTopic}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChangeText={(text) => {
              setDraft(text);
              if (conversationId) {
                client.typing(conversationId);
              }
            }}
            placeholder={needsTopic ? strings.placeholderTopic : strings.placeholder}
            placeholderTextColor={theme.fg4}
            accessibilityLabel={strings.placeholder}
            multiline
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.send}
            disabled={!ready}
            onPress={send}
            style={[styles.send, ready && styles.sendReady]}
          >
            <ArrowIcon color={theme.accentFg} size={14} angle={-90} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const ThreadRow = memo(function ThreadRow({
  ui,
  row,
  showHandoff,
  onDecide,
  onRequestHuman,
}: {
  ui: Ui;
  row: Row;
  showHandoff: boolean;
  onDecide: (message: Message, decision: 'confirm' | 'decline') => void;
  onRequestHuman: (message: Message) => void;
}) {
  const { theme, strings, styles } = ui;

  switch (row.kind) {
    case 'day':
      return <Text style={styles.day}>{row.label}</Text>;
    case 'typing':
      return (
        <View style={styles.typing}>
          <View style={styles.typingBubble}>
            <Dots color={theme.fg3} />
          </View>
          <Text style={styles.typingText}>{format(strings.typing, { name: row.name })}</Text>
        </View>
      );
    case 'handed':
      return (
        <View style={styles.handed}>
          <View style={styles.handedIc}>
            <PersonIcon color={theme.fg2} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.handedTitle}>{strings.handedOff}</Text>
            <Text style={styles.handedText}>{strings.handedOffHint}</Text>
          </View>
        </View>
      );
    case 'reply':
      return <Bubble ui={ui} reply={row.reply} first last gap showHandoff={false} onDecide={onDecide} onRequestHuman={onRequestHuman} />;
    case 'message':
      return (
        <Bubble
          ui={ui}
          message={row.message}
          first={row.first}
          last={row.last}
          gap={row.gap}
          showHandoff={showHandoff}
          onDecide={onDecide}
          onRequestHuman={onRequestHuman}
        />
      );
  }
});

/**
 * One bubble for a stored message or an AI answer still streaming. Both share one element
 * tree, so when the stored message replaces the stream (same row key) nothing remounts.
 */
function Bubble({
  ui,
  message,
  reply,
  first,
  last,
  gap,
  showHandoff,
  onDecide,
  onRequestHuman,
}: {
  ui: Ui;
  message?: Message;
  reply?: AIReply;
  first: boolean;
  last: boolean;
  gap: boolean;
  showHandoff: boolean;
  onDecide: (message: Message, decision: 'confirm' | 'decline') => void;
  onRequestHuman: (message: Message) => void;
}) {
  const { theme, strings, styles, bot: fallbackBot } = ui;
  const mine = message?.direction === 'inbound';
  const ai = reply !== undefined || message?.ai === true;
  const author = message ? message.author.user?.name || message.author.bot?.name : reply?.bot?.name;
  const bot = message ? message.author.bot : reply?.bot;
  const avatar = message ? (message.author.user?.avatar_url ?? bot?.avatar_url) : bot?.avatar_url;
  const botLook = bot?.look ?? fallbackBot?.look;
  const text = message ? (message.body_text ?? '') : (reply?.text ?? '');
  const local = message?.id.startsWith('local-') === true;
  const action = message?.ai_action;
  const tools = reply?.tools ?? [];
  const corners: ViewStyle = mine
    ? { borderBottomRightRadius: 4, ...(first ? {} : { borderTopRightRadius: 4 }) }
    : { borderBottomLeftRadius: 4, ...(first ? {} : { borderTopLeftRadius: 4 }) };
  const images = (message?.attachments ?? []).filter((a) => a.content_type.startsWith('image/'));
  const files = (message?.attachments ?? []).filter((a) => !a.content_type.startsWith('image/'));

  return (
    <View style={[styles.row, mine ? styles.rowMe : styles.rowThem, gap && styles.rowGap]}>
      {!mine && first && author ? (
        <View style={styles.who}>
          {ai ? (
            <BotFace size={18} look={botLook} avatarUrl={avatar} />
          ) : avatar ? (
            <Avatar ui={ui} size={18} name={author} url={avatar} tint={theme.bg2} />
          ) : null}
          <Text style={styles.whoName}>{author}</Text>
          {ai ? (
            <View style={styles.aiPill}>
              <Text style={styles.aiPillText}>{strings.ai}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {tools.length > 0 ? (
        <View style={styles.tools}>
          {tools.map((tool, index) => (
            <View key={`${tool.name}-${index}`} style={styles.tool}>
              <View style={[styles.toolIc, tool.status === 'error' && { backgroundColor: theme.bg2 }]}>
                <SparkIcon color={tool.status === 'error' ? theme.fg3 : theme.ai} size={8} />
              </View>
              <Text style={[styles.toolText, tool.status === 'running' && { color: theme.fg2 }]}>
                {format(tool.status === 'running' ? strings.checking : tool.status === 'error' ? strings.toolFailed : strings.checked, {
                  tool: tool.name.replace(/_/g, ' '),
                })}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {text || reply ? (
        <View
          style={[
            styles.msg,
            mine ? styles.msgMe : ai ? styles.msgAi : styles.msgThem,
            corners,
            local && styles.sendingMsg,
          ]}
        >
          {text ? <Text style={[styles.msgText, mine && { color: theme.accentFg }]}>{text}</Text> : <Dots color={theme.ai} />}
        </View>
      ) : null}

      {images.map((attachment) => (
        <Pressable key={attachment.id} onPress={() => Linking.openURL(attachment.url)} style={styles.fileGap}>
          <Image source={{ uri: attachment.url }} style={styles.thumb} accessibilityLabel={attachment.filename} resizeMode="cover" />
        </Pressable>
      ))}
      {files.map((attachment) => (
        <Pressable key={attachment.id} onPress={() => Linking.openURL(attachment.url)} style={[styles.chip, styles.fileGap]}>
          <Text style={styles.chipText} numberOfLines={1}>
            {attachment.filename}
          </Text>
          <Text style={styles.chipSize}>{fileSize(attachment.size_bytes)}</Text>
        </Pressable>
      ))}

      {message && action ? <ActionCard ui={ui} message={message} onDecide={onDecide} /> : null}

      {message && showHandoff ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onRequestHuman(message)}
          style={({ pressed }) => [styles.handoff, pressed && { backgroundColor: theme.bg2 }]}
        >
          <PersonIcon color={theme.fg} size={14} />
          <Text style={styles.handoffText}>{strings.talkToPerson}</Text>
        </Pressable>
      ) : null}

      {last && message ? <Text style={styles.meta}>{local ? strings.sending : clockTime(message.created_at)}</Text> : null}
    </View>
  );
}

function ActionCard({
  ui,
  message,
  onDecide,
}: {
  ui: Ui;
  message: Message;
  onDecide: (message: Message, decision: 'confirm' | 'decline') => void;
}) {
  const { theme, strings, styles } = ui;
  const action = message.ai_action!;
  const pending = action.status === 'pending';
  const label = {
    pending: strings.actionPending,
    confirmed: strings.actionConfirmed,
    declined: strings.actionDeclined,
    expired: strings.actionExpired,
    failed: strings.actionFailed,
  }[action.status];

  return (
    <View style={[styles.action, pending && styles.actionPending]}>
      <View style={styles.actionTop}>
        <View style={styles.actionTool}>
          <SparkIcon color={theme.ai} size={8} />
          <Text style={styles.actionToolText} numberOfLines={1}>
            {action.tool.replace(/_/g, ' ')}
          </Text>
        </View>
        <Text style={[styles.actionNeed, action.status === 'failed' && { color: theme.danger }]}>{label}</Text>
      </View>
      <Text style={styles.actionTitle}>{action.title}</Text>
      {action.summary ? <Text style={styles.actionSum}>{action.summary}</Text> : null}
      {pending ? (
        <View style={styles.actionBtns}>
          <Pressable onPress={() => onDecide(message, 'decline')} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>{strings.cancel}</Text>
          </Pressable>
          <Pressable onPress={() => onDecide(message, 'confirm')} style={[styles.btn, styles.btnSolid]}>
            <Text style={styles.btnSolidText}>{strings.confirm}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function IconButton({
  ui,
  label,
  onPress,
  icon,
  disabled,
}: {
  ui: Ui;
  label: string;
  onPress: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [ui.styles.iconBtn, pressed && { backgroundColor: ui.theme.bg2 }, disabled && ui.styles.disabled]}
    >
      {icon}
    </Pressable>
  );
}

function Glyph({ ui, name, url }: { ui: Ui; name: string; url: string | null }) {
  const { styles } = ui;

  return url ? (
    <Image source={{ uri: url }} style={styles.wsGlyph} />
  ) : (
    <View style={styles.wsGlyph}>
      <Text style={styles.wsGlyphText}>{name.trim().charAt(0).toUpperCase()}</Text>
    </View>
  );
}

function Avatar({
  ui,
  size,
  name,
  url,
  round,
  tint,
  style,
}: {
  ui: Ui;
  size: number;
  name: string;
  url: string | null | undefined;
  round?: boolean;
  tint: string;
  style?: StyleProp<ViewStyle>;
}) {
  const radius = round ? size / 2 : Math.min(ui.theme.radius.av, size / 2);

  return (
    <View
      style={[
        { width: size, height: size, borderRadius: radius, backgroundColor: tint, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} />
      ) : (
        <Text style={{ fontSize: size * 0.4, fontWeight: '600', color: ui.theme.fg2 }}>{initials(name)}</Text>
      )}
    </View>
  );
}

function AvatarStack({ ui, config }: { ui: Ui; config: WidgetConfig | null }) {
  const { theme } = ui;
  const ring = { borderWidth: 2, borderColor: theme.headBg };
  const team = (config?.team ?? []).slice(0, 3);
  const bot = config?.ai_answers ? config.bot : null;
  if (!bot && team.length === 0) {
    return null;
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {bot ? <BotFace size={22} look={bot.look} avatarUrl={bot.avatar_url} /> : null}
      {team.map((member, index) => (
        <Avatar
          key={`${member.name}-${index}`}
          ui={ui}
          size={22}
          name={member.name}
          url={member.avatar_url}
          tint={theme.bg2}
          style={[ring, { marginLeft: index === 0 && bot ? 1 : -7 }]}
        />
      ))}
    </View>
  );
}

/** Three dots that pulse in turn, like the widget's typing indicator. */
function Dots({ color }: { color: string }) {
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.stagger(
        160,
        values.map((value) =>
          Animated.sequence([
            Animated.timing(value, { toValue: 1, duration: 280, useNativeDriver: native }),
            Animated.timing(value, { toValue: 0.3, duration: 280, useNativeDriver: native }),
          ]),
        ),
      ),
    );
    loop.start();

    return () => loop.stop();
  }, [values]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: 19.5, gap: 3 }}>
      {values.map((opacity, index) => (
        <Animated.View key={index} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color, opacity }} />
      ))}
    </View>
  );
}

/** Newest first for the inverted list: typing, streaming answers, then messages grouped by author with day labels. */
function buildRows(messages: Message[], aiReplies: AIReply[], typing: string | null, handedOff: boolean, strings: ChatStrings): Row[] {
  const rows: Row[] = [];
  const authorKey = (m: Message) =>
    m.direction === 'inbound' ? 'me' : `${m.author.type}:${m.author.user?.id ?? m.author.bot?.id ?? ''}:${m.ai ? 'ai' : ''}`;

  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const day = dayLabel(message.created_at, strings);
    const newDay = !previous || dayLabel(previous.created_at, strings) !== day;
    if (newDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: day });
    }
    const startsGroup =
      newDay || authorKey(previous!) !== authorKey(message) || Date.parse(message.created_at) - Date.parse(previous!.created_at) > GROUP_GAP_MS;
    const endsGroup =
      !next ||
      authorKey(next) !== authorKey(message) ||
      Date.parse(next.created_at) - Date.parse(message.created_at) > GROUP_GAP_MS ||
      dayLabel(next.created_at, strings) !== day;
    rows.push({
      kind: 'message',
      key: message.client_id ?? message.id,
      message,
      first: startsGroup,
      last: endsGroup,
      gap: startsGroup && !newDay,
    });
  });

  if (handedOff) {
    rows.push({ kind: 'handed', key: 'handed' });
  }
  aiReplies.forEach((reply) => rows.push({ kind: 'reply', key: `ai-${reply.id}`, reply }));
  if (typing) {
    rows.push({ kind: 'typing', key: 'typing', name: typing });
  }

  return rows.reverse();
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) {
      return i;
    }
  }

  return -1;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(iso: string, strings: ChatStrings): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.toDateString() === today.toDateString()) {
    return strings.today;
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return strings.yesterday;
  }

  return `${months[date.getMonth()]} ${date.getDate()}`;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  const hours = date.getHours();

  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) {
    return '';
  }
  if (seconds < 45) {
    return 'now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const date = new Date(iso);

  return `${months[date.getMonth()]} ${date.getDate()}`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Styles = ReturnType<typeof createStyles>;

function createStyles(t: ChatTheme, insetTop = 0, insetBottom = 0) {
  const r = t.radius;

  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    flex: { flex: 1 },
    bold: { fontWeight: '600' },
    pressed: { opacity: 0.92, transform: [{ scale: 0.985 }] },
    disabled: { opacity: 0.4 },

    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 12,
      paddingTop: 12 + insetTop,
      paddingBottom: 11,
      borderBottomWidth: 1,
      borderBottomColor: t.line,
      backgroundColor: t.bg,
    },
    headHome: {
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 0,
      // Longhands, since `head`'s paddingTop/paddingHorizontal would beat a `padding` shorthand.
      paddingHorizontal: 16,
      paddingTop: 16 + insetTop,
      paddingBottom: 20,
      backgroundColor: t.headBg,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    headMain: { flex: 1, minWidth: 0 },
    ws: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
    wsGlyph: {
      width: 26,
      height: 26,
      borderRadius: Math.min(r.av, 13),
      backgroundColor: t.accent,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    wsGlyphText: { color: t.accentFg, fontSize: 12, fontWeight: '700' },
    wsName: { fontSize: 13.5, fontWeight: '600', letterSpacing: -0.14, color: t.fg, flexShrink: 1 },
    greet: { marginTop: 18, fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.55, color: t.fg },
    subRow: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
    sub: { flex: 1, color: t.fg3, fontSize: 13, lineHeight: 18 },
    title: { fontSize: 14, fontWeight: '600', letterSpacing: -0.14, color: t.fg },
    titleSub: { fontSize: 12, color: t.fg3, marginTop: 1 },
    iconBtn: { width: 30, height: 30, borderRadius: Math.min(r.ctl, 15), alignItems: 'center', justifyContent: 'center' },

    homeBody: { padding: 16, gap: 12 },
    card: { borderWidth: 1, borderColor: t.line, borderRadius: r.card, backgroundColor: t.bg, overflow: 'hidden' },
    cardHead: {
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 6,
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.66,
      textTransform: 'uppercase',
      color: t.fg4,
    },
    conv: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, paddingHorizontal: 14 },
    convBorder: { borderTopWidth: 1, borderTopColor: t.line },
    dot: { width: 7, height: 7, borderRadius: 4, marginTop: 6, backgroundColor: t.line2 },
    convMain: { flex: 1, minWidth: 0 },
    convTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    convSubject: { flex: 1, fontSize: 13, fontWeight: '500', color: t.fg },
    convPrev: { flex: 1, fontSize: 12.5, color: t.fg3, marginTop: 1 },
    time: { fontFamily: t.mono, fontSize: 10.5, color: t.fg4 },
    unread: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center' },
    unreadText: { color: '#ffffff', fontSize: 10.5, fontWeight: '600' },
    primary: {
      height: 44,
      borderRadius: r.ctl,
      backgroundColor: t.accent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      shadowColor: '#000000',
      shadowOpacity: 0.08,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    primaryText: { color: t.accentFg, fontSize: 13.5, fontWeight: '500' },
    linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 14 },
    linkText: { fontSize: 13, fontWeight: '500', color: t.fg },
    away: { borderWidth: 1, borderColor: t.line, borderRadius: r.card, backgroundColor: t.bg3, padding: 12 },
    awayText: { fontSize: 12.5, lineHeight: 18, color: t.fg2 },
    foot: {
      height: 30 + insetBottom,
      paddingBottom: insetBottom,
      alignItems: 'center',
      justifyContent: 'center',
      borderTopWidth: 1,
      borderTopColor: t.line,
    },
    footText: { fontSize: 11, color: t.fg4 },
    skeletonCard: { paddingVertical: 4 },
    skel: { height: 12, borderRadius: 4, marginVertical: 10, marginHorizontal: 14, backgroundColor: t.bg2 },

    emptyScroll: { flexGrow: 1 },
    empty: { paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' },
    emptyTitle: { fontSize: 14, fontWeight: '600', color: t.fg, marginBottom: 4, textAlign: 'center' },
    emptyText: { fontSize: 13, lineHeight: 19, color: t.fg3, textAlign: 'center' },
    picker: { margin: 14 },
    pickerTitle: { paddingHorizontal: 14, paddingTop: 14, fontSize: 14, fontWeight: '600', color: t.fg },
    pickerHint: { paddingHorizontal: 14, marginTop: 2, marginBottom: 12, fontSize: 12.5, lineHeight: 18, color: t.fg3 },
    topic: {
      minHeight: 42,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    topicText: { flex: 1, fontSize: 13.5, lineHeight: 19, fontWeight: '500', color: t.fg },

    thread: { paddingTop: 16, paddingHorizontal: 14, paddingBottom: 8 },
    day: { alignSelf: 'center', fontFamily: t.mono, fontSize: 10.5, color: t.fg4, marginTop: 10, marginBottom: 6 },
    row: { maxWidth: '84%', marginTop: 2 },
    rowMe: { alignSelf: 'flex-end', alignItems: 'flex-end' },
    rowThem: { alignSelf: 'flex-start', alignItems: 'flex-start' },
    rowGap: { marginTop: 12 },
    who: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 2, marginBottom: 4 },
    whoName: { fontSize: 11.5, fontWeight: '500', color: t.fg2 },
    aiPill: { height: 16, paddingHorizontal: 5, borderRadius: 4, backgroundColor: t.aiSoft, justifyContent: 'center' },
    aiPillText: { color: t.ai, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.38 },
    msg: { paddingVertical: 8, paddingHorizontal: 12, maxWidth: '100%', borderRadius: r.bubble },
    msgMe: { backgroundColor: t.accent },
    msgThem: { backgroundColor: t.bg2 },
    msgAi: { backgroundColor: t.bg3, borderWidth: 1, borderColor: t.line },
    msgText: { fontSize: 13.5, lineHeight: 19.5, color: t.fg },
    sendingMsg: { opacity: 0.7 },
    meta: { fontFamily: t.mono, fontSize: 10, color: t.fg4, marginTop: 3, marginHorizontal: 4 },
    tools: { gap: 4, marginBottom: 6 },
    tool: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    toolIc: { width: 16, height: 16, borderRadius: 8, backgroundColor: t.aiSoft, alignItems: 'center', justifyContent: 'center' },
    toolText: { fontSize: 12, lineHeight: 18, color: t.fg3 },
    fileGap: { marginTop: 4 },
    thumb: { width: 220, height: 160, borderRadius: r.card, borderWidth: 1, borderColor: t.line, backgroundColor: t.bg2 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: 240,
      height: 30,
      paddingHorizontal: 10,
      borderRadius: r.ctl,
      borderWidth: 1,
      borderColor: t.line,
      backgroundColor: t.bg,
    },
    chipText: { flexShrink: 1, fontSize: 12, color: t.fg },
    chipSize: { fontFamily: t.mono, fontSize: 10.5, color: t.fg4 },
    chipSpinner: { transform: [{ scale: 0.6 }], width: 14, height: 14 },
    handoff: {
      marginTop: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 30,
      paddingHorizontal: 11,
      borderRadius: r.ctl,
      borderWidth: 1,
      borderColor: t.line2,
      backgroundColor: t.bg,
    },
    handoffText: { fontSize: 12.5, fontWeight: '500', color: t.fg },
    handed: {
      marginTop: 6,
      marginBottom: 14,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 11,
      paddingHorizontal: 12,
      borderRadius: r.card,
      backgroundColor: t.bg3,
      borderWidth: 1,
      borderColor: t.line,
    },
    handedIc: {
      width: 28,
      height: 28,
      borderRadius: Math.min(r.av, 14),
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    handedTitle: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: t.fg },
    handedText: { fontSize: 12, lineHeight: 17, color: t.fg3 },
    typing: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, paddingBottom: 4 },
    typingBubble: {
      paddingHorizontal: 12,
      height: 36,
      justifyContent: 'center',
      borderRadius: r.bubble,
      borderBottomLeftRadius: 4,
      backgroundColor: t.bg2,
    },
    typingText: { fontSize: 12, color: t.fg3 },
    action: {
      marginTop: 6,
      width: 272,
      maxWidth: '100%',
      paddingTop: 11,
      paddingHorizontal: 12,
      paddingBottom: 12,
      borderRadius: r.card,
      borderWidth: 1,
      borderColor: t.line,
      backgroundColor: t.bg,
    },
    actionPending: { borderColor: t.aiLine },
    actionTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 20 },
    actionTool: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
    actionToolText: { fontSize: 11.5, fontWeight: '500', color: t.ai },
    actionNeed: { fontSize: 11, color: t.fg4 },
    actionTitle: { marginTop: 6, fontSize: 13.5, lineHeight: 19, fontWeight: '600', letterSpacing: -0.14, color: t.fg },
    actionSum: { marginTop: 2, fontSize: 12.5, lineHeight: 18, color: t.fg2 },
    actionBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 10 },
    btn: { height: 30, paddingHorizontal: 12, borderRadius: r.ctl, alignItems: 'center', justifyContent: 'center' },
    btnSolid: { backgroundColor: t.accent },
    btnSolidText: { color: t.accentFg, fontSize: 12.5, fontWeight: '500' },
    btnGhost: { borderWidth: 1, borderColor: t.line2 },
    btnGhostText: { color: t.fg, fontSize: 12.5, fontWeight: '500' },

    composer: { paddingTop: 10, paddingHorizontal: 12, paddingBottom: 12 + insetBottom, gap: 6, backgroundColor: t.bg },
    topicRow: { alignItems: 'center' },
    topicChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      height: 26,
      paddingLeft: 10,
      paddingRight: 4,
      borderRadius: 999,
      backgroundColor: t.bg2,
      borderWidth: 1,
      borderColor: t.line,
    },
    topicChipText: { fontSize: 12, fontWeight: '500', color: t.fg },
    topicChipX: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    pendingFiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    pendingChip: { height: 26 },
    err: { color: t.danger, fontSize: 12 },
    cbar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 4,
      padding: 5,
      paddingLeft: 12,
      borderWidth: 1,
      borderColor: t.line,
      borderRadius: r.bar,
      backgroundColor: t.bg,
    },
    cbarLead: { paddingLeft: 5 },
    cbarFocus: { borderColor: t.fg4 },
    cbarOff: { backgroundColor: t.bg3 },
    input: {
      flex: 1,
      minHeight: 30,
      maxHeight: 120,
      paddingVertical: 5,
      paddingHorizontal: 0,
      fontSize: 14,
      lineHeight: 20,
      color: t.fg,
      ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
    },
    send: {
      width: 30,
      height: 30,
      borderRadius: Math.min(r.ctl, 15),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.accent,
      opacity: 0.28,
      transform: [{ scale: 0.9 }],
    },
    sendReady: { opacity: 1, transform: [{ scale: 1 }] },
  });
}
