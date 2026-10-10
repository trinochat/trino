// The TestFlight workflow (.github/workflows/ios-testflight.yml) exports the
// iOS archive with ios/ExportOptions.plist. Only a Mac can run that step, so
// its options are checked here: an upload to App Store Connect, signed
// automatically by the team the project names, keeping the workflow's build
// number.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../support/native_config.dart';

void main() {
  test('uploads to App Store Connect, signed automatically by the project team', () {
    final project = File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();
    final team = xcodeBuildSettings(project, target: 'Runner')['Release']!['DEVELOPMENT_TEAM'];

    final options = Plist.read('ios/ExportOptions.plist');
    expect(options.string('method'), 'app-store-connect');
    expect(options.string('destination'), 'upload');
    expect(options.string('signingStyle'), 'automatic');
    expect(options.string('teamID'), allOf(isNotNull, team));
    expect(options.boolean('manageAppVersionAndBuildNumber'), isFalse);
  });
}
