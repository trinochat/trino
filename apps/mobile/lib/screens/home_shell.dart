// The four tabs: Chats, Llamadas, Contactos and Ajustes, with the bottom bar.
// Llamadas counts the missed calls not seen yet; looking at it clears them.
// The inbox's "Ver qué hacer" opens "No se pudo conectar". A call that rings
// in opens the call screen over whatever is open.
import 'dart:async';

import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../engine/engine.dart';
import '../ui/bottom_tabs.dart';
import 'add_contact_screen.dart';
import 'call_screen.dart';
import 'calls_screen.dart';
import 'chats_screen.dart';
import 'connection/connection_failed_screen.dart';
import 'contacts_screen.dart';
import 'settings_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.openAddContact = false});

  /// Opens "Agregar contacto" on top, as the end of the first run asks.
  final bool openAddContact;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  static const _chatsTab = 0;
  static const _callsTab = 1;
  static const _contactsTab = 2;

  late final TrinoEngine _engine = context.engine;
  StreamSubscription<int>? _missed;
  StreamSubscription<CallSession?>? _calls;

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
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          ChatsScreen(onNetworkHelp: () => Navigator.of(context).push(ConnectionFailedScreen.route())),
          const CallsScreen(),
          const ContactsScreen(),
          const SettingsScreen(),
        ],
      ),
      bottomNavigationBar: BottomTabs(
        key: const ValueKey('bottom-tabs'),
        items: [
          (icon: TrinoIcons.chats, label: l10n.tabChats),
          (icon: TrinoIcons.phone, label: l10n.tabCalls),
          (icon: TrinoIcons.contacts, label: l10n.tabContacts),
          (icon: TrinoIcons.settings, label: l10n.tabSettings),
        ],
        badges: {_callsTab: (count: _unseenMissed, label: l10n.missedCallsBadge(_unseenMissed))},
        selected: _tab,
        onSelected: _select,
      ),
    );
  }
}
