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

  // TestFlight showed builds but would not install them (21 Oct 2026), so the
  // workflow also exports an .ipa signed Ad Hoc for the iPhones registered in
  // the account, as spike/ios-tor does, and keeps it as the run's artifact.
  test('also exports an Ad Hoc .ipa, before and apart from the TestFlight upload', () {
    final project = File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();
    final team = xcodeBuildSettings(project, target: 'Runner')['Release']!['DEVELOPMENT_TEAM'];
    final adHoc = Plist.read('ios/ExportOptions-AdHoc.plist');
    expect(adHoc.string('method'), 'release-testing');
    expect(adHoc.string('destination'), 'export');
    expect(adHoc.string('signingStyle'), 'automatic');
    expect(adHoc.string('teamID'), allOf(isNotNull, team));
    expect(adHoc.boolean('manageAppVersionAndBuildNumber'), isFalse);

    final workflow = File('../../.github/workflows/ios-testflight.yml').readAsStringSync();
    final adHocStep = workflow.indexOf('-exportOptionsPlist ExportOptions-AdHoc.plist');
    final upload = workflow.indexOf('-exportOptionsPlist ExportOptions.plist');
    expect(adHocStep, isNonNegative, reason: 'the Ad Hoc export');
    expect(adHocStep, lessThan(upload), reason: 'the .ipa is kept even if the upload fails');
    expect(workflow, contains('continue-on-error: true'), reason: 'a failed Ad Hoc export does not stop the upload');
    expect(workflow, contains('actions/upload-artifact@'), reason: 'the .ipa stays as the run artifact');
  });
}
