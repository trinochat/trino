// Times and dates as the screens show them, in the app's language and the
// phone's 12 or 24 hour setting.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'scope.dart';

/// The hour of a message, such as "10:42".
String formatTime(BuildContext context, DateTime time) => MaterialLocalizations.of(context)
    .formatTimeOfDay(TimeOfDay.fromDateTime(time), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context));

/// The time of a chat's last activity: the hour today, "Ayer", the weekday
/// within the week, or the date.
String formatChatTime(BuildContext context, DateTime time, DateTime now) {
  final days = _daysBetween(time, now);
  if (days <= 0) return formatTime(context, time);
  if (days == 1) return context.l10n.yesterday;
  final locale = Localizations.localeOf(context).toLanguageTag();
  if (days < 7) return _capitalized(_trimDot(DateFormat.E(locale).format(time)));
  return _trimDot(DateFormat.MMMd(locale).format(time));
}

/// The separator above a day's messages: "Hoy", "Ayer", the weekday within
/// the week, or the date (with the year when it is not this one).
String formatDayLabel(BuildContext context, DateTime day, DateTime now) {
  final days = _daysBetween(day, now);
  if (days <= 0) return context.l10n.today;
  if (days == 1) return context.l10n.yesterday;
  final locale = Localizations.localeOf(context).toLanguageTag();
  if (days < 7) return _capitalized(DateFormat.EEEE(locale).format(day));
  if (day.year == now.year) return DateFormat.MMMMd(locale).format(day);
  return DateFormat.yMMMMd(locale).format(day);
}

/// A call's duration: "03:21", or "1:02:03" past an hour.
String formatDuration(Duration duration) {
  String two(int value) => value.toString().padLeft(2, '0');
  final minutes = duration.inMinutes.remainder(60);
  final seconds = duration.inSeconds.remainder(60);
  if (duration.inHours > 0) return '${duration.inHours}:${two(minutes)}:${two(seconds)}';
  return '${two(minutes)}:${two(seconds)}';
}

int _daysBetween(DateTime earlier, DateTime later) =>
    DateUtils.dateOnly(later).difference(DateUtils.dateOnly(earlier)).inDays;

String _capitalized(String text) =>
    text.isEmpty ? text : text.characters.first.toUpperCase() + text.characters.skip(1).string;

/// Short forms end in a dot in some languages ("mar.", "sept."): rows have
/// no room for it.
String _trimDot(String text) => text.endsWith('.') ? text.substring(0, text.length - 1) : text;

/// How long a call lasted, in the history: "45 s", "4 min", "1 h 5 min".
String formatCallLength(BuildContext context, Duration duration) {
  final l10n = context.l10n;
  if (duration.inMinutes < 1) return l10n.durationSeconds(duration.inSeconds);
  if (duration.inHours < 1) return l10n.durationMinutes(duration.inMinutes);
  return l10n.durationHours(duration.inHours, duration.inMinutes.remainder(60));
}

/// How long ago something came, for message requests: "ahora", "hace 5 min"
/// or "hace 2 h" today, then as a chat's time ("Ayer", "Lun", the date).
String formatAgo(BuildContext context, DateTime time, DateTime now) {
  if (_daysBetween(time, now) > 0) return formatChatTime(context, time, now);
  final elapsed = now.difference(time);
  if (elapsed.inMinutes < 1) return context.l10n.agoNow;
  if (elapsed.inHours < 1) return context.l10n.agoMinutes(elapsed.inMinutes);
  return context.l10n.agoHours(elapsed.inHours);
}

/// A file's size in the language's numbers: "850 B", "45 KB", "1,2 MB".
String formatFileSize(BuildContext context, int bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  final number = NumberFormat('#,##0.#', Localizations.localeOf(context).toLanguageTag()).format(value);
  return '$number ${units[unit]}';
}
