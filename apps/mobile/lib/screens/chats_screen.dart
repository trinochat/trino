// The inbox: a large title with search and new chat, one line of words with
// the network state (nothing once connected), the text filters, the grey row
// of message requests and the chats.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/haptics.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/chat_row.dart';
import '../ui/icon_button.dart';
import '../ui/swipe_actions.dart';
import '../ui/text_field.dart';
import '../ui/trust_badge.dart';
import '../ui/underline_tabs.dart';
import 'chat_actions.dart';
import 'chat_screen.dart';
import 'common.dart';
import 'info/info_parts.dart';
import 'new_chat_screen.dart';
import 'requests_screen.dart';

enum ChatFilter { all, unread, groups }

class ChatsScreen extends StatefulWidget {
  const ChatsScreen({super.key, this.onNetworkHelp});

  static const requestsRowKey = ValueKey('requests-row');

  /// "Ver qué hacer" after "No se pudo conectar.". Without it, the inbox says
  /// the help is not in this version yet.
  final VoidCallback? onNetworkHelp;

  @override
  State<ChatsScreen> createState() => _ChatsScreenState();
}

class _ChatsScreenState extends State<ChatsScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<NetworkState> _network = _engine.network;
  late final Stream<List<ChatSummary>> _chats = _engine.chats;
  late final Stream<List<MessageRequest>> _requests = _engine.requests;
  final _search = TextEditingController();
  var _searching = false;
  var _filter = ChatFilter.all;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  String get _query => _search.text.trim();

  List<ChatSummary> _visible(List<ChatSummary> chats) {
    final query = foldForSearch(_query);
    return [
      for (final chat in chats)
        if (switch (_filter) {
              ChatFilter.all => true,
              ChatFilter.unread => chat.isUnread,
              ChatFilter.groups => chat.isGroup,
            } &&
            (query.isEmpty || foldForSearch(chat.title).contains(query)))
          chat,
    ];
  }

  void _toggleSearch() => setState(() {
    _searching = !_searching;
    if (!_searching) _search.clear();
  });

  void _networkHelp() {
    final help = widget.onNetworkHelp;
    if (help != null) return help();
    showNotice(context, context.l10n.notAvailableYet);
  }

  void _openRequests() => Navigator.of(context).push(RequestsScreen.route());

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          LargeTitleBar(
            title: l10n.chatsTitle,
            actions: [
              TrinoIconButton(
                icon: _searching ? TrinoIcons.close : TrinoIcons.search,
                label: _searching ? l10n.searchClose : l10n.searchOpen,
                onPressed: _toggleSearch,
              ),
              TrinoIconButton(
                icon: TrinoIcons.compose,
                label: l10n.newChat,
                onPressed: () => Navigator.of(context).push(NewChatScreen.route()),
              ),
            ],
          ),
          StreamBuilder<NetworkState>(
            stream: _network,
            builder: (context, snapshot) {
              final state = snapshot.data;
              if (state == null) return const SizedBox.shrink();
              return NetworkStatusLine(state: state, onHelp: _networkHelp);
            },
          ),
          if (_searching)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: TrinoTextField(
                controller: _search,
                semanticLabel: l10n.searchChats,
                hint: l10n.searchHint,
                leadingIcon: TrinoIcons.search,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: (_) => setState(() {}),
              ),
            ),
          UnderlineTabs(
            labels: [l10n.filterAll, l10n.filterUnread, l10n.filterGroups],
            selected: _filter.index,
            onSelected: (index) => setState(() => _filter = ChatFilter.values[index]),
          ),
          Expanded(
            child: StreamBuilder<List<MessageRequest>>(
              stream: _requests,
              builder: (context, requests) => StreamBuilder<List<ChatSummary>>(
                stream: _chats,
                builder: (context, snapshot) {
                  final all = snapshot.data;
                  if (all == null) return const SizedBox.shrink();
                  final chats = _visible(all);
                  final requestCount = requests.data?.length ?? 0;
                  final showRequests = requestCount > 0 && _filter == ChatFilter.all && _query.isEmpty;
                  return SwipeGroup(
                    child: ListView(
                      padding: const EdgeInsets.only(top: 4),
                      children: [
                        if (showRequests)
                          _RequestsRow(
                            key: ChatsScreen.requestsRowKey,
                            label: l10n.requestsRow(requestCount),
                            onTap: _openRequests,
                          ),
                        if (chats.isEmpty)
                          Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              all.isEmpty
                                  ? l10n.noChats
                                  : _query.isNotEmpty
                                  ? l10n.searchEmpty
                                  : l10n.filterEmpty,
                              textAlign: TextAlign.center,
                              style: context.text.secondary,
                            ),
                          ),
                        for (final chat in chats) _row(context, chat),
                      ],
                    ),
                  );
                },
              ),
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
    final actions = chatActionsOf(chat, l10n);
    SwipeAction swipe(ChatActionKind kind) {
      final action = actions.firstWhere((action) => action.kind == kind);
      final t = context.tokens;
      final (background, foreground) = switch (action.tone) {
        ChatActionTone.accent => (t.accentSoft, t.accentText),
        ChatActionTone.neutral => (t.raised, t.ink),
        ChatActionTone.danger => (t.dangerBg, t.danger),
      };
      return SwipeAction(
        icon: action.icon,
        label: action.shortLabel,
        background: background,
        foreground: foreground,
        onPressed: () => unawaited(_perform(chat, kind)),
      );
    }

    // From each edge inwards: a long swipe does the first, "No leído" or
    // "Borrar" (which still asks).
    return SwipeActions(
      key: ValueKey(chat.id),
      startActions: [swipe(ChatActionKind.read), swipe(ChatActionKind.pin)],
      endActions: [swipe(ChatActionKind.delete), if (chat.isGroup) swipe(ChatActionKind.mute)],
      child: ChatRow(
        name: chat.title,
        avatarKind: chat.isGroup ? AvatarKind.group : AvatarKind.person,
        trust: trustOf(chat, l10n),
        draftPrefix: draft == null ? null : l10n.draftPrefix,
        preview: draft ?? previewOf(chat, l10n),
        time: activity == null ? null : formatChatTime(context, activity, context.now()),
        unread: chat.unread > 0 ? (count: chat.unread, label: l10n.unreadCount(chat.unread)) : null,
        markedUnreadLabel: chat.markedUnread ? l10n.chatMarkedUnread : null,
        pinnedLabel: chat.pinned ? l10n.chatPinned : null,
        onTap: () => Navigator.of(context).push(ChatScreen.route(chat)),
        onLongPress: () => unawaited(_openActions(chat)),
        longPressHint: l10n.chatMoreOptions,
        actions: {
          for (final action in actions)
            CustomSemanticsAction(label: action.label): () => unawaited(_perform(chat, action.kind)),
        },
      ),
    );
  }

  Future<void> _openActions(ChatSummary chat) async {
    final kind = await showChatActionsSheet(context, chat);
    if (kind != null && mounted) await _perform(chat, kind);
  }

  /// Does [kind] to [chat], as the sheet, the swipe and screen readers ask.
  Future<void> _perform(ChatSummary chat, ChatActionKind kind) async {
    final l10n = context.l10n;
    switch (kind) {
      case ChatActionKind.pin:
        try {
          await _engine.setChatPinned(chat.id, !chat.pinned);
          unawaited(TrinoHaptics.toggled());
        } on TooManyPinnedChats catch (limit) {
          if (mounted) showNotice(context, l10n.chatPinLimit(limit.max));
        }
      case ChatActionKind.read:
        await (chat.isUnread ? _engine.markRead(chat.id) : _engine.markUnread(chat.id));
      case ChatActionKind.mute:
        await _engine.setChatMuted(chat.id, !chat.muted);
        if (!mounted) return;
        showNotice(context, chat.muted ? l10n.chatUnmutedNotice(chat.title) : l10n.chatMutedNotice(chat.title));
      case ChatActionKind.delete:
        final confirmed = await confirmDanger(
          context,
          title: l10n.deleteChatTitle(chat.title),
          body: chat.isGroup ? l10n.deleteGroupChatBody : l10n.deleteChatBody(chat.title),
          confirm: l10n.deleteChat,
        );
        if (!confirmed || !mounted) return;
        await _engine.deleteChat(chat.id);
        if (mounted) showNotice(context, l10n.chatDeleted);
    }
  }
}

/// The network state in one line of words, read out politely as it changes:
/// connecting with its progress, trying another way, failed with "Ver qué
/// hacer", waiting for internet, or unprotected in the warning colour.
/// Nothing once connected: no pill and no coloured dot.
class NetworkStatusLine extends StatelessWidget {
  const NetworkStatusLine({super.key, required this.state, required this.onHelp, this.showConnected = false});

  final NetworkState state;
  final VoidCallback onHelp;

  /// Says "Conectado de forma privada" too, as Ajustes › Conexión does; the
  /// inbox says nothing once connected.
  final bool showConnected;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final style = context.text.secondary;
    final (String? message, bool help, TextStyle textStyle) = switch (state) {
      NetworkState(status: NetworkStatus.connected) => (
        showConnected ? l10n.netConnectedPrivately : null,
        false,
        style,
      ),
      NetworkState(tryingAnotherWay: true) => (l10n.netTryingAnotherWay, false, style),
      NetworkState(status: NetworkStatus.connecting, :final progress) => (
        progress > 0 ? l10n.netConnectingProgress(progress) : l10n.netConnecting,
        false,
        style,
      ),
      NetworkState(status: NetworkStatus.failed) => (l10n.netFailed, true, style),
      NetworkState(status: NetworkStatus.offline) => (l10n.netOffline, false, style),
      NetworkState(status: NetworkStatus.unprotected) => (
        l10n.netUnprotected,
        false,
        style.copyWith(color: t.warn, fontWeight: FontWeight.w700),
      ),
    };
    if (message == null) return const SizedBox.shrink();
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, help ? 0 : 6),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          children: [
            Semantics(container: true, liveRegion: true, child: Text(message, style: textStyle)),
            if (help)
              Semantics(
                button: true,
                child: Material(
                  type: MaterialType.transparency,
                  child: InkWell(
                    onTap: onHelp,
                    borderRadius: BorderRadius.circular(t.radius),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Align(
                          widthFactor: 1,
                          child: Text(
                            l10n.netWhatToDo,
                            style: style.copyWith(color: t.accentText, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// "Solicitudes (3)", grey and without a dot, above the chats.
class _RequestsRow extends StatelessWidget {
  const _RequestsRow({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return MergeSemantics(
      child: Semantics(
        button: true,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 52),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Row(
                  children: [
                    SizedBox(
                      width: 48,
                      child: Center(child: TrinoIcon(TrinoIcons.inbox, color: t.muted)),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(label, style: context.text.tab.copyWith(color: t.muted)),
                    ),
                    TrinoIcon(TrinoIcons.chevronRight, size: 18, color: t.muted),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
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
