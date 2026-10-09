import 'package:flutter/material.dart';

enum TrinoThemePreset { hacker, corporate, simple }

@immutable
class TrinoThemePreference {
  const TrinoThemePreference({
    this.preset = TrinoThemePreset.hacker,
    this.accent = const Color(0xFF35E875),
  });

  final TrinoThemePreset preset;
  final Color accent;

  TrinoThemePreference copyWith({TrinoThemePreset? preset, Color? accent}) {
    return TrinoThemePreference(
      preset: preset ?? this.preset,
      accent: accent ?? this.accent,
    );
  }
}

abstract final class TrinoColors {
  static const green = Color(0xFF35E875);
  static const cyan = Color(0xFF70C9E8);
  static const amber = Color(0xFFF0BE55);
  static const crimson = Color(0xFFE96565);
  static const violet = Color(0xFFB7A1E8);
}

@immutable
class TrinoPalette extends ThemeExtension<TrinoPalette> {
  const TrinoPalette({
    required this.background,
    required this.chatBackground,
    required this.surface,
    required this.surfaceRaised,
    required this.line,
    required this.ink,
    required this.inkDim,
    required this.inkMuted,
    required this.accent,
    required this.accentDeep,
    required this.onAccent,
    required this.showChatPattern,
  });

  final Color background;
  final Color chatBackground;
  final Color surface;
  final Color surfaceRaised;
  final Color line;
  final Color ink;
  final Color inkDim;
  final Color inkMuted;
  final Color accent;
  final Color accentDeep;
  final Color onAccent;
  final bool showChatPattern;

  @override
  TrinoPalette copyWith({
    Color? background,
    Color? chatBackground,
    Color? surface,
    Color? surfaceRaised,
    Color? line,
    Color? ink,
    Color? inkDim,
    Color? inkMuted,
    Color? accent,
    Color? accentDeep,
    Color? onAccent,
    bool? showChatPattern,
  }) {
    return TrinoPalette(
      background: background ?? this.background,
      chatBackground: chatBackground ?? this.chatBackground,
      surface: surface ?? this.surface,
      surfaceRaised: surfaceRaised ?? this.surfaceRaised,
      line: line ?? this.line,
      ink: ink ?? this.ink,
      inkDim: inkDim ?? this.inkDim,
      inkMuted: inkMuted ?? this.inkMuted,
      accent: accent ?? this.accent,
      accentDeep: accentDeep ?? this.accentDeep,
      onAccent: onAccent ?? this.onAccent,
      showChatPattern: showChatPattern ?? this.showChatPattern,
    );
  }

  @override
  TrinoPalette lerp(covariant TrinoPalette? other, double t) {
    if (other == null) return this;
    return TrinoPalette(
      background: Color.lerp(background, other.background, t)!,
      chatBackground: Color.lerp(chatBackground, other.chatBackground, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t)!,
      line: Color.lerp(line, other.line, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
      inkDim: Color.lerp(inkDim, other.inkDim, t)!,
      inkMuted: Color.lerp(inkMuted, other.inkMuted, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentDeep: Color.lerp(accentDeep, other.accentDeep, t)!,
      onAccent: Color.lerp(onAccent, other.onAccent, t)!,
      showChatPattern: t < 0.5 ? showChatPattern : other.showChatPattern,
    );
  }
}

extension TrinoThemeContext on BuildContext {
  TrinoPalette get trino =>
      Theme.of(this).extension<TrinoPalette>() ??
      _paletteFor(const TrinoThemePreference());
}

ThemeData buildTrinoTheme(TrinoThemePreference preference) {
  final palette = _paletteFor(preference);
  final brightness = preference.preset == TrinoThemePreset.corporate
      ? Brightness.light
      : Brightness.dark;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: palette.accent,
    onPrimary: palette.onAccent,
    secondary: TrinoColors.cyan,
    onSecondary: const Color(0xFF071015),
    error: TrinoColors.crimson,
    onError: const Color(0xFF210707),
    surface: palette.surface,
    onSurface: palette.ink,
  );
  final textTheme = TextTheme(
    headlineSmall: TextStyle(
      color: palette.ink,
      fontSize: 22,
      fontWeight: FontWeight.w700,
      letterSpacing: 0,
    ),
    titleLarge: TextStyle(
      color: palette.ink,
      fontSize: 18,
      fontWeight: FontWeight.w700,
      letterSpacing: 0,
    ),
    titleMedium: TextStyle(
      color: palette.ink,
      fontSize: 15,
      fontWeight: FontWeight.w600,
      letterSpacing: 0,
    ),
    bodyLarge: TextStyle(
      color: palette.ink,
      fontSize: 16,
      height: 1.35,
      letterSpacing: 0,
    ),
    bodyMedium: TextStyle(
      color: palette.inkDim,
      fontSize: 14,
      height: 1.35,
      letterSpacing: 0,
    ),
    bodySmall: TextStyle(
      color: palette.inkMuted,
      fontSize: 12,
      height: 1.3,
      letterSpacing: 0,
    ),
    labelLarge: TextStyle(
      color: palette.ink,
      fontSize: 13,
      fontWeight: FontWeight.w600,
      letterSpacing: 0,
    ),
  );

  return ThemeData(
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: palette.background,
    dividerColor: palette.line,
    splashFactory: InkSparkle.splashFactory,
    useMaterial3: true,
    visualDensity: VisualDensity.standard,
    extensions: [palette],
    textTheme: textTheme,
    appBarTheme: AppBarTheme(
      backgroundColor: palette.background,
      foregroundColor: palette.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      surfaceTintColor: Colors.transparent,
      toolbarHeight: 60,
      titleTextStyle: TextStyle(
        color: palette.ink,
        fontSize: 20,
        fontWeight: FontWeight.w700,
        letterSpacing: 0,
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 66,
      backgroundColor: palette.surface,
      indicatorColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.black,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          color: states.contains(WidgetState.selected)
              ? palette.accent
              : palette.inkMuted,
          fontSize: 11,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          color: states.contains(WidgetState.selected)
              ? palette.accent
              : palette.inkMuted,
          size: 22,
        ),
      ),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: palette.surface,
      indicatorColor: palette.surfaceRaised,
      selectedIconTheme: IconThemeData(color: palette.accent),
      unselectedIconTheme: IconThemeData(color: palette.inkMuted),
      selectedLabelTextStyle: TextStyle(
        color: palette.ink,
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 0,
      ),
      unselectedLabelTextStyle: TextStyle(
        color: palette.inkMuted,
        fontSize: 11,
        letterSpacing: 0,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: palette.surface,
      hintStyle: TextStyle(color: palette.inkMuted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      border: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(24)),
        borderSide: BorderSide(color: palette.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(24)),
        borderSide: BorderSide(color: palette.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: const BorderRadius.all(Radius.circular(24)),
        borderSide: BorderSide(color: palette.accent.withValues(alpha: 0.5)),
      ),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: palette.accent,
      foregroundColor: palette.onAccent,
      elevation: 2,
      focusElevation: 2,
      hoverElevation: 3,
      highlightElevation: 1,
      shape: const CircleBorder(),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: palette.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: false,
      dragHandleColor: palette.line,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
        side: BorderSide(color: palette.line),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: palette.surfaceRaised,
      contentTextStyle: TextStyle(color: palette.ink),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: const BorderRadius.all(Radius.circular(8)),
        side: BorderSide(color: palette.line),
      ),
    ),
  );
}

TrinoPalette _paletteFor(TrinoThemePreference preference) {
  final accent = preference.accent;
  switch (preference.preset) {
    case TrinoThemePreset.hacker:
      const background = Color(0xFF070A08);
      return TrinoPalette(
        background: background,
        chatBackground: const Color(0xFF090D0A),
        surface: const Color(0xFF0D120F),
        surfaceRaised: const Color(0xFF141B16),
        line: const Color(0xFF202B24),
        ink: const Color(0xFFE0EAE3),
        inkDim: const Color(0xFFA1AFA6),
        inkMuted: const Color(0xFF718078),
        accent: accent,
        accentDeep: Color.alphaBlend(
          accent.withValues(alpha: 0.18),
          background,
        ),
        onAccent: const Color(0xFF061009),
        showChatPattern: true,
      );
    case TrinoThemePreset.corporate:
      const background = Color(0xFFF3F6F4);
      return TrinoPalette(
        background: background,
        chatBackground: const Color(0xFFEDF2EF),
        surface: const Color(0xFFFFFFFF),
        surfaceRaised: const Color(0xFFE5ECE8),
        line: const Color(0xFFD4DDD7),
        ink: const Color(0xFF17201A),
        inkDim: const Color(0xFF4F5F55),
        inkMuted: const Color(0xFF738078),
        accent: accent,
        accentDeep: Color.alphaBlend(
          accent.withValues(alpha: 0.16),
          background,
        ),
        onAccent: _foregroundFor(accent),
        showChatPattern: false,
      );
    case TrinoThemePreset.simple:
      const background = Color(0xFF121513);
      return TrinoPalette(
        background: background,
        chatBackground: const Color(0xFF121513),
        surface: const Color(0xFF181D1A),
        surfaceRaised: const Color(0xFF222824),
        line: const Color(0xFF303832),
        ink: const Color(0xFFF0F4F1),
        inkDim: const Color(0xFFB7C0BA),
        inkMuted: const Color(0xFF7E8A82),
        accent: accent,
        accentDeep: Color.alphaBlend(
          accent.withValues(alpha: 0.16),
          background,
        ),
        onAccent: _foregroundFor(accent),
        showChatPattern: false,
      );
  }
}

Color _foregroundFor(Color background) {
  return background.computeLuminance() > 0.42
      ? const Color(0xFF07100A)
      : const Color(0xFFF4F7F5);
}
