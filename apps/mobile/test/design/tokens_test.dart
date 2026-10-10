import 'dart:ui' show Brightness;

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/color.dart';
import 'package:trino_mobile/design/tokens.dart';

import '../support/desktop_tokens.dart';

/// The palette tokens an alternative accent replaces, as in tokens.ts.
const paletteTokens = {
  'accent',
  'accentInk',
  'accentText',
  'accentSoft',
  'badge',
  'badgeInk',
  'bubbleMe',
  'bubbleMeInk',
  'bubbleMeMuted',
  'bubbleMeLine',
};

void main() {
  test('has the four themes of the desktop, by the same ids', () {
    expect(ThemeId.values.map((id) => id.key), ['calma-light', 'calma-dark', 'terminal-dark', 'terminal-light']);
    for (final id in ThemeId.values) {
      expect(ThemeId.of(id.style, id.brightness), id);
      expect(kThemes[id], isNotNull, reason: id.key);
    }
  });

  test('every colour token is opaque, so its contrast can be measured', () {
    for (final id in ThemeId.values) {
      for (final MapEntry(:key, :value) in kThemes[id]!.colors.entries) {
        expect(value.a, 1.0, reason: '${id.key} $key');
      }
    }
  });

  group('the port of src/design/tokens.ts', () {
    final file = desktopTokensFile();
    final skip = file.existsSync() ? false : 'tokens.ts is not at ${file.path}';
    late DesktopTokens desktop;
    setUpAll(() {
      if (skip == false) desktop = DesktopTokens.parse(file.readAsStringSync());
    });

    test('has every theme token with the same value', () {
      expect(desktop.themes.keys, unorderedEquals(ThemeId.values.map((id) => id.key)));
      for (final id in ThemeId.values) {
        final tokens = kThemes[id]!;
        final source = desktop.themes[id.key]!;
        for (final MapEntry(:key, :value) in source.entries) {
          expect(describeToken(tokens, key), canonical(key, value), reason: '${id.key}.$key');
        }
        // No colour of the port is missing from the desktop either.
        expect(source.keys, containsAll(tokens.colors.keys), reason: id.key);
      }
    }, skip: skip);

    test('has every accent palette with the same value', () {
      for (final brightness in Brightness.values) {
        final mode = brightness.name;
        final palettes = desktop.accentPalettes[mode]!;
        expect(
          palettes.keys,
          unorderedEquals(TrinoAccent.values.where((a) => a != TrinoAccent.verde).map((a) => a.name)),
        );
        for (final MapEntry(key: accent, value: source) in palettes.entries) {
          final palette = kAccentPalettes[brightness]![TrinoAccent.values.byName(accent)]!;
          expect(source.keys.toSet(), paletteTokens, reason: '$mode.$accent');
          for (final MapEntry(:key, :value) in source.entries) {
            expect(hexOf(palette.colors[key]!), value.toUpperCase(), reason: '$mode.$accent.$key');
          }
        }
      }
    }, skip: skip);
  });

  group('resolveTokens', () {
    test('verde is each theme as it is', () {
      for (final id in ThemeId.values) {
        expect(resolveTokens(id.style, id.brightness, TrinoAccent.verde), kThemes[id]);
      }
    });

    test('an alternative accent replaces only its palette tokens', () {
      for (final id in ThemeId.values) {
        final theme = kThemes[id]!;
        for (final accent in TrinoAccent.values.where((a) => a != TrinoAccent.verde)) {
          final resolved = resolveTokens(id.style, id.brightness, accent);
          final palette = kAccentPalettes[id.brightness]![accent]!;
          for (final MapEntry(:key, :value) in resolved.colors.entries) {
            final expected = key == 'bubbleMeLine'
                // Calma draws no border around your bubbles; Terminal does.
                ? (id.style == TrinoStyle.calma ? palette.bubbleMe : palette.bubbleMeLine)
                : paletteTokens.contains(key)
                ? palette.colors[key]
                : theme.colors[key];
            expect(value, expected, reason: '${id.key} ${accent.name} $key');
          }
          expect(resolved.font, theme.font);
          expect(resolved.radius, theme.radius);
          expect(resolved.wordmark, theme.wordmark);
        }
      }
    });
  });
}

/// A token of the port, written the way [canonical] writes the desktop value.
String describeToken(ThemeTokens tokens, String key) {
  final color = tokens.colors[key];
  if (color != null) return hexOf(color);
  return switch (key) {
    'font' => tokens.font,
    'display' => tokens.display,
    'mono' => tokens.mono,
    'labelFont' => tokens.labelFont,
    'radius' => '${tokens.radius}',
    'radiusLg' => '${tokens.radiusLg}',
    'bubbleRadius' => '${tokens.bubbleRadius}',
    'avatarRadius' => '${tokens.avatarRadius}',
    'labelTransform' => tokens.labelUppercase ? 'uppercase' : 'none',
    'labelSpacing' => '${tokens.labelSpacingEm}em',
    'wordmark' => tokens.wordmark,
    'scan' => describeScan(tokens.scan),
    'shadow' => tokens.shadow.isEmpty ? 'none' : tokens.shadow.map(describeShadow).join(' | '),
    _ => 'the port has no token "$key"',
  };
}

/// A desktop value in the form of [describeToken].
String canonical(String key, String value) {
  if (RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(value)) return value.toUpperCase();
  switch (key) {
    case 'font' || 'display' || 'mono' || 'labelFont':
      // The first family of the CSS stack: the one the app bundles.
      return RegExp(r"^'([^']+)'").firstMatch(value)![1]!;
    case 'radius' || 'radiusLg' || 'bubbleRadius' || 'avatarRadius':
      return '${double.parse(value.replaceFirst('px', ''))}';
    case 'labelSpacing':
      return '${double.parse(value.replaceFirst('em', ''))}em';
    case 'scan':
      if (value == 'none') return 'none';
      final match = RegExp(
        r'^repeating-linear-gradient\(0deg, rgba\((\d+),(\d+),(\d+),([\d.]+)\) 0px, '
        r'rgba\(\1,\2,\3,\4\) (\d+)px, transparent \5px, transparent (\d+)px\)$',
      ).firstMatch(value)!;
      return 'lines ${match[1]},${match[2]},${match[3]} @${double.parse(match[4]!)} '
          '${double.parse(match[5]!)}px every ${double.parse(match[6]!)}px';
    case 'shadow':
      if (value == 'none') return 'none';
      return RegExp(r'(-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)? ([\d.]+)(?:px)? rgba\((\d+),(\d+),(\d+),([\d.]+)\)')
          .allMatches(value)
          .map(
            (m) =>
                '${double.parse(m[1]!)},${double.parse(m[2]!)} blur ${double.parse(m[3]!)} '
                '${m[4]},${m[5]},${m[6]} @${double.parse(m[7]!)}',
          )
          .join(' | ');
    default:
      return value;
  }
}

String describeScan(ScanLines? scan) {
  if (scan == null) return 'none';
  final c = scan.color;
  return 'lines ${channel(c.r)},${channel(c.g)},${channel(c.b)} @${scan.color.a} '
      '${scan.lineWidth}px every ${scan.period}px';
}

String describeShadow(BoxShadow shadow) {
  final c = shadow.color;
  return '${shadow.offset.dx},${shadow.offset.dy} blur ${shadow.blurRadius} '
      '${channel(c.r)},${channel(c.g)},${channel(c.b)} @${c.a}';
}

int channel(double value) => (value * 255).round();
