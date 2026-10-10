// Colour maths for the design tokens: #RRGGBB parsing and WCAG 2.x contrast,
// the same as the desktop's src/design/color.ts.
import 'dart:math' as math;

import 'package:flutter/painting.dart';

final _hexColor = RegExp(r'^#([0-9a-fA-F]{6})$');

/// An opaque colour from `#RRGGBB`, in any case. Throws a [FormatException]
/// on anything else.
Color parseHexColor(String hex) {
  final match = _hexColor.firstMatch(hex);
  if (match == null) throw FormatException('Expected a #RRGGBB colour', hex);
  return Color(0xFF000000 | int.parse(match[1]!, radix: 16));
}

/// `#RRGGBB` of a colour, in capitals; the alpha is left out.
String hexOf(Color color) => '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';

/// WCAG 2.x relative luminance, 0 (black) to 1 (white). Uses the sRGB
/// threshold 0.04045; the 0.03928 quoted by WCAG gives the same result for
/// 8-bit channels. Only opaque colours have one.
double relativeLuminance(Color color) {
  if (color.a != 1) {
    throw ArgumentError.value(color, 'color', 'must be opaque to have a contrast');
  }
  return 0.2126 * _linearize(color.r) + 0.7152 * _linearize(color.g) + 0.0722 * _linearize(color.b);
}

double _linearize(double channel) {
  // Rounded to the 8-bit value the token was written in.
  final value = (channel * 255).round() / 255;
  return value <= 0.04045 ? value / 12.92 : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
}

/// WCAG 2.x contrast ratio: 1 for the same colour, 21 for black on white.
double contrastRatio(Color foreground, Color background) {
  final a = relativeLuminance(foreground);
  final b = relativeLuminance(background);
  return (math.max(a, b) + 0.05) / (math.min(a, b) + 0.05);
}
