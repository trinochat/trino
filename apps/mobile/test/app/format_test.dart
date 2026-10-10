import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/app/format.dart';
import 'package:trino_mobile/l10n/app_localizations.dart';

/// 11:00 on Friday 9 October 2026.
final now = DateTime(2026, 10, 9, 11);

Future<BuildContext> contextIn(WidgetTester tester, Locale locale) async {
  late BuildContext captured;
  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [AppLocalizations.delegate, ...GlobalMaterialLocalizations.delegates],
      home: Builder(
        builder: (context) {
          captured = context;
          return const SizedBox();
        },
      ),
    ),
  );
  await tester.pumpAndSettle();
  return captured;
}

void main() {
  testWidgets('chat times: the hour today, "Ayer", the weekday this week, the date before', (tester) async {
    final context = await contextIn(tester, const Locale('es'));
    expect(formatChatTime(context, DateTime(2026, 10, 9, 10, 42), now), '10:42');
    expect(formatChatTime(context, DateTime(2026, 10, 9, 9, 15), now), '9:15');
    expect(formatChatTime(context, DateTime(2026, 10, 8, 18, 30), now), 'Ayer');
    expect(formatChatTime(context, DateTime(2026, 10, 6, 19, 15), now), 'Mar');
    expect(formatChatTime(context, DateTime(2026, 9, 28, 12), now), '28 sept');
  });

  testWidgets('day separators: "Hoy", "Ayer", the weekday, then the date', (tester) async {
    final context = await contextIn(tester, const Locale('es'));
    expect(formatDayLabel(context, DateTime(2026, 10, 9, 8), now), 'Hoy');
    expect(formatDayLabel(context, DateTime(2026, 10, 8, 23), now), 'Ayer');
    expect(formatDayLabel(context, DateTime(2026, 10, 6, 19), now), 'Martes');
    expect(formatDayLabel(context, DateTime(2026, 9, 28, 12), now), '28 de septiembre');
    expect(formatDayLabel(context, DateTime(2025, 12, 31, 12), now), '31 de diciembre de 2025');
  });

  testWidgets('follows the language', (tester) async {
    final context = await contextIn(tester, const Locale('en'));
    expect(formatChatTime(context, DateTime(2026, 10, 8, 18, 30), now), 'Yesterday');
    expect(formatChatTime(context, DateTime(2026, 10, 6, 19, 15), now), 'Tue');
    expect(formatDayLabel(context, DateTime(2026, 10, 9, 8), now), 'Today');
  });

  test('call durations: minutes and seconds, hours when they come', () {
    expect(formatDuration(const Duration(minutes: 3, seconds: 21)), '03:21');
    expect(formatDuration(Duration.zero), '00:00');
    expect(formatDuration(const Duration(hours: 1, minutes: 2, seconds: 3)), '1:02:03');
  });
}
