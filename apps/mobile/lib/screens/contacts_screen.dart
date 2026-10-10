// Contactos: add a contact, share your code, and your contacts.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/list_row.dart';
import 'add_contact_screen.dart';
import 'common.dart';
import 'new_chat_screen.dart';
import 'share_code_screen.dart';

class ContactsScreen extends StatefulWidget {
  const ContactsScreen({super.key});

  @override
  State<ContactsScreen> createState() => _ContactsScreenState();
}

class _ContactsScreenState extends State<ContactsScreen> {
  late final Stream<List<Contact>> _contacts = context.engine.contacts;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          LargeTitleBar(title: l10n.contactsTitle),
          Expanded(
            child: ListView(
              children: [
                ListRow(
                  icon: TrinoIcons.userPlus,
                  title: l10n.addContact,
                  accent: true,
                  chevron: false,
                  onTap: () => Navigator.of(context).push(AddContactScreen.route()),
                ),
                ListRow(
                  icon: TrinoIcons.qr,
                  title: l10n.shareMyCode,
                  onTap: () => Navigator.of(context).push(ShareCodeScreen.route()),
                ),
                Divider(color: context.tokens.line),
                StreamBuilder<List<Contact>>(
                  stream: _contacts,
                  builder: (context, snapshot) {
                    final contacts = sortedByName(snapshot.data ?? const []);
                    if (snapshot.hasData && contacts.isEmpty) {
                      return Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(l10n.noContacts, style: context.text.secondary),
                      );
                    }
                    return Column(
                      children: [
                        for (final contact in contacts)
                          ListRow(
                            key: ValueKey(contact.id),
                            leading: TrinoAvatar(name: contact.name, size: 40),
                            title: contact.name,
                            subtitle: trustLabel(contact.trust, l10n),
                            chevron: false,
                            onTap: () => openChatWith(context, contact),
                          ),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

List<Contact> sortedByName(List<Contact> contacts) =>
    [...contacts]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

String trustLabel(Trust trust, AppLocalizations l10n) => switch (trust) {
  Trust.verified => l10n.contactVerified,
  Trust.unverified => l10n.contactUnverified,
  Trust.keyChanged => l10n.contactKeyChanged,
};
