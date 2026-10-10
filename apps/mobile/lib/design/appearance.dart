// The appearance the user chose: style, mode and accent, as on the desktop
// (src/design/appearance.ts). Changes apply at once to the whole app.
import 'package:flutter/material.dart';

import 'theme.dart';

enum AppearanceMode { light, dark, system }

@immutable
class Appearance {
  /// The default of a fresh install: Calma, light, verde.
  const Appearance({this.style = TrinoStyle.calma, this.mode = AppearanceMode.light, this.accent = TrinoAccent.verde});

  final TrinoStyle style;
  final AppearanceMode mode;
  final TrinoAccent accent;

  Appearance copyWith({TrinoStyle? style, AppearanceMode? mode, TrinoAccent? accent}) =>
      Appearance(style: style ?? this.style, mode: mode ?? this.mode, accent: accent ?? this.accent);

  @override
  bool operator ==(Object other) =>
      other is Appearance && other.style == style && other.mode == mode && other.accent == accent;

  @override
  int get hashCode => Object.hash(style, mode, accent);

  @override
  String toString() => 'Appearance(${style.name}, ${mode.name}, ${accent.name})';
}

class AppearanceController extends ChangeNotifier {
  AppearanceController([Appearance initial = const Appearance()]) : _value = initial;

  Appearance _value;
  ThemeData? _light;
  ThemeData? _dark;

  Appearance get value => _value;

  ThemeData get lightTheme => _light ??= buildTrinoTheme(_value.style, Brightness.light, _value.accent);
  ThemeData get darkTheme => _dark ??= buildTrinoTheme(_value.style, Brightness.dark, _value.accent);

  ThemeMode get themeMode => switch (_value.mode) {
    AppearanceMode.light => ThemeMode.light,
    AppearanceMode.dark => ThemeMode.dark,
    AppearanceMode.system => ThemeMode.system,
  };

  void setStyle(TrinoStyle style) => _update(_value.copyWith(style: style));
  void setMode(AppearanceMode mode) => _update(_value.copyWith(mode: mode));
  void setAccent(TrinoAccent accent) => _update(_value.copyWith(accent: accent));

  void _update(Appearance next) {
    if (next == _value) return;
    _value = next;
    _light = _dark = null;
    notifyListeners();
  }
}
