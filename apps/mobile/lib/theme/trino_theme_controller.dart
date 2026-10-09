import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'trino_theme.dart';

class TrinoThemeController extends ChangeNotifier {
  TrinoThemeController();

  static const _presetKey = 'appearance.preset';
  static const _accentKey = 'appearance.accent';

  TrinoThemePreference _preference = const TrinoThemePreference();

  TrinoThemePreference get preference => _preference;

  Future<void> load() async {
    try {
      final preferences = SharedPreferencesAsync();
      final savedPreset = await preferences.getString(_presetKey);
      final savedAccent = await preferences.getInt(_accentKey);
      final preset = TrinoThemePreset.values.firstWhere(
        (value) => value.name == savedPreset,
        orElse: () => TrinoThemePreset.hacker,
      );
      _preference = TrinoThemePreference(
        preset: preset,
        accent: savedAccent == null
            ? const Color(0xFF35E875)
            : Color(savedAccent),
      );
      notifyListeners();
    } catch (_) {
      // The default remains usable when platform storage is unavailable.
    }
  }

  Future<void> setPreset(TrinoThemePreset preset) async {
    if (_preference.preset == preset) return;
    _preference = _preference.copyWith(preset: preset);
    notifyListeners();
    try {
      await SharedPreferencesAsync().setString(_presetKey, preset.name);
    } catch (_) {
      // Keep the in-memory selection for this session.
    }
  }

  Future<void> setAccent(Color accent) async {
    if (_preference.accent == accent) return;
    _preference = _preference.copyWith(accent: accent);
    notifyListeners();
    try {
      await SharedPreferencesAsync().setInt(_accentKey, accent.toARGB32());
    } catch (_) {
      // Keep the in-memory selection for this session.
    }
  }
}

class TrinoThemeScope extends InheritedNotifier<TrinoThemeController> {
  const TrinoThemeScope({
    required TrinoThemeController controller,
    required super.child,
    super.key,
  }) : super(notifier: controller);

  static TrinoThemeController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<TrinoThemeScope>();
    assert(scope != null, 'TrinoThemeScope is missing above this context');
    return scope!.notifier!;
  }
}
