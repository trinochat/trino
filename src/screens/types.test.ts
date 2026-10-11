import type { ReactNode } from 'react';
import { describe, expectTypeOf, it } from 'vitest';
import type {
  CallDirection as ApiCallDirection,
  CallOutcome as ApiCallOutcome,
  ForgeResponse,
  GroupInfo,
  NodeInfo,
  UnsealResponse,
} from '../lib/api';
import type { CallEvent as LibCallEvent } from '../lib/call-events';
import type { ConvoRef as LibConvoRef } from '../lib/convo';
import type {
  CallDirection,
  CallEvent,
  CallLogEntry,
  CallOutcome,
  CallSlot,
  ChannelViewProps,
  ChatPaneProps,
  ConvoRef,
  InboxFilter,
  Msg,
  NewChatPurpose,
  NewChatSlotProps,
  OnboardingApi,
  OnboardingFlowProps,
  SendFailure,
  SettingsSectionId,
  SettingsSlotProps,
  ShellSlots,
  Trust,
  UnlockApi,
  VerifyContactSlotProps,
} from './types';

// The props contracts between the units of the redesign. Checked by tsc: a
// change here breaks the build of every unit that relies on it, which is the
// point. Only the parent changes types.ts (plan §2, E0.3).
describe('the screen contracts', () => {
  it('share the conversation reference of lib/convo', () => {
    expectTypeOf<ConvoRef>().toEqualTypeOf<LibConvoRef>();
  });

  it('describe a message with a stable key, a side and an optional send state', () => {
    expectTypeOf<Msg['key']>().toEqualTypeOf<string>();
    expectTypeOf<Msg['side']>().toEqualTypeOf<'me' | 'them'>();
    expectTypeOf<Msg['state']>().toEqualTypeOf<'sending' | 'sent' | 'failed' | undefined>();
    expectTypeOf<SendFailure>().toEqualTypeOf<'offline' | 'not_accepted' | 'too_long' | 'no_session' | 'partial' | 'other'>();
  });

  it('leave message requests out of this batch', () => {
    expectTypeOf<InboxFilter>().toEqualTypeOf<'all' | 'unread' | 'groups'>();
    expectTypeOf<Trust>().toEqualTypeOf<'verified' | 'unverified' | 'keyChanged'>();
  });

  it('inject the backend into the first run and unlock screens', () => {
    expectTypeOf<OnboardingApi['createIdentity']>().returns.toEqualTypeOf<Promise<ForgeResponse>>();
    expectTypeOf<UnlockApi['unseal']>().returns.toEqualTypeOf<Promise<UnsealResponse>>();
  });

  it('let the shell mount every other unit through its nine slots', () => {
    expectTypeOf<keyof ShellSlots>().toEqualTypeOf<
      | 'chat'
      | 'channel'
      | 'contacts'
      | 'newGroup'
      | 'groupPanel'
      | 'settings'
      | 'contactDetails'
      | 'verifyContact'
      | 'newChat'
    >();
    expectTypeOf<ShellSlots['groupPanel']>().parameter(0).toHaveProperty('group').toEqualTypeOf<GroupInfo>();
    expectTypeOf<ShellSlots['contactDetails']>().parameter(0).toHaveProperty('node').toEqualTypeOf<NodeInfo>();
    expectTypeOf<ReturnType<ShellSlots['chat']>>().toEqualTypeOf<ReactNode>();
    expectTypeOf<CallSlot['bar']>().toEqualTypeOf<ReactNode | null>();
  });

  it('keep the chat on contacts and groups, never the channel', () => {
    expectTypeOf<ChatPaneProps['convo']>().toEqualTypeOf<Exclude<ConvoRef, { kind: 'channel' }>>();
  });

  // The links in a message open through the shell, as the channel's do, so
  // the chat never imports the opener plugin and its tests need no mock.
  it('hand the links of a message to the shell', () => {
    expectTypeOf<ChatPaneProps['onOpenLink']>().toEqualTypeOf<(url: string) => void>();
    expectTypeOf<ChatPaneProps['onOpenLink']>().toEqualTypeOf<ChannelViewProps['onOpenLink']>();
  });

  // Delete for me needs the backend (K11). Until it lands the shell leaves
  // the handler out and the chat hides the menu item: nothing is faked.
  it('make delete for me optional, so the chat can hide it', () => {
    expectTypeOf<ChatPaneProps['onDeleteForMe']>().toEqualTypeOf<((msgKey: string) => Promise<void>) | undefined>();
  });

  // Accessibility sits between Appearance and Language (accesibilidad.md §2.1).
  it('name the eight sections of Settings', () => {
    expectTypeOf<SettingsSectionId>().toEqualTypeOf<
      'profile' | 'privacy' | 'notifications' | 'security' | 'appearance' | 'accessibility' | 'language' | 'advanced'
    >();
  });

  // PropNuevoChat: one dialog of the contacts unit (W4) for a new chat and a
  // new call, opened by the shell (W2). It only lists the contacts: this
  // batch looks nobody up on the network, so there is no API and no @name.
  it('open "Nuevo chat" and "Nueva llamada" through one slot, without an API', () => {
    expectTypeOf<NewChatPurpose>().toEqualTypeOf<'chat' | 'call'>();
    expectTypeOf<ShellSlots['newChat']>().parameter(0).toEqualTypeOf<NewChatSlotProps>();
    expectTypeOf<ReturnType<ShellSlots['newChat']>>().toEqualTypeOf<ReactNode>();
    expectTypeOf<keyof NewChatSlotProps>().toEqualTypeOf<
      'purpose' | 'contacts' | 'trust' | 'onClose' | 'onOpenChat' | 'onCall' | 'onNewGroup' | 'onAddWithCode'
    >();
    expectTypeOf<NewChatSlotProps['purpose']>().toEqualTypeOf<NewChatPurpose>();
    expectTypeOf<NewChatSlotProps['contacts']>().toEqualTypeOf<readonly NodeInfo[]>();
    expectTypeOf<NewChatSlotProps['trust']>().toEqualTypeOf<Readonly<Record<string, Trust>>>();
    expectTypeOf<NewChatSlotProps['onOpenChat']>().toEqualTypeOf<(handle: string) => void>();
    expectTypeOf<NewChatSlotProps['onCall']>().toEqualTypeOf<(handle: string, video: boolean) => void>();
    expectTypeOf<NewChatSlotProps['onNewGroup']>().toEqualTypeOf<() => void>();
    expectTypeOf<NewChatSlotProps['onAddWithCode']>().toEqualTypeOf<() => void>();
  });

  // A contact is verified only by "They match" on a call's SAS (David, 10 Oct):
  // the contact dialog compares the symbols as a quick check and offers a call.
  it('verify a contact through a call, never from the contact dialog', () => {
    expectTypeOf<VerifyContactSlotProps>().not.toHaveProperty('onVerified');
    expectTypeOf<VerifyContactSlotProps['onCall']>().toEqualTypeOf<(() => void) | undefined>();
  });

  // "Tu código QR" in Settings is the share panel of the contacts unit (W4).
  it('let Settings show the QR code through the panel of the contacts unit', () => {
    expectTypeOf<SettingsSlotProps['renderShareCode']>().toEqualTypeOf<() => ReactNode>();
  });

  // The honest copy of the first run (plan-cambios §6) depends on K12.
  it('tell the first run whether the profile reaches the contacts', () => {
    expectTypeOf<OnboardingFlowProps['profileSync']>().toEqualTypeOf<boolean | undefined>();
  });

  // K13: a call is a line in its chat and a row in the call log.
  it('carry a call in a message and in the call log', () => {
    expectTypeOf<CallDirection>().toEqualTypeOf<'outgoing' | 'incoming'>();
    expectTypeOf<CallOutcome>().toEqualTypeOf<
      'answered' | 'missed' | 'declined' | 'unanswered' | 'cancelled' | 'failed'
    >();
    expectTypeOf<CallEvent>().toEqualTypeOf<{
      id: string;
      direction: CallDirection;
      video: boolean;
      outcome: CallOutcome;
      durationSec: number;
    }>();
    expectTypeOf<Msg['call']>().toEqualTypeOf<CallEvent | undefined>();
    expectTypeOf<CallLogEntry>().toEqualTypeOf<{ key: string; peer: string; ts: number; call: CallEvent }>();
  });

  // As with ConvoRef: lib owns the call types (the wire values in api.ts, the
  // event with its texts in call-events.ts) and the screens share them.
  it('share the call types of lib', () => {
    expectTypeOf<CallDirection>().toEqualTypeOf<ApiCallDirection>();
    expectTypeOf<CallOutcome>().toEqualTypeOf<ApiCallOutcome>();
    expectTypeOf<CallEvent>().toEqualTypeOf<LibCallEvent>();
  });
});
