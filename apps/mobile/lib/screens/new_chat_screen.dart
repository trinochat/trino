// "Nuevo chat": pick a contact and write to them.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/avatar.dart';
import '../ui/list_row.dart';
import 'chat_screen.dart';
import 'common.dart';
import 'contacts_screen.dart';

class NewChatScreen extends StatefulWidget {
  const NewChatScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const NewChatScreen());

  @override
  State<NewChatScreen> createState() => _NewChatScreenState();
}

class _NewChatScreenState extends State<NewChatScreen> {
  late final Stream<List<Contact>> _contacts = context.engine.contacts;

  @override
  Widget build(BuildContext context) => SubPage(
    title: context.l10n.newChat,
    children: [
      StreamBuilder<List<Contact>>(
        stream: _contacts,
        builder: (context, snapshot) {
          final contacts = sortedByName(snapshot.data ?? const []);
          if (snapshot.hasData && contacts.isEmpty) {
            return Padding(
              padding: const EdgeInsets.all(24),
              child: Text(context.l10n.noContacts, style: context.text.secondary),
            );
          }
          return Column(
            children: [
              for (final contact in contacts)
                ListRow(
                  leading: TrinoAvatar(name: contact.name, size: 40),
                  title: contact.name,
                  subtitle: trustLabel(contact.trust, context.l10n),
                  chevron: false,
                  onTap: () => openChatWith(context, contact, replace: true),
                ),
            ],
          );
        },
      ),
    ],
  );
}

/// Opens the chat with [contact], creating it the first time. With
/// [replace], the chat takes the place of the current page.
Future<void> openChatWith(BuildContext context, Contact contact, {bool replace = false}) async {
  final engine = context.engine;
  final navigator = Navigator.of(context);
  final chatId = await engine.openChat(contact.id);
  final chat = (await engine.chats.first).firstWhere((chat) => chat.id == chatId);
  if (replace) {
    await navigator.pushReplacement(ChatScreen.route(chat));
  } else {
    await navigator.push(ChatScreen.route(chat));
  }
}
