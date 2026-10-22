// The four tabs: Llamadas, Chats, Contactos and Ajustes, with the bottom bar.
// Chats, the most used, sits second, in the middle and nearer the thumb (a
// beta tester's suggestion), and the app opens on it.
// Llamadas counts the missed calls not seen yet; looking at it clears them.
// The inbox's "Ver qué hacer" opens "No se pudo conectar". A call that rings
// in opens the call screen over whatever is open.
//
// From 600 dp wide (a tablet, or a phone lying down) the tabs become a rail on
// the left and the screen splits in two: the list, and beside it the chat
// opened from it, or words saying none is. Calls still open full screen.
import 'dart:async';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/layout.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/bottom_tabs.dart';
import '../ui/motion_switcher.dart';
import '../ui/nav_rail.dart';
import 'add_contact_screen.dart';
import 'call_screen.dart';
import 'calls_screen.dart';
import 'chat_panes.dart';
import 'chat_screen.dart';
import 'chats_screen.dart';
import 'connection/connection_failed_screen.dart';
import 'contacts_screen.dart';
import 'settings_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.openAddContact = false});

  static const railKey = ValueKey('nav-rail');
  static const listPaneKey = ValueKey('list-pane');
  static const detailPaneKey = ValueKey('detail-pane');

  /// Opens "Agregar contacto" on top, as the end of the first run asks.
  final bool openAddContact;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  static const _callsTab = 0;
  static const _chatsTab = 1;
  static const _contactsTab = 2;
  static const _settingsTab = 3;

  late final TrinoEngine _engine = context.engine;
  StreamSubscription<int>? _missed;
  StreamSubscription<CallSession?>? _calls;
  StreamSubscription<List<ChatSummary>>? _chats;
  ChatPanes? _panes;

  /// The tab screens keep their state (a search, a filter, the scroll) as
  /// the layout changes between the phone and the panes.
  final _tabKeys = [for (var i = 0; i < 4; i++) GlobalKey()];

  /// The chats as last heard, to keep the open one up to date.
  List<ChatSummary> _latestChats = const [];

  /// The chat open beside the list, on a tablet.
  ChatSummary? _open;

  /// The call ringing in that the call screen was opened for.
  String? _ringingCallId;
  var _unseenMissed = 0;
  int _tab = _chatsTab;

  @override
  void initState() {
    super.initState();
    if (widget.openAddContact) {
      _tab = _contactsTab;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).push(AddContactScreen.route());
      });
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _missed ??= _engine.unseenMissedCalls.listen(_onMissed);
    _calls ??= _engine.call.listen(_onCall);
    _chats ??= _engine.chats.listen(_onChats);
    _panes ??= ChatPanes.maybeOf(context);
  }

  /// Calls you make open their screen where you made them; one that rings in
  /// opens it here.
  void _onCall(CallSession? call) {
    if (!mounted || call == null || call.phase != CallPhase.incoming || call.id == _ringingCallId) return;
    _ringingCallId = call.id;
    unawaited(Navigator.of(context).push(CallScreen.route()));
  }

  void _onMissed(int count) {
    if (!mounted) return;
    // A call missed while the Llamadas tab is on screen is seen at once.
    if (count > 0 && _tab == _callsTab) {
      unawaited(_engine.markCallsSeen());
      return;
    }
    setState(() => _unseenMissed = count);
  }

  /// Keeps the open chat's name and state fresh, and closes it once it is
  /// gone (deleted, or a group left).
  void _onChats(List<ChatSummary> chats) {
    _latestChats = chats;
    final open = _open;
    if (!mounted || open == null) return;
    setState(() => _open = chats.where((chat) => chat.id == open.id).firstOrNull);
  }

  /// Opens [chat] beside the list, on Chats, where its row stands out.
  void _openInPane(ChatSummary chat) {
    if (!mounted) return;
    setState(() => _open = _latestChats.where((known) => known.id == chat.id).firstOrNull ?? chat);
    if (_tab != _chatsTab) _select(_chatsTab);
  }

  void _select(int tab) {
    setState(() {
      _tab = tab;
      if (tab == _callsTab) _unseenMissed = 0;
    });
    if (tab == _callsTab) unawaited(_engine.markCallsSeen());
  }

  @override
  void dispose() {
    unawaited(_missed?.cancel());
    unawaited(_calls?.cancel());
    unawaited(_chats?.cancel());
    if (_panes?.inPane == _openInPane) _panes?.inPane = null;
    super.dispose();
  }

  List<({TrinoIcons icon, String label})> _items(BuildContext context) {
    final l10n = context.l10n;
    return [
      (icon: TrinoIcons.phone, label: l10n.tabCalls),
      (icon: TrinoIcons.chats, label: l10n.tabChats),
      (icon: TrinoIcons.contacts, label: l10n.tabContacts),
      (icon: TrinoIcons.settings, label: l10n.tabSettings),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final width = MediaQuery.sizeOf(context).width;
    final panes = HomeLayout.forWidth(width) != HomeLayout.phone;
    // Chats open beside the list only while there is one.
    _panes?.inPane = panes ? _openInPane : null;
    final screens = [
      CallsScreen(key: _tabKeys[_callsTab]),
      ChatsScreen(
        key: _tabKeys[_chatsTab],
        onNetworkHelp: () => Navigator.of(context).push(ConnectionFailedScreen.route()),
        inPanes: panes,
        selectedChatId: panes ? _open?.id : null,
      ),
      ContactsScreen(key: _tabKeys[_contactsTab]),
      SettingsScreen(key: _tabKeys[_settingsTab]),
    ];
    final items = _items(context);
    final badges = {_callsTab: (count: _unseenMissed, label: l10n.missedCallsBadge(_unseenMissed))};
    if (!panes) {
      return Scaffold(
        body: IndexedStack(index: _tab, children: screens),
        bottomNavigationBar: BottomTabs(
          key: const ValueKey('bottom-tabs'),
          items: items,
          badges: badges,
          selected: _tab,
          onSelected: _select,
        ),
      );
    }
    final t = context.tokens;
    return Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          NavRail(
            key: HomeShell.railKey,
            label: l10n.navSections,
            items: items,
            badges: badges,
            selected: _tab,
            onSelected: _select,
          ),
          Expanded(
            // The rail takes the left edge's inset (a notch, lying down).
            child: MediaQuery.removePadding(
              context: context,
              removeLeft: true,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // The list first, then the detail: for the keyboard and
                  // for screen readers, each a landmark of its own.
                  Semantics(
                    key: HomeShell.listPaneKey,
                    role: SemanticsRole.region,
                    label: items[_tab].label,
                    container: true,
                    explicitChildNodes: true,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border(right: BorderSide(color: t.line)),
                      ),
                      child: SizedBox(
                        width: listPaneWidth(width),
                        child: FocusTraversalGroup(
                          child: IndexedStack(index: _tab, children: screens),
                        ),
                      ),
                    ),
                  ),
                  Expanded(
                    child: Semantics(
                      key: HomeShell.detailPaneKey,
                      role: SemanticsRole.region,
                      label: l10n.paneConversation,
                      container: true,
                      explicitChildNodes: true,
                      child: FocusTraversalGroup(child: _chatPane(context)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// The open chat, or words saying none is. Switching chats crossfades with
  /// the theme's motion; with Remove animations it changes at once.
  Widget _chatPane(BuildContext context) {
    final chat = _open;
    return MotionSwitcher(
      child: chat == null
          ? _NoChat(key: const ValueKey('no-chat'), text: context.l10n.chatPickOne)
          : ChatScreen(key: ValueKey('chat-${chat.id}'), chat: chat, inPane: true),
    );
  }
}

/// The right pane before a chat is chosen: an outline chats icon and words.
class _NoChat extends StatelessWidget {
  const _NoChat({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return ColoredBox(
      color: t.bg,
      child: SizedBox.expand(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TrinoIcon(TrinoIcons.chats, size: 40, color: t.muted),
                const SizedBox(height: 12),
                Text(
                  text,
                  textAlign: TextAlign.center,
                  style: context.text.body.copyWith(color: t.muted),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
