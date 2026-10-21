// The app's vibrations, by meaning, in one place so they stay consistent.
// Only Flutter's HapticFeedback, which uses the system's own patterns and
// follows the phone's settings (touch vibration off means none). Less is
// more: nothing on send, on changing tabs or on errors (those are said in
// words). Never HapticFeedback.vibrate(), Android's long-press buzz.
//
// On Android, Flutter maps selectionClick to CLOCK_TICK, mediumImpact to
// KEYBOARD_TAP and heavyImpact to CONTEXT_CLICK.
import 'package:flutter/services.dart';

abstract final class TrinoHaptics {
  /// A swipe crosses the point where letting go does the action, and back.
  static Future<void> threshold() => HapticFeedback.selectionClick();

  /// Something switched on or off from a list: pinning or unpinning a chat.
  static Future<void> toggled() => HapticFeedback.selectionClick();

  /// Something that cannot be undone was confirmed: deleting, blocking,
  /// leaving a group.
  static Future<void> destructiveConfirmed() => HapticFeedback.heavyImpact();

  /// You answered a call.
  static Future<void> callAnswered() => HapticFeedback.mediumImpact();

  /// You ended a call: hanging up, or rejecting one that rings in.
  static Future<void> callEnded() => HapticFeedback.mediumImpact();
}
