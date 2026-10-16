// What can be done to a chat from the inbox: pin it, mark it unread or read,
// mute a group, and delete it. The same actions show under a swiped row, in
// the sheet of a long press and as screen reader actions, so nobody depends
// on the gesture.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/list_row.dart';

enum ChatActionKind { pin, read, mute, delete }

/// How an action shows under a swiped row: the soft accent ("No leído"), grey
/// ("Fijar", "Silenciar") or red ("Borrar").
enum ChatActionTone { accent, neutral, danger }

@immutable
class ChatAction {
  const ChatAction({
    required this.kind,
    required this.icon,
    required this.label,
    required this.shortLabel,
    this.tone = ChatActionTone.neutral,
  });

  final ChatActionKind kind;
  final TrinoIcons icon;

  /// In the sheet and for screen readers, such as "Fijar arriba".
  final String label;

  /// Under a swiped row, such as "Fijar".
  final String shortLabel;
  final ChatActionTone tone;
}

/// The actions of [chat], in the order of the sheet: pin, read or unread,
/// mute (only groups: a contact cannot be muted yet) and delete.
List<ChatAction> chatActionsOf(ChatSummary chat, AppLocalizations l10n) => [
  chat.pinned
      ? ChatAction(kind: ChatActionKind.pin, icon: TrinoIcons.pin, label: l10n.chatUnpin, shortLabel: l10n.chatUnpin)
      : ChatAction(kind: ChatActionKind.pin, icon: TrinoIcons.pin, label: l10n.chatPinTop, shortLabel: l10n.chatPin),
  chat.isUnread
      ? ChatAction(
          kind: ChatActionKind.read,
          icon: TrinoIcons.mailOpen,
          label: l10n.chatMarkRead,
          shortLabel: l10n.chatReadShort,
          tone: ChatActionTone.accent,
        )
      : ChatAction(
          kind: ChatActionKind.read,
          icon: TrinoIcons.mail,
          label: l10n.chatMarkUnread,
          shortLabel: l10n.chatUnreadShort,
          tone: ChatActionTone.accent,
        ),
  if (chat.isGroup)
    chat.muted
        ? ChatAction(
            kind: ChatActionKind.mute,
            icon: TrinoIcons.bell,
            label: l10n.chatUnmute,
            shortLabel: l10n.chatUnmute,
          )
        : ChatAction(
            kind: ChatActionKind.mute,
            icon: TrinoIcons.bellOff,
            label: l10n.chatMute,
            shortLabel: l10n.chatMute,
          ),
  ChatAction(
    kind: ChatActionKind.delete,
    icon: TrinoIcons.trash,
    label: l10n.deleteChat,
    shortLabel: l10n.chatDeleteShort,
    tone: ChatActionTone.danger,
  ),
];

/// Under the name in the sheet: "Grupo · 3 miembros", "Contacto verificado",
/// or "Contacto · Sin verificar".
String chatKindLine(ChatSummary chat, AppLocalizations l10n) {
  if (chat.isGroup) return '${l10n.chatKindGroup} · ${l10n.groupMembers(chat.memberNames.length + 1)}';
  return switch (chat.trust) {
    Trust.verified => l10n.contactVerified,
    Trust.unverified => '${l10n.chatKindContact} · ${l10n.contactUnverified}',
    Trust.keyChanged => '${l10n.chatKindContact} · ${l10n.contactKeyChanged}',
  };
}

/// The sheet of a long press: the chat's avatar, name and kind, then its
/// actions. Says which one was chosen, or null.
Future<ChatActionKind?> showChatActionsSheet(BuildContext context, ChatSummary chat) {
  final l10n = AppLocalizations.of(context);
  return showModalBottomSheet<ChatActionKind>(
    context: context,
    builder: (sheet) => SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Row(
                children: [
                  TrinoAvatar(name: chat.title, kind: chat.isGroup ? AvatarKind.group : AvatarKind.person, size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Semantics(container: true, header: true, child: Text(chat.title, style: sheet.text.bodyStrong)),
                        Text(chatKindLine(chat, l10n), style: sheet.text.secondary),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            for (final action in chatActionsOf(chat, l10n))
              ListRow(
                title: action.label,
                icon: action.icon,
                danger: action.tone == ChatActionTone.danger,
                chevron: false,
                onTap: () => Navigator.of(sheet).pop(action.kind),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    ),
  );
}
