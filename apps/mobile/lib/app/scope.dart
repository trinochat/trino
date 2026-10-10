// What every screen reaches: the engine, the appearance, the language and the
// clock. Provided above the MaterialApp, so pushed pages see it too.
import 'package:flutter/widgets.dart';

import '../design/appearance.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import 'language.dart';

class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.engine,
    required this.appearance,
    required this.language,
    required this.clock,
    required super.child,
  });

  final TrinoEngine engine;
  final AppearanceController appearance;
  final LanguageController language;

  /// The time now; tests fix it.
  final DateTime Function() clock;

  static AppScope of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!;

  /// Without a dependency, for State lifecycle methods and callbacks. The
  /// scope never changes while the app runs.
  static AppScope read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!;

  @override
  bool updateShouldNotify(AppScope oldWidget) =>
      engine != oldWidget.engine ||
      appearance != oldWidget.appearance ||
      language != oldWidget.language ||
      clock != oldWidget.clock;
}

extension AppContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
  TrinoEngine get engine => AppScope.read(this).engine;
  DateTime now() => AppScope.read(this).clock();
}
