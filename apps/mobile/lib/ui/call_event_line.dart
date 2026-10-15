// A call inside a conversation: a centred line with the direction's icon, the
// words and the time, such as "Llamada saliente · 4 min · 10:36". A missed
// call says "Llamada perdida" with the crossed phone; the danger colour only
// repeats what the word and the icon already say.
import 'package:flutter/widgets.dart';

import '../design/icons.dart';
import '../design/theme.dart';

class CallEventLine extends StatelessWidget {
  const CallEventLine({super.key, required this.icon, required this.text, this.missed = false});

  /// [TrinoIcons.phoneOutgoing], [TrinoIcons.phoneIncoming] or [TrinoIcons.phoneMissed].
  final TrinoIcons icon;
  final String text;
  final bool missed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final color = missed ? t.danger : t.muted;
    return MergeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            TrinoIcon(icon, size: 15, color: color),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                text,
                textAlign: TextAlign.center,
                style: context.text.caption.copyWith(color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
