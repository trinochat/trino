import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/harness.dart';

OutlineInputBorder borderOf(WidgetTester tester, {bool focused = false}) {
  final decoration = tester.widget<TextField>(find.byType(TextField)).decoration!;
  return (focused ? decoration.focusedBorder : decoration.enabledBorder)! as OutlineInputBorder;
}

void main() {
  group('TrinoTextField', () {
    testWidgets('shows its label above and gives it to screen readers', (tester) async {
      await pumpThemed(
        tester,
        const SizedBox(
          width: 320,
          child: TrinoTextField(label: 'Nombre', hint: 'Cómo te verán'),
        ),
      );
      expect(find.text('Nombre'), findsOneWidget);
      final semantics = tester.getSemantics(find.byType(TextField));
      expect(semantics.label, contains('Nombre'));
      expect(semantics, isSemantics(isTextField: true));
    });

    testWidgets('a field without a visible label can still be named', (tester) async {
      await pumpThemed(
        tester,
        const SizedBox(
          width: 320,
          child: TrinoTextField(semanticLabel: 'Buscar chats', hint: 'Buscar'),
        ),
      );
      expect(tester.getSemantics(find.byType(TextField)).label, contains('Buscar chats'));
    });

    testWidgets('draws a 3:1 boundary in controlLine, and a 2 dp accent ring when focused', (tester) async {
      await pumpThemed(tester, const SizedBox(width: 320, child: TrinoTextField(label: 'Nombre')));
      final t = tokensIn(tester);
      expect(borderOf(tester).borderSide.color, t.controlLine);
      expect(borderOf(tester).borderSide.width, 1);
      expect(borderOf(tester, focused: true).borderSide.color, t.accentText);
      expect(borderOf(tester, focused: true).borderSide.width, 2);
      expect(tester.getSize(find.byType(TextField)).height, greaterThanOrEqualTo(48));
    });

    testWidgets('an error turns the boundary to danger and shows the message', (tester) async {
      await pumpThemed(
        tester,
        const SizedBox(
          width: 320,
          child: TrinoTextField(label: 'Repite la contraseña', error: 'Las contraseñas no coinciden.'),
        ),
      );
      final t = tokensIn(tester);
      expect(borderOf(tester).borderSide.color, t.danger);
      expect(find.text('Las contraseñas no coinciden.'), findsOneWidget);
      expect(colorOfText(tester, 'Las contraseñas no coinciden.'), t.danger);
      expect(tester.getSemantics(find.byType(TextField)).label, contains('Las contraseñas no coinciden.'));
    });

    testWidgets('passes typing to its controller and to onChanged', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      final changes = <String>[];
      await pumpThemed(
        tester,
        SizedBox(
          width: 320,
          child: TrinoTextField(label: 'Nombre', controller: controller, onChanged: changes.add),
        ),
      );
      await tester.enterText(find.byType(TextField), 'Sofía');
      expect(controller.text, 'Sofía');
      expect(changes, ['Sofía']);
    });

    testWidgets('a multiline field grows with its lines', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpThemed(
        tester,
        SizedBox(
          width: 320,
          child: TrinoTextField(semanticLabel: 'Mensaje', controller: controller, maxLines: 5),
        ),
      );
      final oneLine = tester.getSize(find.byType(TextField)).height;
      await tester.enterText(find.byType(TextField), 'Uno\nDos\nTres');
      await tester.pump();
      expect(tester.getSize(find.byType(TextField)).height, greaterThan(oneLine));
    });
  });

  group('TrinoPasswordField', () {
    testWidgets('hides the password until its toggle shows it', (tester) async {
      await pumpThemed(
        tester,
        const SizedBox(
          width: 320,
          child: TrinoPasswordField(label: 'Contraseña', showLabel: 'Mostrar contraseña'),
        ),
      );
      expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isTrue);
      final toggle = find.bySemanticsLabel('Mostrar contraseña');
      expect(tester.getSemantics(toggle), isSemantics(hasToggledState: true, isToggled: false));
      await tester.tap(toggle);
      await tester.pump();
      expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isFalse);
      expect(tester.getSemantics(toggle), isSemantics(isToggled: true));
    });

    testWidgets('keeps the password away from suggestions and autocorrection', (tester) async {
      await pumpThemed(
        tester,
        const SizedBox(
          width: 320,
          child: TrinoPasswordField(label: 'Contraseña', showLabel: 'Mostrar contraseña'),
        ),
      );
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.autocorrect, isFalse);
      expect(field.enableSuggestions, isFalse);
      expect(field.keyboardType, TextInputType.visiblePassword);
    });
  });
}
