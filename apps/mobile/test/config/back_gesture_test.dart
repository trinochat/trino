// Android sends the back gesture to Flutter as it is dragged (predictive back,
// Android 14+) only when the app says it handles it; without the flag the
// preview in lib/design/predictive_back.dart never shows on a phone.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the Android app takes the back gesture as it is dragged', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync()
        .replaceAll(RegExp('<!--.*?-->', dotAll: true), '');
    final application = RegExp(r'<application\b[^>]*>').firstMatch(manifest)![0]!;
    expect(RegExp(r'android:enableOnBackInvokedCallback="([^"]*)"').firstMatch(application)?[1], 'true');
  });
}
