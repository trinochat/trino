/**
 * The props contracts between the units of the redesign (plan §2, E0.3). Only
 * the parent changes this file: a unit that needs a change reports it, the
 * parent makes it on feat/rediseno and the units rebase.
 */
import type { ReactNode } from 'react';
import type { Announcement, AnnouncementFeed } from '../lib/announcements';
import type {
  FileRef,
  ForgeResponse,
  GroupInfo,
  GroupInvite,
  NodeInfo,
  StickerInfo,
  TotpBeginResponse,
  UnsealResponse,
} from '../lib/api';
import type { ConvoRef } from '../lib/convo';
import type { ProcessedFile } from '../lib/media';

/* Conversations */
export type { ConvoRef };
export type SendState = 'sending' | 'sent' | 'failed';
export type SendFailure = 'offline' | 'not_accepted' | 'too_long' | 'no_session' | 'partial' | 'other';
export interface ReplyRef {
  author: string;
  preview: string;
}
export interface Msg {
  /** Stable: `${ts}:${n}` from the history, `crypto.randomUUID()` when sent here. */
  key: string;
  side: 'me' | 'them';
  /** Epoch seconds. */
  ts: number;
  text?: string;
  file?: FileRef;
  from?: string;
  reply?: ReplyRef;
  ttl?: number;
  expiresAt?: number;
  /** Only for what was sent in this session. */
  state?: SendState;
  failure?: { kind: SendFailure; members?: string[] };
}
export type Trust = 'verified' | 'unverified' | 'keyChanged';
export type Connection = { status: 'connecting' } | { status: 'connected' | 'offline'; up: number; total: number };
/** No 'requests' in this batch. */
export type InboxFilter = 'all' | 'unread' | 'groups';
export interface InboxItem {
  ref: ConvoRef;
  key: string;
  name: string;
  avatar: { initials: string; src?: string; kind: 'person' | 'group' };
  preview?: string;
  draft?: string;
  lastTs?: number;
  unread: number;
  trust?: Trust;
  muted?: boolean;
}
export type PanelLayout = 'aside' | 'dialog';

/* Auth (W1) */
export interface OnboardingApi {
  checkPassphrase(passphrase: string): Promise<void>;
  totpBegin(label?: string): Promise<TotpBeginResponse>;
  totpVerify(code: string): Promise<boolean>;
  createIdentity(handle: string, passphrase: string, useTotp: boolean): Promise<ForgeResponse>;
  updateProfile(handle: string, avatar: string | null): Promise<void>;
}
export type OnboardingIntent = 'chats' | 'add-contact';
export interface OnboardingFlowProps {
  api: OnboardingApi;
  onCreated(r: ForgeResponse, intent: OnboardingIntent): void;
  onVaultExists(): void;
}
export type LockReason = { kind: 'cold' } | { kind: 'idle'; minutes: number } | { kind: 'manual' };
export interface UnlockApi {
  unseal(p: string, totpCode?: string | null): Promise<UnsealResponse>;
  wipe(): Promise<void>;
}
export interface UnlockScreenProps {
  handle: string | null;
  totpEnabled: boolean | null;
  reason: LockReason;
  api: UnlockApi;
  onUnlocked(r: UnsealResponse): void;
  onNoVault(): void;
  onWiped(): void;
}

/* Chat (W3) */
export type ChatHeaderInfo =
  | { kind: 'contact'; name: string; avatarSrc?: string; trust: Trust; ttlSeconds: number; blocked: boolean }
  | { kind: 'group'; name: string; memberCount: number; ended: boolean; ttlSeconds: number };
export interface StickerApi {
  list(): Promise<StickerInfo[]>;
  importFile(f: File): Promise<StickerInfo>;
  remove(id: string): Promise<void>;
}
/** The shell mounts it with `key={convoKey}`. */
export interface ChatPaneProps {
  convo: Exclude<ConvoRef, { kind: 'channel' }>;
  header: ChatHeaderInfo;
  messages: readonly Msg[];
  now: number;
  maxTextLength: number;
  draft: string;
  onDraftChange(text: string): void;
  /** Optimistic: the message shows at once as sending. */
  onSendText(text: string, reply?: ReplyRef): void;
  onRetry(msgKey: string): void;
  onSendFiles(files: readonly ProcessedFile[]): Promise<{ failed: readonly ProcessedFile[] }>;
  onSendSticker(s: StickerInfo): Promise<void>;
  onDeleteForMe(msgKey: string): Promise<void>;
  onForward(msgKey: string): void;
  /** Contacts only; without it there are no call buttons. */
  onCall?(video: boolean): void;
  onOpenDetails(): void;
  onVerify?(): void;
  onAcknowledgeKeyChange?(): void;
  onBack?(): void;
  fetchFile(f: FileRef): Promise<string>;
  stickers: StickerApi;
}
export interface ChannelViewProps {
  announcements: readonly Announcement[];
  source: AnnouncementFeed['source'];
  lastReadId: string | null;
  muted: boolean;
  onToggleMuted(): void;
  onOpenLink(url: string): void;
  onBack?(): void;
  now: number;
}

/* Contacts and groups (W4) */
export type ContactsTab = 'add' | 'share' | 'invites';
export interface ContactsSlotProps {
  tab: ContactsTab;
  onTabChange(t: ContactsTab): void;
  onClose(): void;
  onContactAdded(handle: string): void;
  onGroupJoined(gid: string): void;
  invites: readonly GroupInvite[];
  onInvitesChanged(): void;
  /** `handshake-needed` in this session, each pubkey counted once. */
  strangerAttempts: number;
}
export interface NewGroupSlotProps {
  contacts: readonly NodeInfo[];
  onClose(): void;
  onCreated(gid: string): void;
}
export interface GroupPanelSlotProps {
  group: GroupInfo;
  contacts: readonly NodeInfo[];
  layout: PanelLayout;
  onClose(): void;
  onChanged(): void;
  onOpenContact(handle: string): void;
  onLeft(): void;
}

/* Settings and contact details (W5) */
export type SettingsSectionId =
  | 'profile'
  | 'privacy'
  | 'notifications'
  | 'security'
  | 'appearance'
  | 'language'
  | 'advanced';
export interface SettingsSlotProps {
  section: SettingsSectionId;
  onSectionChange(id: SettingsSectionId): void;
  onClose(): void;
  onLockNow(): void;
  onIdentityWiped(): void;
  onProfileChanged(): void;
  onAutolockChanged(minutes: number): void;
}
export interface ContactDetailsSlotProps {
  node: NodeInfo;
  trust: Trust;
  layout: PanelLayout;
  onClose(): void;
  onVerify(): void;
  onRenamed(newHandle: string): void;
  onRemoved(): void;
  onChanged(): void;
}

/* Calls and verification (W6) */
export interface VerifyContactSlotProps {
  peer: NodeInfo;
  myIdentityDigest: string;
  onClose(): void;
  onVerified(): void;
}
export interface CallSlot {
  /** Above both panes (Main:43-66). */
  bar: ReactNode | null;
  /** The call screen, the incoming call, the IP warning, the end card and the audio sink. */
  layer: ReactNode;
  start(handle: string, video: boolean): void;
  activePeer: string | null;
}

/* Shell (W2) */
export interface ShellSlots {
  chat(p: ChatPaneProps): ReactNode;
  channel(p: ChannelViewProps): ReactNode;
  contacts(p: ContactsSlotProps): ReactNode;
  newGroup(p: NewGroupSlotProps): ReactNode;
  groupPanel(p: GroupPanelSlotProps): ReactNode;
  settings(p: SettingsSlotProps): ReactNode;
  contactDetails(p: ContactDetailsSlotProps): ReactNode;
  verifyContact(p: VerifyContactSlotProps): ReactNode;
}
export interface Notifier {
  message(n: { convo: ConvoRef; title: string; text?: string; kind: 'text' | 'file' | 'sticker' }): void;
}
