// Reads the desktop design tokens (src/design/tokens.ts of the monorepo), so
// the tests can check that the Dart port has not drifted from them. Only the
// literal shapes tokens.ts uses are understood: quoted strings and the font
// stack constants.
import 'dart:io';

/// Where tokens.ts is: `--dart-define=TRINO_DESKTOP_TOKENS=<path>`, or its
/// place in the monorepo, two levels above this package.
File desktopTokensFile() {
  const defined = String.fromEnvironment('TRINO_DESKTOP_TOKENS');
  return File(defined.isNotEmpty ? defined : '../../src/design/tokens.ts');
}

class DesktopTokens {
  DesktopTokens._(this.themes, this.accentPalettes);

  /// Theme id (`calma-light`) → token → raw value, with the font constants
  /// replaced by their CSS stacks.
  final Map<String, Map<String, String>> themes;

  /// Mode (`light`) → accent (`azul`) → token → raw value.
  final Map<String, Map<String, Map<String, String>>> accentPalettes;

  static DesktopTokens parse(String source) {
    final constants = <String, String>{
      for (final match in RegExp(r'''const (\w+) = "([^"]*)";''').allMatches(source)) match[1]!: match[2]!,
    };

    Map<String, String> entries(String body) => {
      for (final match in RegExp(r'''(\w+): (?:'([^']*)'|"([^"]*)"|([A-Z_]+))''').allMatches(body))
        match[1]!: match[2] ?? match[3] ?? constants[match[4]]!,
    };

    final themesStart = source.indexOf('export const THEMES');
    final palettesStart = source.indexOf('export const ACCENT_PALETTES');
    if (themesStart < 0 || palettesStart < 0) {
      throw const FormatException('tokens.ts no longer declares THEMES and ACCENT_PALETTES');
    }

    final themes = <String, Map<String, String>>{
      for (final match in RegExp(
        r"'([a-z]+-[a-z]+)': \{(.*?)\n  \}",
        dotAll: true,
      ).allMatches(source.substring(themesStart, palettesStart)))
        match[1]!: entries(match[2]!),
    };

    final palettesSource = source.substring(palettesStart);
    final modes = RegExp(r'\n  (light|dark): \{').allMatches(palettesSource).toList();
    final palettes = <String, Map<String, Map<String, String>>>{};
    for (var index = 0; index < modes.length; index++) {
      final end = index + 1 < modes.length ? modes[index + 1].start : palettesSource.length;
      final body = palettesSource.substring(modes[index].end, end);
      palettes[modes[index][1]!] = {
        for (final match in RegExp(r'(\w+): \{([^}]*)\}').allMatches(body)) match[1]!: entries(match[2]!),
      };
    }
    return DesktopTokens._(themes, palettes);
  }
}
