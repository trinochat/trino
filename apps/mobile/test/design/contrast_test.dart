// WCAG 2.x contrast of the design tokens in every style, mode and accent: the
// same pairs as the desktop's contrast.test.ts, plus those the mobile screens
// add. Text needs 4.5:1; boundaries, icons and control states 3:1.
import 'dart:ui' show Brightness;

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/color.dart';
import 'package:trino_mobile/design/tokens.dart';

typedef Pair = (String foreground, String background);

/// Text pairs required by the redesign plan.
const textPairs = <Pair>[
  ('ink', 'bg'),
  ('ink', 'surface'),
  ('ink', 'side'),
  ('muted', 'bg'),
  ('muted', 'surface'),
  ('muted', 'side'),
  ('accentInk', 'accent'),
  ('accentText', 'surface'),
  ('accentText', 'bg'),
  ('bubbleInInk', 'bubbleIn'),
  ('bubbleMeInk', 'bubbleMe'),
  ('bubbleMeMuted', 'bubbleMe'),
  ('warn', 'warnBg'),
  ('danger', 'surface'),
  ('danger', 'dangerBg'),
  ('badgeInk', 'badge'),
  ('avatarFg', 'avatarBg'),
];

/// More text pairs, found in the approved prototype's screens.
const prototypeTextPairs = <Pair>[
  ('ink', 'raised'), // selected rows, key codes, the call stage
  ('muted', 'raised'), // day separators
  ('accentText', 'raised'), // "Borrador:" on a pressed row
  ('muted', 'bubbleIn'), // time of incoming messages
  ('accentText', 'bubbleIn'), // sender names in groups
  ('ink', 'accentSoft'), // selected options
  ('muted', 'accentSoft'),
  ('accentText', 'accentSoft'), // initials of the avatars, pressed toggles
];

/// Text pairs the mobile screens add.
const mobileTextPairs = <Pair>[
  ('danger', 'bg'), // "Colgar" under the hang-up button
  ('surface', 'danger'), // a solid danger button
  ('accentText', 'side'), // the selected tab of the bottom bar
  ('warn', 'surface'), // "Sin protección…" under the Chats title, "Se parece a…" in a request
  ('danger', 'side'), // a missed call's name on the bars' background
];

/// Status indicators and control states (WCAG 1.4.11). `line` is decorative.
const nonTextPairs = <Pair>[
  ('ok', 'surface'),
  ('accent', 'surface'), // switch on, selected segment
  ('accent', 'bg'),
  ('dangerBg', 'danger'), // the hang-up icon on its button
  ('accentText', 'surface'), // tab indicators and the focus ring
  ('accentText', 'bg'),
];

/// Where a control can sit: panels, the screen, the bars and pressed rows.
const backgrounds = ['surface', 'bg', 'side', 'raised'];

/// The boundary of a text field, normal or invalid, on every background.
final boundaryPairs = <Pair>[
  for (final boundary in ['controlLine', 'danger'])
    for (final background in backgrounds) (boundary, background),
];

/// The switch: each track on every background, and each knob on its track.
final switchPairs = <Pair>[
  ('surface', 'muted'), // knob on the off track
  ('accentInk', 'accent'), // knob on the on track
  for (final background in backgrounds) ...[('muted', background), ('accent', background)],
];

List<String> failures(ThemeTokens tokens, List<Pair> pairs, double minimum) => [
  for (final (foreground, background) in pairs)
    if (contrastRatio(tokens.colors[foreground]!, tokens.colors[background]!) case final ratio when ratio < minimum)
      '$foreground ${hexOf(tokens.colors[foreground]!)} on $background '
          '${hexOf(tokens.colors[background]!)}: ${ratio.toStringAsFixed(2)}:1',
];

void main() {
  for (final style in TrinoStyle.values) {
    for (final brightness in Brightness.values) {
      for (final accent in TrinoAccent.values) {
        group('${style.name} ${brightness.name} ${accent.name}', () {
          final tokens = resolveTokens(style, brightness, accent);

          test('text reaches 4.5:1', () {
            expect(failures(tokens, [...textPairs, ...prototypeTextPairs, ...mobileTextPairs], 4.5), isEmpty);
          });

          test('icons, status and control states reach 3:1', () {
            expect(failures(tokens, nonTextPairs, 3), isEmpty);
          });

          test('text field boundaries, normal and invalid, reach 3:1 on every background', () {
            expect(failures(tokens, boundaryPairs, 3), isEmpty);
          });

          test('the switch tracks and knobs reach 3:1', () {
            expect(failures(tokens, switchPairs, 3), isEmpty);
          });
        });
      }
    }
  }

  for (final id in ThemeId.values) {
    // As quiet as WCAG allows: a boundary, not a second muted text colour.
    test('the control boundary of ${id.key} stays between 3:1 and 3.6:1 on the closest background', () {
      final tokens = kThemes[id]!;
      final closest = backgrounds
          .map((background) => contrastRatio(tokens.controlLine, tokens.colors[background]!))
          .reduce((a, b) => a < b ? a : b);
      expect(closest, inInclusiveRange(3, 3.6));
    });
  }
}
