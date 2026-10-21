// Swaps one widget for another with the theme's motion (TrinoMotion): the new
// one grows a little as it fades in (or only fades), the old one fades out.
// With Reduce Motion it only fades, and with Remove animations it changes at
// once. The leaving widget is neither read nor tappable, so screen readers
// and fingers only ever meet one.
//
// Give each child its own key: a new key is a new widget to swap to; the same
// key with new contents (a clock that ticks) just updates in place.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

class MotionSwitcher extends StatelessWidget {
  const MotionSwitcher({super.key, required this.child, this.grow = false, this.alignment = Alignment.center});

  final Widget child;

  /// Whether the new child grows from the theme's swap scale as it fades in,
  /// as a button does; otherwise it only fades, as words do.
  final bool grow;

  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    final motion = context.motion;
    if (motion.short == Duration.zero) return child;
    return AnimatedSwitcher(
      duration: motion.short,
      switchInCurve: Curves.linear,
      switchOutCurve: Curves.linear,
      layoutBuilder: (current, previous) => Stack(
        alignment: alignment,
        children: [
          for (final leaving in previous) IgnorePointer(child: ExcludeSemantics(child: leaving)),
          ?current,
        ],
      ),
      transitionBuilder: (child, animation) {
        final fade = FadeTransition(
          opacity: CurvedAnimation(parent: animation, curve: motion.fadeCurve),
          // The new one is read from its first frame, while still clear.
          alwaysIncludeSemantics: true,
          child: child,
        );
        if (!grow || motion.swapScale == 1) return fade;
        return ScaleTransition(
          scale: Tween(
            begin: motion.swapScale,
            end: 1.0,
          ).animate(CurvedAnimation(parent: animation, curve: motion.curve)),
          child: fade,
        );
      },
      child: child,
    );
  }
}
