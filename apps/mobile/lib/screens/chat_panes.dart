// Where a chat opens. On a phone it is a page of its own; on a tablet the home
// shows it in the pane beside the list, so whatever opens a chat (a row, a
// contact, a new chat, an accepted request, a group in common) asks here
// instead of pushing the page itself.
//
// Given around the app's navigator (in MaterialApp.builder), so pages pushed
// over the home reach it too.
import 'package:flutter/widgets.dart';

import '../engine/engine.dart';
import 'chat_screen.dart';

class ChatPanes {
  /// Set by the home while it shows the panes: opens the chat beside the list.
  ValueChanged<ChatSummary>? inPane;

  /// The chats open as pages, oldest first, so the home can move the top one
  /// beside the list when the window widens.
  final _pages = <({ChatSummary chat, Route<dynamic> route})>[];

  /// What each chat's composer holds right now. A chat moving between a page
  /// and the pane is built anew, before (or after) the old one saves its
  /// draft, so the words travel here.
  final _drafts = <String, String>{};

  List<({ChatSummary chat, Route<dynamic> route})> get pages => List.unmodifiable(_pages);

  void pageOpened(ChatSummary chat, Route<dynamic> route) => _pages.add((chat: chat, route: route));

  void pageClosed(Route<dynamic> route) => _pages.removeWhere((page) => page.route == route);

  String? draftOf(String chatId) => _drafts[chatId];

  void keepDraft(String chatId, String text) => _drafts[chatId] = text;

  static ChatPanes? maybeOf(BuildContext context) => context.getInheritedWidgetOfExactType<ChatPanesScope>()?.panes;
}

class ChatPanesScope extends InheritedWidget {
  const ChatPanesScope({super.key, required this.panes, required super.child});

  final ChatPanes panes;

  @override
  bool updateShouldNotify(ChatPanesScope oldWidget) => panes != oldWidget.panes;
}

/// Opens [chat]: in the pane beside the list when the home shows one, closing
/// the pages above the home; otherwise as a page, in place of the current one
/// with [replace].
Future<void> showChat(BuildContext context, ChatSummary chat, {bool replace = false}) =>
    showChatOn(Navigator.of(context), ChatPanes.maybeOf(context), chat, replace: replace);

/// As [showChat], with the navigator and the panes taken before an await.
Future<void> showChatOn(NavigatorState navigator, ChatPanes? panes, ChatSummary chat, {bool replace = false}) async {
  final inPane = panes?.inPane;
  if (inPane != null) {
    navigator.popUntil((route) => route.isFirst);
    inPane(chat);
    return;
  }
  // Done when the page closes, as a push is.
  await (replace ? navigator.pushReplacement(ChatScreen.route(chat)) : navigator.push(ChatScreen.route(chat)));
}
