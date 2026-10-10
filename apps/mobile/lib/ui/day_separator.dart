// Day separator in a conversation ("Hoy", "Ayer", a date): a centred pill in
// the label style, on raised.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

class DaySeparator extends StatelessWidget {
  const DaySeparator({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Center(
        child: DecoratedBox(
          decoration: BoxDecoration(color: context.tokens.raised, borderRadius: BorderRadius.circular(999)),
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4), child: TrinoLabel(label)),
        ),
      ),
    ),
  );
}
