// The app's identity, read from the native projects: the ids registered with
// Apple and Google, the team that signs the iOS app, the name under the icon,
// and the launcher icons. A mistake here would only show on a Mac, in App Store
// Connect or on a phone; these tests catch it on any computer.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show Color;

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/color.dart';
import 'package:trino_mobile/design/tokens.dart';

import '../support/native_config.dart';

/// The explicit App ID registered on the Apple Developer account, used as the
/// Android application id too.
const appId = 'org.trinochat.app';

/// The Apple Developer team that signs the iOS app. A team id is not a secret.
const appleTeam = '3KD8QNQXH6';

/// The name under the icon. The App Store name is set in App Store Connect.
const appName = 'Trino';

/// The Calma tile's green, behind the white mark of every launcher icon.
final brandGreen = hexOf(kThemes[ThemeId.calmaLight]!.accent);

void main() {
  group('iOS', () {
    final project = File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();

    test('the app has the registered bundle id and team in every configuration', () {
      final configurations = xcodeBuildSettings(project, target: 'Runner');
      expect(configurations.keys, unorderedEquals(['Debug', 'Release', 'Profile']));
      for (final MapEntry(key: name, value: settings) in configurations.entries) {
        expect(settings['PRODUCT_BUNDLE_IDENTIFIER'], appId, reason: name);
        expect(settings['DEVELOPMENT_TEAM'], appleTeam, reason: name);
      }
    });

    test('the unit tests take an id below the app, with the same team', () {
      final configurations = xcodeBuildSettings(project, target: 'RunnerTests');
      expect(configurations.keys, unorderedEquals(['Debug', 'Release', 'Profile']));
      for (final MapEntry(key: name, value: settings) in configurations.entries) {
        expect(settings['PRODUCT_BUNDLE_IDENTIFIER'], '$appId.RunnerTests', reason: name);
        expect(settings['DEVELOPMENT_TEAM'], appleTeam, reason: name);
      }
    });

    test('keeps nothing of the template id', () {
      expect(project, isNot(contains('trinoMobile')));
    });

    test('shows "Trino" under the icon', () {
      final plist = Plist.read('ios/Runner/Info.plist');
      expect(plist.string('CFBundleDisplayName'), appName);
      expect(plist.string('CFBundleName'), appName);
    });

    test('takes its version and build number from Flutter, which the TestFlight workflow sets', () {
      final plist = Plist.read('ios/Runner/Info.plist');
      expect(plist.string('CFBundleShortVersionString'), r'$(FLUTTER_BUILD_NAME)');
      expect(plist.string('CFBundleVersion'), r'$(FLUTTER_BUILD_NUMBER)');
    });

    test('has one 1024 px icon for Xcode to scale: square, opaque and without alpha', () {
      const iconSet = 'ios/Runner/Assets.xcassets/AppIcon.appiconset';
      final contents = jsonDecode(File('$iconSet/Contents.json').readAsStringSync()) as Map<String, Object?>;
      final images = (contents['images']! as List<Object?>).cast<Map<String, Object?>>();
      expect(images, hasLength(1));
      final icon = images.single;
      expect((icon['idiom'], icon['platform'], icon['size']), ('universal', 'ios', '1024x1024'));

      final filename = icon['filename']! as String;
      final png = PngInfo.read('$iconSet/$filename');
      expect((png.width, png.height), (1024, 1024));
      // App Store Connect rejects an App Store icon with an alpha channel
      // (ITMS-90717), even a fully opaque one.
      expect(png.hasAlpha, isFalse);
      // Edge to edge: iOS rounds the corners itself.
      expect(hexOf(Color(png.firstPixel!)), brandGreen);
      // Xcode warns about files the set does not name.
      expect(
        Directory(iconSet).listSync().map((file) => file.uri.pathSegments.last),
        unorderedEquals(['Contents.json', filename]),
      );
    });
  });

  group('Android', () {
    const res = 'android/app/src/main/res';

    test('has the registered application id', () {
      final gradle = File('android/app/build.gradle.kts').readAsStringSync();
      final ids = RegExp(r'^\s*applicationId = "([^"]*)"', multiLine: true).allMatches(gradle).map((m) => m[1]);
      expect(ids, [appId]);
    });

    test('shows "Trino" under the launcher icon', () {
      final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
      final application = RegExp(r'<application\b[^>]*>').firstMatch(manifest)![0]!;
      expect(RegExp(r'android:label="([^"]*)"').firstMatch(application)?[1], appName);
      expect(RegExp(r'android:icon="([^"]*)"').firstMatch(application)?[1], '@mipmap/ic_launcher');
    });

    test('has the launcher icon at every density, adaptive from Android 8 on', () {
      // Pixels per density: the 48 dp icon of Android 7, and the 108 dp
      // foreground layer of the adaptive icon.
      const sizes = {
        'mdpi': (48, 108),
        'hdpi': (72, 162),
        'xhdpi': (96, 216),
        'xxhdpi': (144, 324),
        'xxxhdpi': (192, 432),
      };
      for (final MapEntry(key: density, value: (legacy, foreground)) in sizes.entries) {
        final icon = PngInfo.read('$res/mipmap-$density/ic_launcher.png');
        expect((icon.width, icon.height), (legacy, legacy), reason: density);
        final layer = PngInfo.read('$res/mipmap-$density/ic_launcher_foreground.png');
        expect((layer.width, layer.height), (foreground, foreground), reason: density);
      }

      final adaptive = File('$res/mipmap-anydpi-v26/ic_launcher.xml').readAsStringSync();
      expect(adaptive, contains('<background android:drawable="@color/ic_launcher_background"'));
      expect(adaptive, contains('<foreground android:drawable="@mipmap/ic_launcher_foreground"'));
      final colors = File('$res/values/ic_launcher_background.xml').readAsStringSync();
      final background = RegExp('<color name="ic_launcher_background">(#[0-9A-Fa-f]{6})</color>').firstMatch(colors);
      expect(background?[1]?.toUpperCase(), brandGreen);
    });
  });
}
