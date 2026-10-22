import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/screens/share_code_screen.dart';
import 'package:trino_mobile/ui/icon_button.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/settings_group.dart';
import 'package:trino_mobile/ui/switch_row.dart';

import '../support/app_harness.dart';

Future<void> openSection(WidgetTester tester, String section) async {
  await tester.tap(find.text(section));
  await tester.pumpAndSettle();
}

Future<void> back(WidgetTester tester, [String label = 'Volver']) async {
  await tester.tap(find.bySemanticsLabel(label));
  await tester.pumpAndSettle();
}

void main() {
  ListRow rowOf(WidgetTester tester, String title) =>
      tester.widget<ListRow>(find.ancestor(of: find.text(title), matching: find.byType(ListRow)));

  testWidgets('the profile card, then the groups: account, preferences and Avanzado', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Ajustes')), findsOneWidget);
    final groups = [
      for (final group in find.byType(SettingsGroup).evaluate())
        tester
            .widgetList<ListRow>(find.descendant(of: find.byWidget(group.widget), matching: find.byType(ListRow)))
            .map((row) => row.title)
            .toList(),
    ];
    expect(groups, [
      ['Sofía'],
      ['Cuenta y seguridad', 'Dispositivos', 'Privacidad'],
      ['Notificaciones', 'Apariencia', 'Idioma'],
      ['Avanzado'],
    ]);
    expect(rowOf(tester, 'Sofía').subtitle, 'Tu nombre y tu código', reason: 'no @nombre the engine does not have');
    expect(rowOf(tester, 'Dispositivos').value, '2');
    expect(rowOf(tester, 'Privacidad').subtitle, 'Cómo se conecta Trino');
    expect(rowOf(tester, 'Apariencia').value, 'Calma');
    expect(rowOf(tester, 'Idioma').value, 'Español');
    for (final missing in ['Seguridad', 'Accesibilidad', 'Apoyar a Trino']) {
      expect(find.text(missing), findsNothing, reason: missing);
    }
    for (final title in ['Cuenta y seguridad', 'Dispositivos', 'Privacidad', 'Notificaciones', 'Avanzado']) {
      expect(rowOf(tester, title).icon, isNotNull, reason: title);
    }
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('the QR button of the profile card opens your code, and Apariencia shows the style chosen', (
    tester,
  ) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    final qr = find.descendant(of: find.byType(SettingsGroup).first, matching: find.byType(TrinoIconButton));
    expect(
      (tester.widget<TrinoIconButton>(qr).icon, tester.widget<TrinoIconButton>(qr).label),
      (TrinoIcons.qr, 'Compartir mi código'),
    );
    await tester.tap(qr);
    await tester.pumpAndSettle();
    expect(find.byType(ShareCodeScreen), findsOneWidget);
    await back(tester);

    await openSection(tester, 'Apariencia');
    await tester.tap(find.text('Terminal'));
    await tester.pumpAndSettle();
    await back(tester);
    expect(rowOf(tester, 'Apariencia').value, 'Terminal');
  });

  testWidgets('Apariencia changes the theme at once: style, mode and accent', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Apariencia');
    expect(currentTheme(tester).style, TrinoStyle.calma);

    await tester.tap(find.text('Terminal'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).style, TrinoStyle.terminal);
    expect(currentTheme(tester).tokens.font, kPlexSans);

    await tester.tap(find.text('Oscuro'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).brightness, Brightness.dark);
    expect(currentTheme(tester).tokens, kThemes[ThemeId.terminalDark]);

    await tester.tap(find.bySemanticsLabel('Azul'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).tokens.accent, kAccentPalettes[Brightness.dark]![TrinoAccent.azul]!.accent);
    expect(tester.getSemantics(find.bySemanticsLabel('Azul')), isSemantics(isSelected: true));

    await tester.tap(find.text('Sistema'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).brightness, Brightness.light, reason: 'the test platform is light');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  group('Apariencia › Animaciones', () {
    Future<TestApp> openAnimations(WidgetTester tester) async {
      final app = await pumpApp(tester);
      await openTab(tester, 'Ajustes');
      await openSection(tester, 'Apariencia');
      await tester.scrollUntilVisible(find.text('Ninguna'), 100);
      await tester.pumpAndSettle();
      return app;
    }

    testWidgets('three choices with what each does, and the note; the phone\'s is the default', (tester) async {
      await openAnimations(tester);
      expect(find.text('Animaciones'), findsOneWidget);
      for (final (title, subtitle) in [
        ('Según el celular', 'Recomendado: sigue «Reducir movimiento» o «Quitar animaciones»'),
        ('Reducidas', 'Nada se desliza: solo fundidos cortos'),
        ('Ninguna', 'Todo cambia al instante'),
      ]) {
        expect(find.text(title), findsOneWidget);
        expect(find.text(subtitle), findsOneWidget);
      }
      expect(
        find.text('Las animaciones nunca esconden información: con cualquiera de las tres, la app hace lo mismo.'),
        findsOneWidget,
      );
      expect(tester.getSemantics(find.text('Según el celular')), isSemantics(isChecked: true));
      expect(tester.getSemantics(find.text('Ninguna')), isSemantics(isChecked: false));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('"Ninguna" is kept and stops the motion of the whole app, pages included', (tester) async {
      final app = await openAnimations(tester);
      await tester.tap(find.text('Ninguna'));
      await tester.pumpAndSettle();
      expect(app.appearance.value.animations, AnimationsSetting.none);
      expect(tester.getSemantics(find.text('Ninguna')), isSemantics(isChecked: true));
      expect(motionOf(tester.element(find.text('Ninguna'))), MotionLevel.none);

      // Back to Ajustes at once: no slide.
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));
      expect(find.text('Ninguna').hitTestable(), findsNothing);
      expect(find.text('Apariencia').hitTestable(), findsOneWidget);
    });

    testWidgets('"Reducidas" leaves only fades', (tester) async {
      await openAnimations(tester);
      await tester.tap(find.text('Reducidas'));
      await tester.pumpAndSettle();
      expect(motionOf(tester.element(find.text('Reducidas'))), MotionLevel.reduced);
    });

    testWidgets('in English and Portuguese too', (tester) async {
      await pumpApp(tester, locale: const Locale('en'));
      await openTab(tester, 'Settings');
      await openSection(tester, 'Appearance');
      await tester.scrollUntilVisible(find.text('None'), 100);
      expect(find.text('Animations'), findsOneWidget);
      expect(find.text('Same as the phone'), findsOneWidget);
    });
  });

  testWidgets('Idioma switches the whole app', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Idioma');
    expect(
      find.text('Al empezar, Trino usa el idioma de tu celular. Puedes cambiarlo aquí cuando quieras.'),
      findsOneWidget,
    );
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(find.text('At first, Trino uses your phone\'s language. You can change it here anytime.'), findsOneWidget);
    await back(tester, 'Back');
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Settings')), findsOneWidget);
  });

  testWidgets('Notificaciones keeps the preview choice and the switches', (tester) async {
    final app = await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Notificaciones');
    expect(find.text('Qué se ve en la notificación'), findsOneWidget);
    expect(tester.getSemantics(find.text('Solo el nombre (recomendado)')), isSemantics(isChecked: true));
    // Below the calls, which come first.
    await tester.ensureVisible(find.text('Silenciar grupos por defecto'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nada'));
    await tester.tap(find.text('Sonido de mensajes'));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(find.text('Nada')), isSemantics(isChecked: true));
    expect(
      tester.getSemantics(find.ancestor(of: find.text('Sonido de mensajes'), matching: find.byType(SwitchRow))),
      isSemantics(isToggled: false),
    );
    final settings = await tester.runAsync(() => app.engine.settings.first);
    expect((settings!.notificationPreview, settings.messageSound), (NotificationPreview.nothing, false));
  });

  testWidgets('Avanzado: your key, the relays as plain text, and the diagnostic log off', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Avanzado');
    expect(find.text('70A5 83C6 766D AAD7'), findsOneWidget);
    expect(find.text('wss://relay.damus.io'), findsOneWidget);
    expect(find.text('Conectado'), findsNWidgets(3));
    final log = find.ancestor(of: find.text('Registro de diagnóstico'), matching: find.byType(SwitchRow));
    expect(tester.getSemantics(log), isSemantics(isToggled: false));
  });

  testWidgets('the profile changes the name', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Sofía');
    await tester.enterText(find.byType(TextField), 'Sofía R.');
    await tester.tap(find.text('Guardar'));
    await tester.pumpAndSettle();
    expect(find.text('Guardado'), findsOneWidget);
    await back(tester);
    expect(find.text('Sofía R.'), findsOneWidget);
  });
}
