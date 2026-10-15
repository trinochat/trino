import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/switch_row.dart';

import '../support/app_harness.dart';

Future<TestApp> openNotifications(WidgetTester tester, {VoidCallback? demoIncomingCall}) async {
  final app = await pumpApp(tester, demoIncomingCall: demoIncomingCall);
  await openTab(tester, 'Ajustes');
  // At twice the text size the row starts below the screen.
  await tester.scrollUntilVisible(find.text('Notificaciones'), 200, scrollable: find.byType(Scrollable).first);
  await tester.tap(find.text('Notificaciones'));
  await tester.pumpAndSettle();
  return app;
}

Future<EngineSettings> settingsOf(WidgetTester tester, TestApp app) async =>
    (await tester.runAsync(() => app.engine.settings.first))!;

void main() {
  testWidgets('"Llamadas" first, as in the mock: the tone, its volume, vibrating and the note on silent mode', (
    tester,
  ) async {
    await openNotifications(tester);
    expect(find.text('Llamadas'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Llamadas')).dy,
      lessThan(tester.getTopLeft(find.text('Qué se ve en la notificación')).dy),
    );
    expect(find.text('Tono de llamada'), findsOneWidget);
    expect(find.text('Trino suave'), findsOneWidget);
    expect(find.text('Volumen del tono'), findsOneWidget);
    expect(find.text('Empieza suave y sube poco a poco.'), findsOneWidget);
    expect(find.text('Vibrar al recibir una llamada'), findsOneWidget);
    expect(
      find.text('Trino respeta el modo del celular: en vibración solo vibra, y en silencio no suena.'),
      findsOneWidget,
    );
    expect(
      tester.getSemantics(
        find.ancestor(of: find.text('Vibrar al recibir una llamada'), matching: find.byType(SwitchRow)),
      ),
      isSemantics(isToggled: true),
    );
    expect(
      tester.getSemantics(find.bySemanticsLabel('Volumen del tono')),
      isSemantics(label: 'Volumen del tono', value: '60 %', isSlider: true),
    );
    expect(find.textContaining('demostración'), findsNothing, reason: 'the demo entry only shows in the demo app');
  });

  testWidgets('"Tono de llamada" opens the two choices; "Silencio" is kept by the engine', (tester) async {
    final app = await openNotifications(tester);
    await tester.tap(find.text('Tono de llamada'));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(find.text('Trino suave').last), isSemantics(isChecked: true));
    await tester.tap(find.text('Silencio'));
    await tester.pumpAndSettle();
    expect(find.text('Silencio'), findsOneWidget, reason: 'the sheet closed and the row shows the choice');
    expect((await settingsOf(tester, app)).ringtone, Ringtone.silent);
  });

  testWidgets('the volume slider saves the volume and plays one ring at it, once you let go', (tester) async {
    final app = await openNotifications(tester);
    final slider = find.byType(Slider);
    final box = tester.getRect(slider);
    // Drag the thumb to the far right.
    await tester.dragFrom(tester.getCenter(slider), Offset(box.width, 0));
    await tester.pumpAndSettle();
    expect((await settingsOf(tester, app)).ringVolume, 100);
    expect(app.sounds.log, ['preview 100'], reason: 'one preview, at the end of the drag');
    expect(tester.getSemantics(find.bySemanticsLabel('Volumen del tono')), isSemantics(value: '100 %'));
  });

  testWidgets('with "Silencio", changing the volume plays no preview: it is the ringback\'s', (tester) async {
    final app = await openNotifications(tester);
    await tester.tap(find.text('Tono de llamada'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Silencio'));
    await tester.pumpAndSettle();
    final slider = find.byType(Slider);
    await tester.dragFrom(tester.getCenter(slider), Offset(-tester.getRect(slider).width, 0));
    await tester.pumpAndSettle();
    expect((await settingsOf(tester, app)).ringVolume, 0);
    expect(app.sounds.log, isEmpty);
  });

  testWidgets('"Vibrar al recibir una llamada" can be turned off', (tester) async {
    final app = await openNotifications(tester);
    await tester.tap(find.text('Vibrar al recibir una llamada'));
    await tester.pumpAndSettle();
    expect((await settingsOf(tester, app)).vibrateOnRing, isFalse);
  });

  testWidgets('in the demo app, a labelled entry rings a call', (tester) async {
    var rang = 0;
    await openNotifications(tester, demoIncomingCall: () => rang++);
    final entry = find.text('Simular una llamada entrante (demostración)');
    await tester.ensureVisible(entry);
    await tester.tap(entry);
    await tester.pumpAndSettle();
    expect(rang, 1);
  });

  testWidgets('fits and meets the target guidelines at twice the text size', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await openNotifications(tester);
    expect(tester.takeException(), isNull);
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('in English and Portuguese', (tester) async {
    await pumpApp(tester, locale: const Locale('pt'));
    await openTab(tester, 'Configurações');
    await tester.tap(find.text('Notificações'));
    await tester.pumpAndSettle();
    expect(find.text('Chamadas'), findsOneWidget);
    expect(find.text('Volume do toque'), findsOneWidget);
  });
}
