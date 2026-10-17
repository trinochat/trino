// How much the system lets the app move. Android's "Remove animations" sets
// MediaQuery.disableAnimations; the iPhone's Reduce Motion does not: it comes
// apart, as AccessibilityFeatures.reduceMotion (see MediaQueryData's docs).
// Reading only the first ignored Reduce Motion on the iPhone.
import 'package:flutter/widgets.dart';

enum MotionLevel {
  /// Animations as designed.
  full,

  /// Reduce Motion (iPhone): no sliding or zooming, short fades only.
  reduced,

  /// Remove animations (Android): changes happen at once.
  none,
}

MotionLevel motionOf(BuildContext context) {
  if (MediaQuery.disableAnimationsOf(context)) return MotionLevel.none;
  if (View.of(context).platformDispatcher.accessibilityFeatures.reduceMotion) return MotionLevel.reduced;
  return MotionLevel.full;
}

/// True when something should not slide, bounce or travel: Reduce Motion or
/// Remove animations.
bool reduceMotionOf(BuildContext context) => motionOf(context) != MotionLevel.full;
