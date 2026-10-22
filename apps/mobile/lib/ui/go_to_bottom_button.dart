// The round button that takes a conversation back to its newest message:
// 44 dp with a down chevron, and the count of new messages below as a number
// badge, as on the tabs (no coloured dot). One button for screen readers,
// read with the count in words.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'unread_badge.dart';

class GoToBottomButton extends StatelessWidget {
  const GoToBottomButton({super.key, required this.count, required this.label, required this.onPressed});

  /// New messages below what shows; no badge at 0.
  final int count;

  /// Such as "3 mensajes nuevos, ir al final", or "Ir al final".
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      container: true,
      button: true,
      label: label,
      onTap: onPressed,
      excludeSemantics: true,
      // 48 dp to touch, around the 44 dp circle.
      child: SizedBox.square(
        dimension: 48,
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            Material(
              color: t.surface,
              clipBehavior: Clip.antiAlias,
              shape: CircleBorder(side: BorderSide(color: t.controlLine)),
              child: InkWell(
                onTap: onPressed,
                child: SizedBox.square(
                  dimension: 44,
                  child: Center(child: TrinoIcon(TrinoIcons.chevronDown, color: t.ink)),
                ),
              ),
            ),
            if (count > 0)
              PositionedDirectional(
                top: -4,
                end: -4,
                child: IgnorePointer(
                  child: UnreadBadge(count: count, semanticLabel: label),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
