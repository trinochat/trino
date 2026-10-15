// Day separator in a conversation ("Hoy", "Ayer", a date): the label in the
// label style between two thin lines, with no pill behind it.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

class DaySeparator extends StatelessWidget {
  const DaySeparator({super.key, required this.label});

  static const lineKey = ValueKey('day-separator-line');

  final String label;

  @override
  Widget build(BuildContext context) {
    Widget line() => Expanded(
      child: Container(key: lineKey, height: 1, color: context.tokens.line),
    );
    return Semantics(
      container: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
        child: Row(
          children: [
            line(),
            Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: TrinoLabel(label)),
            line(),
          ],
        ),
      ),
    );
  }
}
