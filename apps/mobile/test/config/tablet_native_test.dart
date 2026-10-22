// The native projects let the app be a tablet app: on an iPad it turns to any
// orientation and joins Split View and Slide Over, and on Android it rotates
// and resizes on large screens and in split screen, without restarting, so the
// panes adapt live (lib/design/layout.dart). Either mistake would only show on
// a real tablet; these tests catch it on any computer.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../support/native_config.dart';

/// The strings of the plist array under [key], or null without one.
List<String>? plistArray(String xml, String key) {
  final array = RegExp(
    '<key>${RegExp.escape(key)}</key>\\s*<array>(.*?)</array>',
    dotAll: true,
  ).firstMatch(xml.replaceAll(RegExp('<!--.*?-->', dotAll: true), ''));
  if (array == null) return null;
  return [for (final value in RegExp('<string>([^<]*)</string>').allMatches(array[1]!)) value[1]!];
}

void main() {
  group('iPad', () {
    final info = File('ios/Runner/Info.plist').readAsStringSync();

    test('the app is built for the iPad too, in every configuration', () {
      final project = File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();
      final app = xcodeBuildSettings(project, target: 'Runner');
      final inherited = xcodeBuildSettings(project, target: 'Runner', isa: 'PBXProject');
      expect(app.keys, unorderedEquals(['Debug', 'Release', 'Profile']));
      for (final MapEntry(key: name, value: settings) in app.entries) {
        // The target's own setting wins over the project's.
        expect(settings['TARGETED_DEVICE_FAMILY'] ?? inherited[name]?['TARGETED_DEVICE_FAMILY'], '1,2', reason: name);
      }
    });

    test('it allows all four orientations, as Split View needs', () {
      expect(
        plistArray(info, 'UISupportedInterfaceOrientations~ipad'),
        unorderedEquals([
          'UIInterfaceOrientationPortrait',
          'UIInterfaceOrientationPortraitUpsideDown',
          'UIInterfaceOrientationLandscapeLeft',
          'UIInterfaceOrientationLandscapeRight',
        ]),
      );
    });

    test('it does not ask for the full screen, so it can share it', () {
      expect(Plist(info).boolean('UIRequiresFullScreen'), isNot(true));
      expect(Plist(info).boolean('UIRequiresFullScreen~ipad'), isNot(true));
      expect(Plist(info).string('UILaunchStoryboardName'), isNotEmpty);
    });
  });

  group('Android', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync()
        .replaceAll(RegExp('<!--.*?-->', dotAll: true), '');
    final activity = RegExp(r'<activity\b[^>]*android:name="\.MainActivity"[^>]*>').firstMatch(manifest)![0]!;
    String? attribute(String name) => RegExp('android:$name="([^"]*)"').firstMatch(activity)?[1];

    test('the activity resizes, for split screen and large screens, and is not locked to an orientation', () {
      expect(attribute('resizeableActivity'), 'true');
      expect(attribute('screenOrientation'), isNull);
      expect(RegExp(r'android:(max|min)AspectRatio').hasMatch(activity), isFalse);
    });

    test('rotating or resizing does not restart it: Flutter lays the panes out again', () {
      final changes = attribute('configChanges')!.split('|');
      expect(changes, containsAll(['orientation', 'screenSize', 'smallestScreenSize', 'screenLayout']));
    });
  });
}
