import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/platform/proximity.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(PlatformProximityScreen.channelName);
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late List<String> calls;

  setUp(() {
    calls = [];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return call.method == 'enable' ? true : null;
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('one channel, named after the app', () {
    expect(PlatformProximityScreen.channelName, 'org.trinochat.app/proximity');
  });

  test('enable and disable go to the native side', () async {
    final sensor = PlatformProximityScreen();
    await sensor.enable();
    await sensor.disable();
    expect(calls, ['enable', 'disable']);
  });

  test('without the native side, or when it fails, nothing throws', () async {
    messenger.setMockMethodCallHandler(channel, null);
    await PlatformProximityScreen().enable();
    messenger.setMockMethodCallHandler(channel, (call) async => throw PlatformException(code: 'sensor'));
    await PlatformProximityScreen().disable();
  });

  test('the demo keeps the state and what it was asked', () async {
    final demo = DemoProximityScreen();
    await demo.enable();
    expect(demo.enabled, isTrue);
    await demo.disable();
    expect(demo.enabled, isFalse);
    expect(demo.log, ['enable', 'disable']);
  });
}
