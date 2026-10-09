import 'package:flutter/material.dart';

class Conversation {
  const Conversation({
    required this.name,
    required this.preview,
    required this.time,
    required this.color,
    this.unread = 0,
    this.online = false,
    this.group = false,
    this.system = false,
  });

  final String name;
  final String preview;
  final String time;
  final Color color;
  final int unread;
  final bool online;
  final bool group;
  final bool system;
}

class ChatEntry {
  const ChatEntry({required this.text, required this.mine, required this.time});

  final String text;
  final bool mine;
  final String time;
}
