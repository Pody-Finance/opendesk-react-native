export { OpenDesk } from './client';
export type { AIReply, IncomingMessage, OpenDeskOptions, OpenDeskState } from './client';
export { OpenDeskApi } from './api';
export type { Fetcher, OpenDeskApiOptions } from './api';
export { OpenDeskError } from './errors';
export { OpenDeskRealtime, phoenixSocketFactory } from './realtime';
export type { RealtimeChannel, RealtimeLogger, RealtimePush, RealtimeSocket, SocketFactory } from './realtime';
export { keychainStorage, memoryStorage, secureStoreStorage } from './storage';
export type { ExpoSecureStoreModule, KeychainModule, TokenStorage } from './storage';
export {
  OpenDeskProvider,
  useConversation,
  useConversations,
  useOpenDesk,
  useOpenDeskState,
  useUnreadCount,
} from './react';
export type { ConversationView, OpenDeskProviderProps } from './react';
export { OpenDeskChat } from './ui/OpenDeskChat';
export type { OpenDeskChatProps } from './ui/OpenDeskChat';
export { OpenDeskLauncher } from './ui/OpenDeskLauncher';
export type { OpenDeskLauncherProps } from './ui/OpenDeskLauncher';
export { defaultStrings } from './ui/strings';
export type { ChatStrings } from './ui/strings';
export type * from './types';
