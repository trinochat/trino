// The phone's status and navigation bars. Since Android 15 (target SDK 35)
// apps draw edge to edge, behind both bars; Trino asks for that on every
// version, keeps both bars clear, without the system's scrim, and picks
// their icons to stay visible on the theme. Screens keep their content out
// from under the bars with SafeArea; backgrounds still reach the edges.
import 'package:flutter/services.dart';

const _clear = Color(0x00000000);

/// The bars over a theme of [brightness]: clear, with dark icons on a light
/// theme and light icons on a dark one.
SystemUiOverlayStyle systemBarsFor(Brightness brightness) {
  final icons = brightness == Brightness.dark ? Brightness.light : Brightness.dark;
  return SystemUiOverlayStyle(
    statusBarColor: _clear,
    systemNavigationBarColor: _clear,
    systemNavigationBarDividerColor: _clear,
    systemStatusBarContrastEnforced: false,
    systemNavigationBarContrastEnforced: false,
    statusBarIconBrightness: icons,
    systemNavigationBarIconBrightness: icons,
    // The iPhone's status bar takes the brightness of what is behind it.
    statusBarBrightness: brightness,
  );
}

/// Draws behind the status and navigation bars, as Android 15 and later
/// require and older versions allow.
Future<void> drawEdgeToEdge() => SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
