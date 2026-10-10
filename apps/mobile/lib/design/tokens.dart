// Design tokens of the redesign, ported from the desktop's
// src/design/tokens.ts: the colour, type, shape and depth of both styles
// (Calma and Terminal), each in light and dark, plus the alternative accents.
//
// The values are the desktop's, unchanged. test/design/tokens_test.dart reads
// tokens.ts and fails on any difference, and contrast_test.dart checks every
// text pair against WCAG AA (4.5:1) and boundaries and icons against 3:1, in
// all 16 combinations of style, mode and accent.
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

enum TrinoStyle { calma, terminal }

/// `verde` is each theme's own palette; the others replace part of it.
enum TrinoAccent { verde, azul, morado, naranja }

/// The four themes, by the desktop's ids.
enum ThemeId {
  calmaLight(TrinoStyle.calma, Brightness.light, 'calma-light'),
  calmaDark(TrinoStyle.calma, Brightness.dark, 'calma-dark'),
  terminalDark(TrinoStyle.terminal, Brightness.dark, 'terminal-dark'),
  terminalLight(TrinoStyle.terminal, Brightness.light, 'terminal-light');

  const ThemeId(this.style, this.brightness, this.key);

  final TrinoStyle style;
  final Brightness brightness;
  final String key;

  static ThemeId of(TrinoStyle style, Brightness brightness) =>
      values.firstWhere((id) => id.style == style && id.brightness == brightness);
}

/// The bundled font families (pubspec.yaml).
const kAtkinson = 'Atkinson Hyperlegible Next';
const kAtkinsonMono = 'Atkinson Hyperlegible Mono';
const kPlexSans = 'IBM Plex Sans';
const kJetBrainsMono = 'JetBrains Mono';

/// Horizontal scan lines behind the content (Terminal dark only): a line of
/// [lineWidth] in [color] every [period] logical pixels.
@immutable
class ScanLines {
  const ScanLines({required this.color, required this.lineWidth, required this.period});

  final Color color;
  final double lineWidth;
  final double period;

  @override
  bool operator ==(Object other) =>
      other is ScanLines && other.color == color && other.lineWidth == lineWidth && other.period == period;

  @override
  int get hashCode => Object.hash(color, lineWidth, period);
}

@immutable
class ThemeTokens {
  const ThemeTokens({
    required this.bg,
    required this.side,
    required this.surface,
    required this.raised,
    required this.line,
    required this.controlLine,
    required this.ink,
    required this.muted,
    required this.accent,
    required this.accentInk,
    required this.accentText,
    required this.accentSoft,
    required this.ok,
    required this.warn,
    required this.warnBg,
    required this.danger,
    required this.dangerBg,
    required this.badge,
    required this.badgeInk,
    required this.avatarBg,
    required this.avatarFg,
    required this.bubbleIn,
    required this.bubbleInInk,
    required this.bubbleInLine,
    required this.bubbleMe,
    required this.bubbleMeInk,
    required this.bubbleMeMuted,
    required this.bubbleMeLine,
    required this.outer,
    required this.font,
    required this.display,
    required this.mono,
    required this.radius,
    required this.radiusLg,
    required this.bubbleRadius,
    required this.avatarRadius,
    required this.scan,
    required this.labelFont,
    required this.labelUppercase,
    required this.labelSpacingEm,
    required this.wordmark,
    required this.shadow,
  });

  /// App background.
  final Color bg;

  /// Sidebar background; on mobile, the bars.
  final Color side;

  /// Panels, cards, dialogs and lists.
  final Color surface;

  /// Pressed rows, chips, day separators, code blocks and the call stage.
  final Color raised;

  /// Borders and dividers. Decorative, so not a contrast pair.
  final Color line;

  /// Boundary of the text fields (WCAG 1.4.11): 3:1 on bg, side, surface and
  /// raised, kept just above that so it stays quiet. No accent changes it.
  final Color controlLine;

  final Color ink;
  final Color muted;

  /// Fill of primary buttons, switches and selected segments.
  final Color accent;

  /// Text and icons on [accent].
  final Color accentInk;

  /// Accent-coloured text and icons on surfaces.
  final Color accentText;

  /// Tinted background: selected options, pressed toggles, avatars.
  final Color accentSoft;

  /// Status colours are semantic: they never follow the accent.
  final Color ok;
  final Color warn;
  final Color warnBg;
  final Color danger;
  final Color dangerBg;
  final Color badge;
  final Color badgeInk;
  final Color avatarBg;
  final Color avatarFg;
  final Color bubbleIn;
  final Color bubbleInInk;
  final Color bubbleInLine;
  final Color bubbleMe;
  final Color bubbleMeInk;

  /// Time and status inside your own bubbles.
  final Color bubbleMeMuted;
  final Color bubbleMeLine;

  /// Around the app window (the prototype's frame).
  final Color outer;

  /// Reading text.
  final String font;

  /// Headings and the wordmark.
  final String display;

  /// Keys, codes and times only.
  final String mono;

  final double radius;
  final double radiusLg;
  final double bubbleRadius;
  final double avatarRadius;

  /// Scan lines (Terminal dark only), or null.
  final ScanLines? scan;

  /// Day separators, section labels and chips.
  final String labelFont;

  /// Labels in capitals (Terminal) or sentence case (Calma).
  final bool labelUppercase;

  /// Letter spacing of the labels, in em.
  final double labelSpacingEm;

  /// Text of the wordmark. Content, not style.
  final String wordmark;

  final List<BoxShadow> shadow;

  /// Every colour token by its desktop name, in the desktop's order.
  Map<String, Color> get colors => {
    'bg': bg,
    'side': side,
    'surface': surface,
    'raised': raised,
    'line': line,
    'controlLine': controlLine,
    'ink': ink,
    'muted': muted,
    'accent': accent,
    'accentInk': accentInk,
    'accentText': accentText,
    'accentSoft': accentSoft,
    'ok': ok,
    'warn': warn,
    'warnBg': warnBg,
    'danger': danger,
    'dangerBg': dangerBg,
    'badge': badge,
    'badgeInk': badgeInk,
    'avatarBg': avatarBg,
    'avatarFg': avatarFg,
    'bubbleIn': bubbleIn,
    'bubbleInInk': bubbleInInk,
    'bubbleInLine': bubbleInLine,
    'bubbleMe': bubbleMe,
    'bubbleMeInk': bubbleMeInk,
    'bubbleMeMuted': bubbleMeMuted,
    'bubbleMeLine': bubbleMeLine,
    'outer': outer,
  };

  /// These tokens with an accent [palette]. Your bubbles get a visible border
  /// only when [bubbleBorder]; otherwise their border is their fill.
  ThemeTokens withPalette(AccentPalette palette, {required bool bubbleBorder}) => ThemeTokens(
    bg: bg,
    side: side,
    surface: surface,
    raised: raised,
    line: line,
    controlLine: controlLine,
    ink: ink,
    muted: muted,
    accent: palette.accent,
    accentInk: palette.accentInk,
    accentText: palette.accentText,
    accentSoft: palette.accentSoft,
    ok: ok,
    warn: warn,
    warnBg: warnBg,
    danger: danger,
    dangerBg: dangerBg,
    badge: palette.badge,
    badgeInk: palette.badgeInk,
    avatarBg: avatarBg,
    avatarFg: avatarFg,
    bubbleIn: bubbleIn,
    bubbleInInk: bubbleInInk,
    bubbleInLine: bubbleInLine,
    bubbleMe: palette.bubbleMe,
    bubbleMeInk: palette.bubbleMeInk,
    bubbleMeMuted: palette.bubbleMeMuted,
    bubbleMeLine: bubbleBorder ? palette.bubbleMeLine : palette.bubbleMe,
    outer: outer,
    font: font,
    display: display,
    mono: mono,
    radius: radius,
    radiusLg: radiusLg,
    bubbleRadius: bubbleRadius,
    avatarRadius: avatarRadius,
    scan: scan,
    labelFont: labelFont,
    labelUppercase: labelUppercase,
    labelSpacingEm: labelSpacingEm,
    wordmark: wordmark,
    shadow: shadow,
  );

  @override
  bool operator ==(Object other) =>
      other is ThemeTokens &&
      mapEquals(other.colors, colors) &&
      other.font == font &&
      other.display == display &&
      other.mono == mono &&
      other.radius == radius &&
      other.radiusLg == radiusLg &&
      other.bubbleRadius == bubbleRadius &&
      other.avatarRadius == avatarRadius &&
      other.scan == scan &&
      other.labelFont == labelFont &&
      other.labelUppercase == labelUppercase &&
      other.labelSpacingEm == labelSpacingEm &&
      other.wordmark == wordmark &&
      listEquals(other.shadow, shadow);

  @override
  int get hashCode => Object.hash(
    Object.hashAll(colors.values),
    font,
    display,
    mono,
    Object.hash(radius, radiusLg, bubbleRadius, avatarRadius),
    scan,
    labelFont,
    labelUppercase,
    labelSpacingEm,
    wordmark,
    Object.hashAll(shadow),
  );
}

/// The tokens an alternative accent replaces. Status colours (`ok`, `warn`,
/// `danger`) and the contact avatars keep the theme's own values.
@immutable
class AccentPalette {
  const AccentPalette({
    required this.accent,
    required this.accentInk,
    required this.accentText,
    required this.accentSoft,
    required this.badge,
    required this.badgeInk,
    required this.bubbleMe,
    required this.bubbleMeInk,
    required this.bubbleMeMuted,
    required this.bubbleMeLine,
  });

  final Color accent;
  final Color accentInk;
  final Color accentText;
  final Color accentSoft;
  final Color badge;
  final Color badgeInk;
  final Color bubbleMe;
  final Color bubbleMeInk;
  final Color bubbleMeMuted;

  /// Visible border of your own bubbles in Terminal; Calma uses the fill.
  final Color bubbleMeLine;

  Map<String, Color> get colors => {
    'accent': accent,
    'accentInk': accentInk,
    'accentText': accentText,
    'accentSoft': accentSoft,
    'badge': badge,
    'badgeInk': badgeInk,
    'bubbleMe': bubbleMe,
    'bubbleMeInk': bubbleMeInk,
    'bubbleMeMuted': bubbleMeMuted,
    'bubbleMeLine': bubbleMeLine,
  };
}

const kThemes = <ThemeId, ThemeTokens>{
  ThemeId.calmaLight: ThemeTokens(
    bg: Color(0xFFF5F7F6),
    side: Color(0xFFFFFFFF),
    surface: Color(0xFFFFFFFF),
    raised: Color(0xFFEEF2F0),
    line: Color(0xFFDDE3E0),
    controlLine: Color(0xFF818B86),
    ink: Color(0xFF111815),
    muted: Color(0xFF56635C),
    accent: Color(0xFF0F7B4A),
    accentInk: Color(0xFFFFFFFF),
    accentText: Color(0xFF0F7B4A),
    accentSoft: Color(0xFFE3F2EA),
    ok: Color(0xFF0F7B4A),
    warn: Color(0xFF8A5A00),
    warnBg: Color(0xFFFFF4DB),
    danger: Color(0xFFB3261E),
    dangerBg: Color(0xFFFDECEA),
    badge: Color(0xFF0F7B4A),
    badgeInk: Color(0xFFFFFFFF),
    avatarBg: Color(0xFFDDF0E5),
    avatarFg: Color(0xFF0B5E38),
    bubbleIn: Color(0xFFEEF2F0),
    bubbleInInk: Color(0xFF111815),
    bubbleInLine: Color(0xFFEEF2F0),
    bubbleMe: Color(0xFFDDF0E5),
    bubbleMeInk: Color(0xFF111815),
    bubbleMeMuted: Color(0xFF3F5A4B),
    bubbleMeLine: Color(0xFFDDF0E5),
    outer: Color(0xFFE7ECE9),
    font: kAtkinson,
    display: kAtkinson,
    mono: kAtkinsonMono,
    radius: 10,
    radiusLg: 14,
    bubbleRadius: 16,
    avatarRadius: 999,
    scan: null,
    labelFont: kAtkinson,
    labelUppercase: false,
    labelSpacingEm: 0,
    wordmark: 'Trino',
    // 0 1px 2px rgba(17,24,21,0.06), 0 8px 24px rgba(17,24,21,0.06)
    shadow: [
      BoxShadow(color: Color.fromRGBO(17, 24, 21, 0.06), offset: Offset(0, 1), blurRadius: 2),
      BoxShadow(color: Color.fromRGBO(17, 24, 21, 0.06), offset: Offset(0, 8), blurRadius: 24),
    ],
  ),
  ThemeId.calmaDark: ThemeTokens(
    bg: Color(0xFF0F1311),
    side: Color(0xFF131815),
    surface: Color(0xFF161B18),
    raised: Color(0xFF1E2521),
    line: Color(0xFF28302B),
    controlLine: Color(0xFF66726B),
    ink: Color(0xFFE6ECE8),
    muted: Color(0xFF9AA8A0),
    accent: Color(0xFF3FD68A),
    accentInk: Color(0xFF04170C),
    accentText: Color(0xFF3FD68A),
    accentSoft: Color(0xFF183526),
    ok: Color(0xFF3FD68A),
    warn: Color(0xFFF2B45A),
    warnBg: Color(0xFF2C2416),
    danger: Color(0xFFFF8A8A),
    dangerBg: Color(0xFF3A1E1E),
    badge: Color(0xFF3FD68A),
    badgeInk: Color(0xFF04170C),
    avatarBg: Color(0xFF1F3B2C),
    avatarFg: Color(0xFFBFF0D4),
    bubbleIn: Color(0xFF1E2521),
    bubbleInInk: Color(0xFFE6ECE8),
    bubbleInLine: Color(0xFF1E2521),
    bubbleMe: Color(0xFF1F3B2C),
    bubbleMeInk: Color(0xFFE6F5EC),
    bubbleMeMuted: Color(0xFFA8C9B6),
    bubbleMeLine: Color(0xFF1F3B2C),
    outer: Color(0xFF0A0D0B),
    font: kAtkinson,
    display: kAtkinson,
    mono: kAtkinsonMono,
    radius: 10,
    radiusLg: 14,
    bubbleRadius: 16,
    avatarRadius: 999,
    scan: null,
    labelFont: kAtkinson,
    labelUppercase: false,
    labelSpacingEm: 0,
    wordmark: 'Trino',
    // 0 8px 24px rgba(0,0,0,0.35)
    shadow: [BoxShadow(color: Color.fromRGBO(0, 0, 0, 0.35), offset: Offset(0, 8), blurRadius: 24)],
  ),
  ThemeId.terminalDark: ThemeTokens(
    bg: Color(0xFF0A0E0C),
    side: Color(0xFF0E1411),
    surface: Color(0xFF101613),
    raised: Color(0xFF18221C),
    line: Color(0xFF24302A),
    controlLine: Color(0xFF607067),
    ink: Color(0xFFD7E3DC),
    muted: Color(0xFF93A69B),
    accent: Color(0xFF22FF66),
    accentInk: Color(0xFF03140A),
    accentText: Color(0xFF22FF66),
    accentSoft: Color(0xFF0F2A1A),
    ok: Color(0xFF22FF66),
    warn: Color(0xFFFFB547),
    warnBg: Color(0xFF2A2110),
    danger: Color(0xFFFF6B78),
    dangerBg: Color(0xFF2C1216),
    badge: Color(0xFF22FF66),
    badgeInk: Color(0xFF03140A),
    avatarBg: Color(0xFF18221C),
    avatarFg: Color(0xFF22FF66),
    bubbleIn: Color(0xFF151D19),
    bubbleInInk: Color(0xFFD7E3DC),
    bubbleInLine: Color(0xFF24302A),
    bubbleMe: Color(0xFF0F2A1A),
    bubbleMeInk: Color(0xFFDFFBE8),
    bubbleMeMuted: Color(0xFF9CC9AE),
    bubbleMeLine: Color(0xFF1E4A30),
    outer: Color(0xFF060908),
    font: kPlexSans,
    display: kJetBrainsMono,
    mono: kJetBrainsMono,
    radius: 4,
    radiusLg: 6,
    bubbleRadius: 4,
    avatarRadius: 4,
    // repeating-linear-gradient(0deg, rgba(34,255,102,0.025) 0px,
    //   rgba(34,255,102,0.025) 1px, transparent 1px, transparent 4px)
    scan: ScanLines(color: Color.fromRGBO(34, 255, 102, 0.025), lineWidth: 1, period: 4),
    labelFont: kJetBrainsMono,
    labelUppercase: true,
    labelSpacingEm: 0.08,
    wordmark: 'trino',
    shadow: [],
  ),
  ThemeId.terminalLight: ThemeTokens(
    bg: Color(0xFFF2F4EF),
    side: Color(0xFFE9ECE5),
    surface: Color(0xFFFFFFFF),
    raised: Color(0xFFE9EDE5),
    line: Color(0xFFD3D9CF),
    controlLine: Color(0xFF7D877F),
    ink: Color(0xFF121A15),
    muted: Color(0xFF4E5B53),
    accent: Color(0xFF08743A),
    accentInk: Color(0xFFFFFFFF),
    accentText: Color(0xFF08743A),
    accentSoft: Color(0xFFE1F0E6),
    ok: Color(0xFF08743A),
    warn: Color(0xFF8A5A00),
    warnBg: Color(0xFFFFF4DB),
    danger: Color(0xFFB3261E),
    dangerBg: Color(0xFFFBE9E8),
    badge: Color(0xFF08743A),
    badgeInk: Color(0xFFFFFFFF),
    avatarBg: Color(0xFFDDE5DA),
    avatarFg: Color(0xFF08743A),
    bubbleIn: Color(0xFFEEF1EA),
    bubbleInInk: Color(0xFF121A15),
    bubbleInLine: Color(0xFFD3D9CF),
    bubbleMe: Color(0xFF08743A),
    bubbleMeInk: Color(0xFFFFFFFF),
    bubbleMeMuted: Color(0xFFD2F2DF),
    bubbleMeLine: Color(0xFF08743A),
    outer: Color(0xFFDDE2DA),
    font: kPlexSans,
    display: kJetBrainsMono,
    mono: kJetBrainsMono,
    radius: 4,
    radiusLg: 6,
    bubbleRadius: 4,
    avatarRadius: 4,
    scan: null,
    labelFont: kJetBrainsMono,
    labelUppercase: true,
    labelSpacingEm: 0.08,
    wordmark: 'trino',
    shadow: [],
  ),
};

/// Alternative accents per mode, shared by both styles (see tokens.ts for how
/// the derived tokens were chosen).
const kAccentPalettes = <Brightness, Map<TrinoAccent, AccentPalette>>{
  Brightness.light: {
    TrinoAccent.azul: AccentPalette(
      accent: Color(0xFF1F5FBF),
      accentInk: Color(0xFFFFFFFF),
      accentText: Color(0xFF1F5FBF),
      accentSoft: Color(0xFFE2ECFB),
      badge: Color(0xFF1F5FBF),
      badgeInk: Color(0xFFFFFFFF),
      bubbleMe: Color(0xFFDCE8FA),
      bubbleMeInk: Color(0xFF0F1A2E),
      bubbleMeMuted: Color(0xFF485467),
      bubbleMeLine: Color(0xFF1F5FBF),
    ),
    TrinoAccent.morado: AccentPalette(
      accent: Color(0xFF6B3FB8),
      accentInk: Color(0xFFFFFFFF),
      accentText: Color(0xFF6B3FB8),
      accentSoft: Color(0xFFEFE8FB),
      badge: Color(0xFF6B3FB8),
      badgeInk: Color(0xFFFFFFFF),
      bubbleMe: Color(0xFFECE3FA),
      bubbleMeInk: Color(0xFF1D1230),
      bubbleMeMuted: Color(0xFF574D69),
      bubbleMeLine: Color(0xFF6B3FB8),
    ),
    TrinoAccent.naranja: AccentPalette(
      accent: Color(0xFFA14A00),
      accentInk: Color(0xFFFFFFFF),
      accentText: Color(0xFFA14A00),
      accentSoft: Color(0xFFFCEBDB),
      badge: Color(0xFFA14A00),
      badgeInk: Color(0xFFFFFFFF),
      bubbleMe: Color(0xFFFBE6D3),
      bubbleMeInk: Color(0xFF2B1600),
      bubbleMeMuted: Color(0xFF65503B),
      bubbleMeLine: Color(0xFFA14A00),
    ),
  },
  Brightness.dark: {
    TrinoAccent.azul: AccentPalette(
      accent: Color(0xFF7AB2FF),
      accentInk: Color(0xFF0B0B0B),
      accentText: Color(0xFF7AB2FF),
      accentSoft: Color(0xFF17273F),
      badge: Color(0xFF7AB2FF),
      badgeInk: Color(0xFF0B0B0B),
      bubbleMe: Color(0xFF1B2E4A),
      bubbleMeInk: Color(0xFFE6F0FF),
      bubbleMeMuted: Color(0xFFADBACC),
      bubbleMeLine: Color(0xFF2E486E),
    ),
    TrinoAccent.morado: AccentPalette(
      accent: Color(0xFFB99BFF),
      accentInk: Color(0xFF0B0B0B),
      accentText: Color(0xFFB99BFF),
      accentSoft: Color(0xFF271C3D),
      badge: Color(0xFFB99BFF),
      badgeInk: Color(0xFF0B0B0B),
      bubbleMe: Color(0xFF2E2148),
      bubbleMeInk: Color(0xFFF1EBFF),
      bubbleMeMuted: Color(0xFFBAB2CC),
      bubbleMeLine: Color(0xFF4A396D),
    ),
    TrinoAccent.naranja: AccentPalette(
      accent: Color(0xFFFFB070),
      accentInk: Color(0xFF0B0B0B),
      accentText: Color(0xFFFFB070),
      accentSoft: Color(0xFF342414),
      badge: Color(0xFFFFB070),
      badgeInk: Color(0xFF0B0B0B),
      bubbleMe: Color(0xFF3D2A18),
      bubbleMeInk: Color(0xFFFFF1E4),
      bubbleMeMuted: Color(0xFFC9B9AB),
      bubbleMeLine: Color(0xFF64452A),
    ),
  },
};

/// The tokens of a style and mode with an accent.
ThemeTokens resolveTokens(TrinoStyle style, Brightness brightness, TrinoAccent accent) {
  final theme = kThemes[ThemeId.of(style, brightness)]!;
  if (accent == TrinoAccent.verde) return theme;
  // Calma draws no border around your bubbles; Terminal does.
  return theme.withPalette(kAccentPalettes[brightness]![accent]!, bubbleBorder: style == TrinoStyle.terminal);
}
