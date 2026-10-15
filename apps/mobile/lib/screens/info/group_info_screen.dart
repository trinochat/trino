// The info of a group, opened from the chat's header.
import 'package:flutter/material.dart';

import '../../engine/engine.dart';
import '../common.dart';

class GroupInfoScreen extends StatelessWidget {
  const GroupInfoScreen({super.key, required this.chat});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => GroupInfoScreen(chat: chat));

  final ChatSummary chat;

  @override
  Widget build(BuildContext context) => SubPage(title: chat.title, children: const []);
}
