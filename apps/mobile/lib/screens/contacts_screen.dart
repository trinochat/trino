// Contactos: the large title with your code's QR, the search, the shortcuts in
// the accent (add with a code, new group, find by @nombre), and the contacts
// from A to Z under their letters.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/icon_button.dart';
import '../ui/list_row.dart';
import '../ui/text_field.dart';
import '../ui/trust_badge.dart';
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
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  String get _query => _search.text.trim();

  /// The engine cannot look up a @nombre yet: the shortcut and the search say so.
  void _notYet() => showNotice(context, context.l10n.notAvailableYet);

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final query = _query;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          LargeTitleBar(
            title: l10n.contactsTitle,
            actions: [
              TrinoIconButton(
                icon: TrinoIcons.qr,
                label: l10n.shareMyCode,
                onPressed: () => Navigator.of(context).push(ShareCodeScreen.route()),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            child: TrinoTextField(
              controller: _search,
              semanticLabel: l10n.contactsSearch,
              hint: l10n.contactsSearchHint,
              leadingIcon: TrinoIcons.search,
              textInputAction: TextInputAction.search,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<Contact>>(
              stream: _contacts,
              builder: (context, snapshot) {
                final all = snapshot.data;
                return ListView(
                  children: [
                    if (query.isEmpty) ...[
                      ListRow(
                        icon: TrinoIcons.userPlus,
                        title: l10n.contactsAddByCode,
                        accent: true,
                        chevron: false,
                        onTap: () => Navigator.of(context).push(AddContactScreen.route()),
                      ),
                      ListRow(
                        icon: TrinoIcons.users,
                        title: l10n.contactsNewGroup,
                        accent: true,
                        chevron: false,
                        onTap: _notYet,
                      ),
                      ListRow(
                        icon: TrinoIcons.atSign,
                        title: l10n.contactsFindByUsername,
                        accent: true,
                        chevron: false,
                        onTap: _notYet,
                      ),
                    ],
                    if (all != null) ..._list(context, all, query),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _list(BuildContext context, List<Contact> all, String query) {
    final l10n = context.l10n;
    if (query.startsWith('@')) return [_Note(l10n.contactsUsernameNotYet)];
    if (all.isEmpty) return [_Note(l10n.noContacts)];
    final folded = foldForSearch(query);
    final contacts = sortedByName([
      for (final contact in all)
        if (folded.isEmpty || foldForSearch(contact.name).contains(folded)) contact,
    ]);
    if (contacts.isEmpty) return [_Note(l10n.contactsSearchEmpty)];
    String? letter;
    return [
      for (final contact in contacts) ...[
        if (initialOf(contact.name) != letter) _LetterHeader(letter = initialOf(contact.name)),
        ListRow(
          key: ValueKey(contact.id),
          leading: TrinoAvatar(name: contact.name, size: 40),
          title: contact.name,
          // The subtitle says it in words; the shield is only for the eye.
          titleBadge: contact.trust == Trust.verified
              ? ExcludeSemantics(
                  child: TrustBadge(kind: TrustKind.verified, label: l10n.contactVerified, compact: true),
                )
              : null,
          subtitle: trustLabel(contact.trust, l10n),
          chevron: false,
          onTap: () => openChatWith(context, contact),
        ),
      ],
    ];
  }
}

/// The letter above the contacts whose name starts with it.
class _LetterHeader extends StatelessWidget {
  const _LetterHeader(this.letter);

  final String letter;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
    child: Semantics(container: true, header: true, child: TrinoLabel(letter)),
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(24),
    child: Text(text, textAlign: TextAlign.center, style: context.text.secondary),
  );
}

/// By name, ignoring accents and capitals, so "Ángela" sorts with the A.
List<Contact> sortedByName(List<Contact> contacts) =>
    [...contacts]..sort((a, b) => foldForSearch(a.name).compareTo(foldForSearch(b.name)));

/// The letter a name goes under: its first letter without the accent, or "#"
/// for a name that starts otherwise.
String initialOf(String name) {
  final folded = foldForSearch(name.trim());
  if (folded.isEmpty) return '#';
  final first = folded.characters.first.toUpperCase();
  return RegExp(r'^[A-Z]$').hasMatch(first) ? first : '#';
}

String trustLabel(Trust trust, AppLocalizations l10n) => switch (trust) {
  Trust.verified => l10n.contactVerified,
  Trust.unverified => l10n.contactUnverified,
  Trust.keyChanged => l10n.contactKeyChanged,
};
