import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/platform/call_sounds.dart';
import 'package:trino_mobile/sound/tones.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(PlatformCallSounds.channelName);
  late List<MethodCall> calls;
  Object? Function(MethodCall call) answer = (_) => null;

  setUp(() {
    calls = [];
    answer = (_) => null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return answer(call);
    });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
  );

  Map<Object?, Object?> argsOf(MethodCall call) => call.arguments as Map<Object?, Object?>;

  test('one channel, named after the app', () {
    expect(PlatformCallSounds.channelName, 'org.trinochat.app/call_sounds');
  });

  test('"Trino suave" plays its two softer rings once, then loops the ring at the volume, as a ringtone', () async {
    await PlatformCallSounds().startRingtone(80);
    expect(calls.single.method, 'playLoop');
    final args = argsOf(calls.single);
    final tone = ringtone(80);
    expect(args['usage'], 'ringtone');
    expect(args['intro'], wav(tone.intro));
    expect(args['loop'], wav(tone.loop));
  });

  test('the ringback loops on the voice stream, with no intro', () async {
    await PlatformCallSounds().startRingback(60);
    final args = argsOf(calls.single);
    expect(calls.single.method, 'playLoop');
    expect(args['usage'], 'voice');
    expect(args['intro'], isNull);
    expect(args['loop'], wav(ringbackCycle(60)));
  });

  test('the end tone plays once on the voice stream; a preview plays one ring at the volume', () async {
    final sounds = PlatformCallSounds();
    await sounds.playEndTone(60);
    await sounds.previewRingtone(30);
    expect([for (final call in calls) call.method], ['playOnce', 'playOnce']);
    expect(argsOf(calls[0]), {'usage': 'voice', 'wav': wav(endTone(60))});
    expect(argsOf(calls[1]), {'usage': 'ringtone', 'wav': wav(ringtone(30).loop)});
  });

  test('vibrates with the ring cadence until cancelled, and stops', () async {
    final sounds = PlatformCallSounds();
    await sounds.startVibration();
    await sounds.stopVibration();
    await sounds.stop();
    expect([for (final call in calls) call.method], ['vibrate', 'cancelVibration', 'stop']);
    final pattern = argsOf(calls[0])['pattern']! as List<Object?>;
    expect(pattern, [0, 800, 1400]);
    expect(pattern.cast<int>().fold(0, (a, b) => a + b), softRingEvery.inMilliseconds, reason: 'with each ring');
  });

  test('reads the ringer mode; anything else, or no answer, is unknown', () async {
    final sounds = PlatformCallSounds();
    for (final (reply, mode) in [
      ('normal', RingerMode.normal),
      ('vibrate', RingerMode.vibrate),
      ('silent', RingerMode.silent),
      ('unknown', RingerMode.unknown),
      (null, RingerMode.unknown),
    ]) {
      answer = (_) => reply;
      expect(await sounds.ringerMode(), mode, reason: '$reply');
    }
  });

  test('without the native side (or when it fails) nothing throws and the mode is unknown', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    final sounds = PlatformCallSounds();
    await sounds.startRingtone(60);
    await sounds.stop();
    expect(await sounds.ringerMode(), RingerMode.unknown);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (call) async => throw PlatformException(code: 'audio'),
    );
    await sounds.startRingback(60);
    expect(await sounds.ringerMode(), RingerMode.unknown);
  });

  test('the demo plays nothing and keeps what it was asked, for the tests', () async {
    final demo = DemoCallSounds(mode: RingerMode.vibrate);
    await demo.startRingtone(60);
    await demo.startVibration();
    await demo.stop();
    await demo.stopVibration();
    expect(demo.log, ['ringtone 60', 'vibrate', 'stop', 'stopVibration']);
    expect(await demo.ringerMode(), RingerMode.vibrate);
    expect(calls, isEmpty);
  });
}
