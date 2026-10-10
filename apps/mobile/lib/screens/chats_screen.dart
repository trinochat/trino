// The inbox: a large title that says "Conectando…" while there is no
// connection, the new chat button, search, the text filters and the chats.
import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/chat_row.dart';
import '../ui/icon_button.dart';
import '../ui/text_field.dart';
import '../ui/trust_badge.dart';
import '../ui/underline_tabs.dart';
import 'chat_screen.dart';
import 'common.dart';
import 'new_chat_screen.dart';

enum ChatFilter { all, unread, groups, requests }

class ChatsScreen extends StatefulWidget {
  const ChatsScreen({super.key});

  @override
  State<ChatsScreen> createState() => _ChatsScreenState();
}

class _ChatsScreenState extends State<ChatsScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<ConnectionStatus> _connection = _engine.connection;
  late final Stream<List<ChatSummary>> _chats = _engine.chats;
  final _search = TextEditingController();
  var _filter = ChatFilter.all;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<ChatSummary> _visible(List<ChatSummary> chats) {
    final query = foldForSearch(_search.text.trim());
    return [
      for (final chat in chats)
        if (switch (_filter) {
              ChatFilter.all => true,
              ChatFilter.unread => chat.unread > 0,
              ChatFilter.groups => chat.isGroup,
              // Message requests come with the engine (R6); until then, none.
              ChatFilter.requests => false,
            } &&
            (query.isEmpty || foldForSearch(chat.title).contains(query)))
          chat,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          StreamBuilder<ConnectionStatus>(
            stream: _connection,
            builder: (context, snapshot) => LargeTitleBar(
              title: snapshot.data == ConnectionStatus.connecting ? l10n.connecting : l10n.chatsTitle,
              live: true,
              actions: [
                TrinoIconButton(
                  icon: TrinoIcons.compose,
                  label: l10n.newChat,
                  onPressed: () => Navigator.of(context).push(NewChatScreen.route()),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            child: TrinoTextField(
              controller: _search,
              semanticLabel: l10n.searchChats,
              hint: l10n.searchHint,
              leadingIcon: TrinoIcons.search,
              textInputAction: TextInputAction.search,
              onChanged: (_) => setState(() {}),
            ),
          ),
          UnderlineTabs(
            labels: [l10n.filterAll, l10n.filterUnread, l10n.filterGroups, l10n.filterRequests],
            selected: _filter.index,
            onSelected: (index) => setState(() => _filter = ChatFilter.values[index]),
          ),
          Expanded(
            child: StreamBuilder<List<ChatSummary>>(
              stream: _chats,
              builder: (context, snapshot) {
                final all = snapshot.data;
                if (all == null) return const SizedBox.shrink();
                final chats = _visible(all);
                if (chats.isEmpty) {
                  final message = all.isEmpty
                      ? l10n.noChats
                      : _search.text.trim().isNotEmpty
                      ? l10n.searchEmpty
                      : l10n.filterEmpty;
                  return Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(message, textAlign: TextAlign.center, style: context.text.secondary),
                  );
                }
                return ListView.builder(
                  itemCount: chats.length,
                  itemBuilder: (context, index) => _row(context, chats[index]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, ChatSummary chat) {
    final l10n = context.l10n;
    final draft = chat.draft;
    final activity = chat.lastActivity;
    return ChatRow(
      key: ValueKey(chat.id),
      name: chat.title,
      avatarKind: chat.isGroup ? AvatarKind.group : AvatarKind.person,
      trust: trustOf(chat, l10n),
      draftPrefix: draft == null ? null : l10n.draftPrefix,
      preview: draft ?? previewOf(chat, l10n),
      time: activity == null ? null : formatChatTime(context, activity, context.now()),
      unread: chat.unread > 0 ? (count: chat.unread, label: l10n.unreadCount(chat.unread)) : null,
      onTap: () => Navigator.of(context).push(ChatScreen.route(chat)),
    );
  }
}

/// The badge after a direct chat's name: only a verified contact, or a key
/// that changed, gets one.
({TrustKind kind, String label})? trustOf(ChatSummary chat, AppLocalizations l10n) {
  if (chat.isGroup) return null;
  return switch (chat.trust) {
    Trust.verified => (kind: TrustKind.verified, label: l10n.contactVerified),
    Trust.keyChanged => (kind: TrustKind.keyChanged, label: l10n.contactKeyChanged),
    Trust.unverified => null,
  };
}

/// The last message as a row shows it: "Tú: …" for yours, "Papá: …" in groups.
String? previewOf(ChatSummary chat, AppLocalizations l10n) {
  final message = chat.lastMessage;
  if (message == null) return null;
  if (chat.lastIsMine) return l10n.previewYou(message);
  final sender = chat.lastSender;
  if (chat.isGroup && sender != null) return l10n.previewSender(sender, message);
  return message;
}
