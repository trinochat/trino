// The three tabs: Chats, Contactos and Ajustes, with the bottom bar.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../ui/bottom_tabs.dart';
import 'add_contact_screen.dart';
import 'chats_screen.dart';
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
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    if (widget.openAddContact) {
      _tab = 1;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).push(AddContactScreen.route());
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      body: IndexedStack(index: _tab, children: const [ChatsScreen(), ContactsScreen(), SettingsScreen()]),
      bottomNavigationBar: BottomTabs(
        key: const ValueKey('bottom-tabs'),
        items: [
          (icon: TrinoIcons.chats, label: l10n.tabChats),
          (icon: TrinoIcons.contacts, label: l10n.tabContacts),
          (icon: TrinoIcons.settings, label: l10n.tabSettings),
        ],
        selected: _tab,
        onSelected: (tab) => setState(() => _tab = tab),
      ),
    );
  }
}
