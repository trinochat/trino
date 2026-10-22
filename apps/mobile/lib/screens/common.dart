// Pieces every screen shares: the large title of a tab, the header of a page
// with its back button, section labels and short notices.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../ui/icon_button.dart';

/// The big title of a tab, such as "Chats", with its actions. [live] reads
/// changes of the title out loud, such as "Conectando…".
class LargeTitleBar extends StatelessWidget {
  const LargeTitleBar({super.key, required this.title, this.actions = const [], this.live = false});

  final String title;
  final List<Widget> actions;
  final bool live;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
    child: Row(
      children: [
        Expanded(
          child: Semantics(
            container: true,
            header: true,
            liveRegion: live,
            child: Text(title, style: context.text.largeTitle),
          ),
        ),
        ...actions,
      ],
    ),
  );
}

/// The header of a pushed page: back and the title.
class SubPageBar extends StatelessWidget {
  const SubPageBar({super.key, required this.title});

  final String title;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: context.tokens.line)),
    ),
    child: Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 16, 4),
      child: ConstrainedBox(
        // As tall with back as without it.
        constraints: const BoxConstraints(minHeight: 48),
        child: Row(
          children: [
            // A section shown beside the list on a tablet has nothing to go
            // back to; a page always has.
            if (Navigator.canPop(context)) ...[
              TrinoIconButton(
                icon: TrinoIcons.back,
                label: context.l10n.back,
                onPressed: () => Navigator.maybePop(context),
              ),
              const SizedBox(width: 4),
            ] else
              const SizedBox(width: 12),
            Expanded(
              child: Semantics(container: true, header: true, child: Text(title, style: context.text.title)),
            ),
          ],
        ),
      ),
    ),
  );
}

/// A pushed page: its header and a scrolling body.
class SubPage extends StatelessWidget {
  const SubPage({
    super.key,
    required this.title,
    required this.children,
    this.padding = const EdgeInsets.only(bottom: 24),
  });

  final String title;
  final List<Widget> children;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          SubPageBar(title: title),
          Expanded(
            child: ListView(padding: padding, children: children),
          ),
        ],
      ),
    ),
  );
}

/// The label above a group of rows.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
    child: Semantics(container: true, header: true, child: TrinoLabel(text)),
  );
}

/// A short message at the bottom of the screen, replacing the one before.
void showNotice(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// Text for searching: small letters, without accents, so "lucia" finds Lucía.
String foldForSearch(String text) {
  const plain = {
    'á': 'a',
    'à': 'a',
    'â': 'a',
    'ä': 'a',
    'ã': 'a',
    'é': 'e',
    'è': 'e',
    'ê': 'e',
    'ë': 'e',
    'í': 'i',
    'ì': 'i',
    'î': 'i',
    'ï': 'i',
    'ó': 'o',
    'ò': 'o',
    'ô': 'o',
    'ö': 'o',
    'õ': 'o',
    'ú': 'u',
    'ù': 'u',
    'û': 'u',
    'ü': 'u',
    'ñ': 'n',
    'ç': 'c',
  };
  final lower = text.toLowerCase();
  final buffer = StringBuffer();
  for (final char in lower.characters) {
    buffer.write(plain[char] ?? char);
  }
  return buffer.toString();
}
