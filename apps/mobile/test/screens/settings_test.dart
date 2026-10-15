import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/ui/list_row.dart';
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
  testWidgets('the profile row, then Notificaciones, Privacidad, Seguridad, Apariencia, Idioma and Avanzado', (
    tester,
  ) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Ajustes')), findsOneWidget);
    expect(find.text('Sofía'), findsOneWidget);
    expect(find.text('Tu nombre y tu código'), findsOneWidget);
    final rows = tester.widgetList<ListRow>(find.byType(ListRow)).map((row) => row.title).toList();
    expect(rows, [
      'Sofía',
      'Notificaciones',
      'Privacidad',
      'Cuenta y seguridad',
      'Dispositivos',
      'Apariencia',
      'Idioma',
      'Avanzado',
    ]);
    expect(
      tester.widget<ListRow>(find.ancestor(of: find.text('Dispositivos'), matching: find.byType(ListRow))).value,
      '2',
    );
    final idioma = tester.widget<ListRow>(find.ancestor(of: find.text('Idioma'), matching: find.byType(ListRow)));
    expect(idioma.value, 'Español');
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

  testWidgets('Privacidad: staying connected with Trino closed on, connecting only after unlocking off', (
    tester,
  ) async {
    final app = await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    await openSection(tester, 'Privacidad');
    final keep = find.ancestor(of: find.text('Seguir conectado con Trino cerrado'), matching: find.byType(SwitchRow));
    expect(tester.getSemantics(keep), isSemantics(isToggled: true));
    final afterUnlock = find.ancestor(
      of: find.text('Conectarse solo después de desbloquear'),
      matching: find.byType(SwitchRow),
    );
    expect(tester.getSemantics(afterUnlock), isSemantics(isToggled: false));
    expect(find.text('Ocultar mi IP con Tor'), findsNothing);

    await tester.tap(afterUnlock);
    await tester.pumpAndSettle();
    final settings = await tester.runAsync(() => app.engine.settings.first);
    expect(settings!.connectAfterUnlockOnly, isTrue);
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
