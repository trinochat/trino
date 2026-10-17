import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/motion.dart';

Future<MotionLevel> levelIn(WidgetTester tester, {bool disableAnimations = false}) async {
  late MotionLevel level;
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(disableAnimations: disableAnimations),
      child: Builder(
        builder: (context) {
          level = motionOf(context);
          return const SizedBox();
        },
      ),
    ),
  );
  return level;
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
}
