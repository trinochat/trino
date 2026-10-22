// How much the system lets the app move. Android's "Remove animations" sets
// MediaQuery.disableAnimations; the iPhone's Reduce Motion does not: it comes
// apart, as AccessibilityFeatures.reduceMotion (see MediaQueryData's docs).
// Reading only the first ignored Reduce Motion on the iPhone. The app's own
// Animaciones setting (AnimationsSetting) can take motion away further.
import 'package:flutter/physics.dart';
import 'package:flutter/widgets.dart';

import 'tokens.dart';

enum MotionLevel {
  /// Animations as designed.
  full,

  /// Reduce Motion (iPhone): no sliding or zooming, short fades only.
  reduced,

  /// Remove animations (Android): changes happen at once.
  none,
}

/// Ajustes › Apariencia › Animaciones: the app's own say, for whoever gets
/// dizzy with motion without having turned it off on the phone. It can only
/// take motion away: never back from what the system removed.
enum AnimationsSetting {
  /// "Según el celular", the default: as the system says.
  system,

  /// "Reducidas": at least [MotionLevel.reduced].
  reduced,

  /// "Ninguna": [MotionLevel.none].
  none,
}

/// Gives [setting] to everything below; the app puts it around its pages, so
/// page transitions and the predictive back read it too. Without one, the
/// system decides alone.
class AnimationsScope extends InheritedWidget {
  const AnimationsScope({super.key, required this.setting, required super.child});

  final AnimationsSetting setting;

  @override
  bool updateShouldNotify(AnimationsScope oldWidget) => setting != oldWidget.setting;
}

MotionLevel motionOf(BuildContext context) {
  final system = MediaQuery.disableAnimationsOf(context)
      ? MotionLevel.none
      : View.of(context).platformDispatcher.accessibilityFeatures.reduceMotion
      ? MotionLevel.reduced
      : MotionLevel.full;
  final app = switch (context.dependOnInheritedWidgetOfExactType<AnimationsScope>()?.setting) {
    null || AnimationsSetting.system => MotionLevel.full,
    AnimationsSetting.reduced => MotionLevel.reduced,
    AnimationsSetting.none => MotionLevel.none,
  };
  // The levels go from most to least motion: the stricter one wins.
  return system.index >= app.index ? system : app;
}

/// True when something should not slide, bounce or travel: Reduce Motion or
/// Remove animations.
bool reduceMotionOf(BuildContext context) => motionOf(context) != MotionLevel.full;

/// How things move in each theme, in one place: Calma is soft, with a hint
/// of spring; Terminal is short and crisp, never past its end. With Reduce
/// Motion both become short fades in place, and with Remove animations
/// nothing animates. Read it with `context.motion` (theme.dart).
///
/// Page transitions are not here: the platform's own navigation decides
/// those (see TrinoPageTransitionsBuilder).
@immutable
class TrinoMotion {
  const TrinoMotion._({
    required this.short,
    required this.medium,
    required this.curve,
    required this.fadeCurve,
    required this.swapScale,
    required this.travels,
    required this.rise,
  });

  /// Calma: a spring with a bounce of 0.15, which settles without a visible
  /// bounce (it passes its end by less than 1 %), as SwiftUI's "snappy".
  static const calma = TrinoMotion._(
    short: Duration(milliseconds: 220),
    medium: Duration(milliseconds: 450),
    curve: SpringCurve(bounce: 0.15),
    fadeCurve: Curves.easeOut,
    swapScale: 0.8,
    travels: true,
    rise: 12,
  );

  /// Terminal: quick cuts that slow down, with no spring.
  static const terminal = TrinoMotion._(
    short: Duration(milliseconds: 120),
    medium: Duration(milliseconds: 160),
    curve: Curves.easeOut,
    fadeCurve: Curves.linear,
    swapScale: 0.9,
    travels: true,
    rise: 6,
  );

  /// Reduce Motion, in either theme: a 150 ms fade in place (Apple's advice:
  /// replace movement with fades).
  static const reduced = TrinoMotion._(
    short: Duration(milliseconds: 150),
    medium: Duration(milliseconds: 150),
    curve: Curves.easeOut,
    fadeCurve: Curves.easeOut,
    swapScale: 1,
    travels: false,
    rise: 0,
  );

  /// Remove animations, in either theme: at once.
  static const none = TrinoMotion._(
    short: Duration.zero,
    medium: Duration.zero,
    curve: Curves.linear,
    fadeCurve: Curves.linear,
    swapScale: 1,
    travels: false,
    rise: 0,
  );

  static TrinoMotion of(TrinoStyle style, MotionLevel level) => switch (level) {
    MotionLevel.none => none,
    MotionLevel.reduced => reduced,
    MotionLevel.full => style == TrinoStyle.calma ? calma : terminal,
  };

  /// Small changes: a button swapping for another, a fade between two words.
  final Duration short;

  /// Something that moves across part of the screen: the tab indicator.
  final Duration medium;

  /// For what moves or grows.
  final Curve curve;

  /// For what only fades.
  final Curve fadeCurve;

  /// What a swapped button grows from; 1 when nothing may grow.
  final double swapScale;

  /// Whether things may move or grow; false with Reduce Motion or Remove
  /// animations, where they only fade or change at once.
  final bool travels;

  /// How far a message you send rises as it appears, in dp: 12 in Calma, 6 in
  /// Terminal (as the approved mock), 0 when nothing may travel.
  final double rise;
}

/// A spring as a curve: [bounce] as in SpringDescription.withDurationAndBounce
/// (0 settles without passing its end), with its perceptual duration
/// stretched to the animation's. It ends exactly at 1.
class SpringCurve extends Curve {
  const SpringCurve({this.bounce = 0});

  final double bounce;

  @override
  double transformInternal(double t) {
    final spring = SpringDescription.withDurationAndBounce(duration: const Duration(seconds: 1), bounce: bounce);
    return SpringSimulation(spring, 0, 1, 0).x(t);
  }
}
