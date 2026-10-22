import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/theme.dart';

Future<MotionLevel> levelIn(WidgetTester tester, {bool disableAnimations = false, AnimationsSetting? setting}) async {
  late MotionLevel level;
  final probe = Builder(
    builder: (context) {
      level = motionOf(context);
      return const SizedBox();
    },
  );
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(disableAnimations: disableAnimations),
      child: setting == null ? probe : AnimationsScope(setting: setting, child: probe),
    ),
  );
  return level;
}

void useReduceMotion(WidgetTester tester) {
  tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
  addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
}

void main() {
  testWidgets('full motion unless the system asks otherwise', (tester) async {
    expect(await levelIn(tester), MotionLevel.full);
  });

  testWidgets("the iPhone's Reduce Motion means reduced", (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    expect(await levelIn(tester), MotionLevel.reduced);
  });

  testWidgets("Android's Remove animations means none, and wins", (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    expect(await levelIn(tester, disableAnimations: true), MotionLevel.none);
  });

  group("the app's own Animaciones setting", () {
    testWidgets('"Según el celular" follows the system', (tester) async {
      expect(await levelIn(tester, setting: AnimationsSetting.system), MotionLevel.full);
      expect(await levelIn(tester, setting: AnimationsSetting.system, disableAnimations: true), MotionLevel.none);
    });

    testWidgets('"Reducidas" means at least reduced', (tester) async {
      expect(await levelIn(tester, setting: AnimationsSetting.reduced), MotionLevel.reduced);
      expect(
        await levelIn(tester, setting: AnimationsSetting.reduced, disableAnimations: true),
        MotionLevel.none,
        reason: 'never more motion than the system allows',
      );
    });

    testWidgets('"Ninguna" means none, whatever the system says', (tester) async {
      expect(await levelIn(tester, setting: AnimationsSetting.none), MotionLevel.none);
      useReduceMotion(tester);
      expect(await levelIn(tester, setting: AnimationsSetting.none), MotionLevel.none);
    });

    testWidgets('with Reduce Motion on, no setting brings the motion back', (tester) async {
      useReduceMotion(tester);
      for (final setting in [AnimationsSetting.system, AnimationsSetting.reduced]) {
        expect(await levelIn(tester, setting: setting), MotionLevel.reduced, reason: '$setting');
      }
    });

    testWidgets('context.motion follows it too', (tester) async {
      late TrinoMotion motion;
      await tester.pumpWidget(
        AnimationsScope(
          setting: AnimationsSetting.reduced,
          child: Theme(
            data: buildTrinoTheme(TrinoStyle.calma, Brightness.light, TrinoAccent.verde),
            child: Builder(
              builder: (context) {
                motion = context.motion;
                return const SizedBox();
              },
            ),
          ),
        ),
      );
      expect(motion, TrinoMotion.reduced);
    });
  });

  motionTokens();
}

/// The highest value [curve] reaches between 0 and 1.
double peakOf(Curve curve) {
  var peak = 0.0;
  for (var i = 0; i <= 200; i++) {
    final value = curve.transform(i / 200);
    if (value > peak) peak = value;
  }
  return peak;
}

bool risesOnly(Curve curve) {
  var last = 0.0;
  for (var i = 0; i <= 200; i++) {
    final value = curve.transform(i / 200);
    if (value < last - 1e-9) return false;
    last = value;
  }
  return true;
}

Future<TrinoMotion> motionIn(
  WidgetTester tester,
  TrinoStyle style, {
  bool disableAnimations = false,
  bool reduceMotion = false,
}) async {
  if (reduceMotion) {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
  }
  late TrinoMotion motion;
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(disableAnimations: disableAnimations),
      child: Theme(
        data: buildTrinoTheme(style, Brightness.light, TrinoAccent.verde),
        child: Builder(
          builder: (context) {
            motion = context.motion;
            return const SizedBox();
          },
        ),
      ),
    ),
  );
  return motion;
}

void motionTokens() {
  group('motion by theme', () {
    test('Calma: soft, with a hint of spring that settles without a visible bounce', () {
      const calma = TrinoMotion.calma;
      expect(calma.medium, const Duration(milliseconds: 450));
      expect(calma.short, const Duration(milliseconds: 220));
      expect(calma.curve, isA<SpringCurve>());
      final spring = calma.curve as SpringCurve;
      expect(spring.bounce, inInclusiveRange(0.05, 0.15));
      expect(peakOf(spring), greaterThan(1), reason: 'a hint of spring past the end');
      expect(peakOf(spring), lessThan(1.02), reason: 'too small to read as a bounce');
      expect(spring.transform(0), 0);
      expect(spring.transform(1), 1);
      expect(spring.transform(0.5), greaterThan(0.8), reason: 'most of the way by half the time');
      expect(calma.travels, isTrue);
      expect(calma.swapScale, lessThan(1));
    });

    test('Terminal: short and crisp, never past the end', () {
      const terminal = TrinoMotion.terminal;
      expect(terminal.short, const Duration(milliseconds: 120));
      expect(terminal.medium, const Duration(milliseconds: 160));
      expect(peakOf(terminal.curve), 1);
      expect(risesOnly(terminal.curve), isTrue);
      expect(risesOnly(terminal.fadeCurve), isTrue);
      expect(terminal.travels, isTrue);
    });

    test('reduced: plain short fades in both themes, nothing travels or grows', () {
      for (final style in TrinoStyle.values) {
        final motion = TrinoMotion.of(style, MotionLevel.reduced);
        expect(motion.travels, isFalse, reason: '$style');
        expect(motion.swapScale, 1, reason: '$style');
        expect(motion.short, const Duration(milliseconds: 150), reason: '$style');
        expect(motion.medium, const Duration(milliseconds: 150), reason: '$style');
        expect(peakOf(motion.curve), 1, reason: '$style');
        expect(peakOf(motion.fadeCurve), 1, reason: '$style');
      }
    });

    test('a message rises 12 dp in Calma, 6 dp in Terminal, and not at all with less motion', () {
      expect(TrinoMotion.calma.rise, 12);
      expect(TrinoMotion.terminal.rise, 6);
      expect(TrinoMotion.reduced.rise, 0);
      expect(TrinoMotion.none.rise, 0);
    });

    test('none: everything at once', () {
      for (final style in TrinoStyle.values) {
        final motion = TrinoMotion.of(style, MotionLevel.none);
        expect(motion.short, Duration.zero, reason: '$style');
        expect(motion.medium, Duration.zero, reason: '$style');
        expect(motion.travels, isFalse, reason: '$style');
        expect(motion.swapScale, 1, reason: '$style');
      }
    });

    testWidgets("context.motion follows the theme and the system's settings", (tester) async {
      expect(await motionIn(tester, TrinoStyle.calma), TrinoMotion.calma);
      expect(await motionIn(tester, TrinoStyle.terminal), TrinoMotion.terminal);
      expect(await motionIn(tester, TrinoStyle.calma, disableAnimations: true), TrinoMotion.none);
    });

    testWidgets('context.motion with Reduce Motion is the short fade', (tester) async {
      expect(await motionIn(tester, TrinoStyle.calma, reduceMotion: true), TrinoMotion.reduced);
    });
  });
}
