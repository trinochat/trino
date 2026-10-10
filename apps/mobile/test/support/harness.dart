// Pumps widgets inside the app's theme and localizations, so tests see what
// users see: the tokens of a given appearance, in Spanish unless told
// otherwise, at a phone size.
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/theme.dart';

export 'package:trino_mobile/design/icons.dart';
export 'package:trino_mobile/design/theme.dart';

/// A phone the size the approved mock was drawn at.
const phoneSize = Size(390, 844);

const supportedLocales = [Locale('es'), Locale('en'), Locale('pt')];

/// Sets the test view to a phone, restored after the test.
void usePhone(WidgetTester tester, {Size size = phoneSize}) {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

/// Pumps [child] in a themed, localized Scaffold.
Future<void> pumpThemed(
  WidgetTester tester,
  Widget child, {
  TrinoStyle style = TrinoStyle.calma,
  Brightness brightness = Brightness.light,
  TrinoAccent accent = TrinoAccent.verde,
  double textScale = 1,
  Locale locale = const Locale('es'),
  bool center = true,
}) async {
  usePhone(tester);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildTrinoTheme(style, brightness, accent),
      themeAnimationDuration: Duration.zero,
      locale: locale,
      supportedLocales: supportedLocales,
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      builder: (context, app) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
        child: app!,
      ),
      home: Scaffold(
        body: SafeArea(child: center ? Center(child: child) : child),
      ),
    ),
  );
}

/// The tokens the pumped app is using.
ThemeTokens tokensIn(WidgetTester tester, [Finder? finder]) =>
    Theme.of(tester.element(finder ?? find.byType(Scaffold).first)).extension<TrinoTheme>()!.tokens;

/// The colour of the nearest box decoration at or above [finder]'s first match.
Color? fillOf(WidgetTester tester, Finder finder) {
  final element = tester.element(finder);
  Color? color;
  void visit(Element e) {
    final widget = e.widget;
    if (color != null || widget is! DecoratedBox) return;
    color = switch (widget.decoration) {
      final BoxDecoration box => box.color,
      final ShapeDecoration shape => shape.color,
      _ => null,
    };
  }

  visit(element);
  element.visitAncestorElements((ancestor) {
    visit(ancestor);
    return color == null;
  });
  return color;
}

/// The text colour of the [Text] that shows [text].
Color? colorOfText(WidgetTester tester, String text) {
  final element = tester.element(find.text(text).first);
  final widget = element.widget as Text;
  return widget.style?.color ?? DefaultTextStyle.of(element).style.color;
}

/// The first painter of type [T] under [finder], such as an icon's.
T painterOf<T extends CustomPainter>(WidgetTester tester, Finder finder) =>
    tester
            .widget<CustomPaint>(
              find
                  .descendant(of: finder, matching: find.byWidgetPredicate((w) => w is CustomPaint && w.painter is T))
                  .first,
            )
            .painter!
        as T;

/// The text spans of a rich text, leaves only, in order.
List<TextSpan> leafSpans(InlineSpan root) {
  final leaves = <TextSpan>[];
  root.visitChildren((span) {
    if (span is TextSpan && span.text != null) leaves.add(span);
    return true;
  });
  return leaves;
}
