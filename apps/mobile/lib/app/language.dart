// The language the user chose; null follows the phone's.
import 'package:flutter/widgets.dart';

class LanguageController extends ChangeNotifier {
  LanguageController([Locale? locale]) : _locale = locale;

  Locale? _locale;

  /// Null: the phone's language, when Trino has it, or Spanish.
  Locale? get locale => _locale;

  void setLocale(Locale? locale) {
    if (locale == _locale) return;
    _locale = locale;
    notifyListeners();
  }
}

/// The app's languages, each named in itself.
const kLanguages = [
  (locale: Locale('es'), name: 'Español'),
  (locale: Locale('en'), name: 'English'),
  (locale: Locale('pt'), name: 'Português'),
];

String languageName(Locale locale) =>
    kLanguages.firstWhere((l) => l.locale.languageCode == locale.languageCode, orElse: () => kLanguages.first).name;
