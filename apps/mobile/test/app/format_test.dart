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

  testWidgets('how long a call lasted, in the history: seconds, minutes, hours and minutes', (tester) async {
    final context = await contextIn(tester, const Locale('es'));
    expect(formatCallLength(context, const Duration(seconds: 45)), '45 s');
    expect(formatCallLength(context, const Duration(minutes: 4, seconds: 59)), '4 min');
    expect(formatCallLength(context, const Duration(hours: 1, minutes: 5)), '1 h 5 min');
  });

  testWidgets('how long ago, for requests: now, minutes and hours today, then as chat times', (tester) async {
    final context = await contextIn(tester, const Locale('es'));
    expect(formatAgo(context, now.subtract(const Duration(seconds: 30)), now), 'ahora');
    expect(formatAgo(context, now.subtract(const Duration(minutes: 5)), now), 'hace 5 min');
    expect(formatAgo(context, DateTime(2026, 10, 9, 8, 15), now), 'hace 2 h');
    expect(formatAgo(context, DateTime(2026, 10, 8, 20, 15), now), 'Ayer');
    expect(formatAgo(context, DateTime(2026, 10, 5, 9, 30), now), 'Lun');
  });

  testWidgets('file sizes, with the decimal comma of the language', (tester) async {
    final context = await contextIn(tester, const Locale('es'));
    expect(formatFileSize(context, 1200000), '1,2 MB');
    expect(formatFileSize(context, 850), '850 B');
    expect(formatFileSize(context, 45000), '45 KB');
    expect(formatFileSize(context, 3000000000), '3 GB');
    final english = await contextIn(tester, const Locale('en'));
    expect(formatFileSize(english, 1200000), '1.2 MB');
  });
}
