// The tokens as a Flutter theme: Material 3 underneath, restyled so nothing
// shows the stock look (no tinted surfaces, no ink sparkle, no floating
// labels). Widgets read the tokens and the type scale through [TrinoTheme].
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'motion.dart';
import 'predictive_back.dart';
import 'tokens.dart';

export 'motion.dart';
export 'tokens.dart';

/// Emoji fonts by their usual names, for text made of emoji such as the call's
/// key: phones resolve them themselves; naming them keeps other renderers
/// from drawing empty boxes.
const kEmojiFallback = ['Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji'];

/// The tokens and type of the current theme, with the choices behind them.
@immutable
class TrinoTheme extends ThemeExtension<TrinoTheme> {
  const TrinoTheme({required this.tokens, required this.style, required this.brightness, required this.text});

  final ThemeTokens tokens;
  final TrinoStyle style;
  final Brightness brightness;
  final TrinoTextStyles text;

  @override
  TrinoTheme copyWith({ThemeTokens? tokens, TrinoStyle? style, Brightness? brightness, TrinoTextStyles? text}) =>
      TrinoTheme(
        tokens: tokens ?? this.tokens,
        style: style ?? this.style,
        brightness: brightness ?? this.brightness,
        text: text ?? this.text,
      );

  /// Themes switch at once: MaterialApp's theme animation is off, and a
  /// half-way mix of two token sets has never been checked for contrast.
  @override
  TrinoTheme lerp(TrinoTheme? other, double t) => other == null || t < 0.5 ? this : other;
}

extension TrinoThemeContext on BuildContext {
  TrinoTheme get trino => Theme.of(this).extension<TrinoTheme>()!;
  ThemeTokens get tokens => trino.tokens;
  TrinoTextStyles get text => trino.text;
}

/// The type scale. Sizes are logical pixels before the system text scale;
/// nothing is smaller than 12. Sans for reading, the display font for
/// headings, mono only for times, keys and codes.
@immutable
class TrinoTextStyles {
  factory TrinoTextStyles.from(ThemeTokens t) {
    TextStyle style(String family, double size, FontWeight weight, Color color, {double? height}) => TextStyle(
      fontFamily: family,
      fontSize: size,
      fontWeight: weight,
      color: color,
      height: height,
      letterSpacing: 0,
      leadingDistribution: TextLeadingDistribution.even,
    );
    return TrinoTextStyles._(
      largeTitle: style(t.display, 30, FontWeight.w700, t.ink, height: 1.2),
      headline: style(t.display, 26, FontWeight.w700, t.ink, height: 1.2),
      title: style(t.display, 20, FontWeight.w700, t.ink, height: 1.25),
      body: style(t.font, 16, FontWeight.w400, t.ink, height: 1.45),
      bodyStrong: style(t.font, 16, FontWeight.w600, t.ink, height: 1.3),
      secondary: style(t.font, 14, FontWeight.w400, t.muted, height: 1.4),
      caption: style(t.font, 13, FontWeight.w400, t.muted, height: 1.4),
      button: style(t.font, 16, FontWeight.w700, t.ink, height: 1.2),
      fieldLabel: style(t.font, 15, FontWeight.w600, t.ink, height: 1.3),
      tab: style(t.font, 15, FontWeight.w600, t.ink, height: 1.2),
      section: style(
        t.labelFont,
        13,
        FontWeight.w600,
        t.muted,
        height: 1.3,
      ).copyWith(letterSpacing: 13 * t.labelSpacingEm),
      mono: style(t.mono, 12, FontWeight.w400, t.muted, height: 1.3),
      code: style(t.mono, 15, FontWeight.w500, t.ink, height: 1.4),
      badge: style(t.font, 12, FontWeight.w700, t.badgeInk, height: 1.2),
    );
  }

  const TrinoTextStyles._({
    required this.largeTitle,
    required this.headline,
    required this.title,
    required this.body,
    required this.bodyStrong,
    required this.secondary,
    required this.caption,
    required this.button,
    required this.fieldLabel,
    required this.tab,
    required this.section,
    required this.mono,
    required this.code,
    required this.badge,
  });

  /// The big title of a tab: "Chats".
  final TextStyle largeTitle;

  /// A name on a full screen: the call.
  final TextStyle headline;

  /// Headers and dialog titles.
  final TextStyle title;

  /// Messages and paragraphs.
  final TextStyle body;

  /// Names and row titles.
  final TextStyle bodyStrong;

  /// Previews and descriptions, in muted.
  final TextStyle secondary;

  /// Hints and fine print, in muted.
  final TextStyle caption;
  final TextStyle button;
  final TextStyle fieldLabel;
  final TextStyle tab;

  /// Section labels and day separators: capitals in Terminal (see [TrinoLabel]).
  final TextStyle section;

  /// Times, in muted.
  final TextStyle mono;

  /// Keys and codes.
  final TextStyle code;
  final TextStyle badge;

  List<TextStyle> get all => [
    largeTitle,
    headline,
    title,
    body,
    bodyStrong,
    secondary,
    caption,
    button,
    fieldLabel,
    tab,
    section,
    mono,
    code,
    badge,
  ];
}

/// A label in the theme's label style: sentence case in Calma, spaced
/// capitals in Terminal. Screen readers get the words as written.
class TrinoLabel extends StatelessWidget {
  const TrinoLabel(this.text, {super.key, this.color, this.style});

  final String text;
  final Color? color;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final trino = context.trino;
    return Text(
      trino.tokens.labelUppercase ? text.toUpperCase() : text,
      style: (style ?? trino.text.section).copyWith(color: color),
      semanticsLabel: text,
    );
  }
}

/// Pages slide in and out whole from the edge, as in Telegram and on the
/// iPhone: no fade, the page below moves a little, and a page can be closed by
/// dragging it from the edge. Full-screen dialogs, such as a call, rise from
/// the bottom. With Reduce Motion (iPhone) a short fade in place, and none
/// with Remove animations (Android).
///
/// With [predictiveBack] (Android), while the system back gesture is being
/// dragged (Android 14+), the page shrinks to preview the one below it, as
/// Android does, and closes or returns with the gesture; opening and closing
/// otherwise keep the slide. With Reduce Motion the page fades with the finger
/// instead, and with Remove animations nothing previews: the gesture just goes
/// back. Full-screen dialogs keep their own way out.
class TrinoPageTransitionsBuilder extends PageTransitionsBuilder {
  const TrinoPageTransitionsBuilder({this.predictiveBack = false});

  final bool predictiveBack;

  static const _slide = CupertinoPageTransitionsBuilder();

  @override
  Duration get transitionDuration => _slide.transitionDuration;

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final motion = motionOf(context);
    Widget transition(BuildContext context, PredictiveBackGesture? gesture) => switch (motion) {
      MotionLevel.none => child,
      MotionLevel.reduced => FadeTransition(
        opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut, reverseCurve: Curves.easeIn),
        child: child,
      ),
      MotionLevel.full when gesture != null => PredictiveBackPreview(
        animation: animation,
        gesture: gesture,
        transitionDuration: route.transitionDuration,
        child: child,
      ),
      MotionLevel.full => _slide.buildTransitions(route, context, animation, secondaryAnimation, child),
    };
    if (!predictiveBack || route.fullscreenDialog || motion == MotionLevel.none) return transition(context, null);
    return PredictiveBackGestureDetector(route: route, builder: transition);
  }
}

/// Behind dialogs and sheets: the darkest token, dimmed.
Color scrimOf(ThemeTokens t, Brightness brightness) =>
    (brightness == Brightness.dark ? t.outer : t.ink).withValues(alpha: 0.5);

ThemeData buildTrinoTheme(TrinoStyle style, Brightness brightness, TrinoAccent accent) {
  final t = resolveTokens(style, brightness, accent);
  final text = TrinoTextStyles.from(t);
  final corners = BorderRadius.circular(t.radius);
  final pressed = t.ink.withValues(alpha: 0.08);

  final scheme = ColorScheme(
    brightness: brightness,
    primary: t.accent,
    onPrimary: t.accentInk,
    primaryContainer: t.accentSoft,
    onPrimaryContainer: t.accentText,
    secondary: t.accentText,
    onSecondary: t.surface,
    secondaryContainer: t.raised,
    onSecondaryContainer: t.ink,
    tertiary: t.warn,
    onTertiary: t.warnBg,
    tertiaryContainer: t.warnBg,
    onTertiaryContainer: t.warn,
    error: t.danger,
    onError: t.surface,
    errorContainer: t.dangerBg,
    onErrorContainer: t.danger,
    surface: t.surface,
    onSurface: t.ink,
    onSurfaceVariant: t.muted,
    surfaceDim: t.bg,
    surfaceBright: t.surface,
    surfaceContainerLowest: t.surface,
    surfaceContainerLow: t.side,
    surfaceContainer: t.bg,
    surfaceContainerHigh: t.raised,
    surfaceContainerHighest: t.raised,
    outline: t.controlLine,
    outlineVariant: t.line,
    shadow: t.outer,
    scrim: scrimOf(t, brightness),
    inverseSurface: t.ink,
    onInverseSurface: t.surface,
    inversePrimary: t.accentSoft,
    surfaceTint: Colors.transparent,
  );

  final textTheme = TextTheme(
    displayLarge: text.largeTitle,
    displayMedium: text.largeTitle,
    displaySmall: text.headline,
    headlineLarge: text.headline,
    headlineMedium: text.headline,
    headlineSmall: text.title,
    titleLarge: text.title,
    titleMedium: text.bodyStrong,
    titleSmall: text.fieldLabel,
    bodyLarge: text.body,
    bodyMedium: text.body,
    bodySmall: text.secondary,
    labelLarge: text.button,
    labelMedium: text.fieldLabel,
    labelSmall: text.caption,
  );

  OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
    borderRadius: corners,
    borderSide: BorderSide(color: color, width: width),
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: t.surface,
    canvasColor: t.surface,
    cardColor: t.surface,
    dividerColor: t.line,
    fontFamily: t.font,
    textTheme: textTheme,
    primaryTextTheme: textTheme,
    iconTheme: IconThemeData(color: t.ink, size: 24),
    splashFactory: InkRipple.splashFactory,
    splashColor: pressed,
    highlightColor: pressed,
    hoverColor: t.ink.withValues(alpha: 0.04),
    focusColor: t.accentText.withValues(alpha: 0.14),
    materialTapTargetSize: MaterialTapTargetSize.padded,
    visualDensity: VisualDensity.standard,
    dividerTheme: DividerThemeData(color: t.line, thickness: 1, space: 1),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: t.accentText,
      selectionColor: t.accentText.withValues(alpha: 0.25),
      selectionHandleColor: t.accentText,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: t.bg,
      hintStyle: text.body.copyWith(color: t.muted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      border: border(t.controlLine, 1),
      enabledBorder: border(t.controlLine, 1),
      focusedBorder: border(t.accentText, 2),
      errorBorder: border(t.danger, 1),
      focusedErrorBorder: border(t.danger, 2),
      disabledBorder: border(t.line, 1),
      floatingLabelBehavior: FloatingLabelBehavior.never,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: t.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(t.radiusLg),
        side: BorderSide(color: t.line),
      ),
      titleTextStyle: text.title,
      contentTextStyle: text.body,
      barrierColor: scrimOf(t, brightness),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: t.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      modalBarrierColor: scrimOf(t, brightness),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(t.radiusLg))),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: t.ink,
      contentTextStyle: text.body.copyWith(color: t.surface),
      behavior: SnackBarBehavior.floating,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: corners),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: t.ink, borderRadius: corners),
      textStyle: text.caption.copyWith(color: t.surface),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: t.accentText, linearTrackColor: t.raised),
    scrollbarTheme: ScrollbarThemeData(thumbColor: WidgetStatePropertyAll(t.muted.withValues(alpha: 0.5))),
    pageTransitionsTheme: PageTransitionsTheme(
      builders: {
        for (final platform in TargetPlatform.values)
          platform: TrinoPageTransitionsBuilder(predictiveBack: platform == TargetPlatform.android),
      },
    ),
    extensions: [TrinoTheme(tokens: t, style: style, brightness: brightness, text: text)],
  );
}
