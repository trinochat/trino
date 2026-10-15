// The info of a contact, opened from the chat's header.
import 'package:flutter/material.dart';

import '../../engine/engine.dart';
import '../common.dart';

class ContactInfoScreen extends StatelessWidget {
  const ContactInfoScreen({super.key, required this.chat});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => ContactInfoScreen(chat: chat));

  final ChatSummary chat;

  @override
  Widget build(BuildContext context) => SubPage(title: chat.title, children: const []);
}
