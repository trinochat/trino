import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/appearance.dart';
import 'package:trino_mobile/design/theme.dart';

void main() {
  test('a fresh install looks like the desktop default: Calma, light, verde', () {
    final appearance = AppearanceController();
    expect(
      appearance.value,
      const Appearance(style: TrinoStyle.calma, mode: AppearanceMode.light, accent: TrinoAccent.verde),
    );
    expect(appearance.themeMode, ThemeMode.light);
    appearance.dispose();
  });

  test('each change notifies once, and a repeated value not at all', () {
    final appearance = AppearanceController();
    var notified = 0;
    appearance.addListener(() => notified++);

    appearance.setStyle(TrinoStyle.terminal);
    appearance.setMode(AppearanceMode.dark);
    appearance.setAccent(TrinoAccent.morado);
    expect(notified, 3);

    appearance.setStyle(TrinoStyle.terminal);
    appearance.setMode(AppearanceMode.dark);
    appearance.setAccent(TrinoAccent.morado);
    expect(notified, 3);
    expect(
      appearance.value,
      const Appearance(style: TrinoStyle.terminal, mode: AppearanceMode.dark, accent: TrinoAccent.morado),
    );
    appearance.dispose();
  });

  test('gives the light and dark themes of the chosen style and accent', () {
    final appearance = AppearanceController(const Appearance(style: TrinoStyle.terminal, accent: TrinoAccent.azul));
    expect(
      appearance.lightTheme.extension<TrinoTheme>()!.tokens,
      resolveTokens(TrinoStyle.terminal, Brightness.light, TrinoAccent.azul),
    );
    expect(
      appearance.darkTheme.extension<TrinoTheme>()!.tokens,
      resolveTokens(TrinoStyle.terminal, Brightness.dark, TrinoAccent.azul),
    );
    appearance.dispose();
  });

  test('maps the mode onto Flutter theme modes, system included', () {
    final appearance = AppearanceController();
    for (final (mode, themeMode) in [
      (AppearanceMode.light, ThemeMode.light),
      (AppearanceMode.dark, ThemeMode.dark),
      (AppearanceMode.system, ThemeMode.system),
    ]) {
      appearance.setMode(mode);
      expect(appearance.themeMode, themeMode);
    }
    appearance.dispose();
  });
}
