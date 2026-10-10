// Avatar of a contact, a group or a message request: the initials on the
// accent tint (accentText on accentSoft, 4.5:1 in every theme and accent, as
// the desktop's R2-B), or "?" in the warning colours for a request.
import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../design/theme.dart';

enum AvatarKind { person, group, request }

/// The first letters of the first two words, in capitals.
String initialsOf(String name) => name
    .trim()
    .split(RegExp(r'\s+'))
    .where((word) => word.isNotEmpty)
    .take(2)
    .map((word) => word.characters.first.toUpperCase())
    .join();

class TrinoAvatar extends StatelessWidget {
  const TrinoAvatar({super.key, required this.name, this.size = 48, this.kind = AvatarKind.person, this.semanticLabel});

  final String name;
  final double size;
  final AvatarKind kind;

  /// Without it the avatar is decoration beside a visible name.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final request = kind == AvatarKind.request;
    // People take the theme's avatar radius (round in Calma); groups are
    // squared, as in the prototype.
    final radius = kind == AvatarKind.group ? (size >= 64 ? t.radiusLg : t.radius) : t.avatarRadius;
    final round = radius >= size / 2;
    final avatar = SizedBox.square(
      dimension: size,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: request ? t.warnBg : t.accentSoft,
          shape: round ? BoxShape.circle : BoxShape.rectangle,
          borderRadius: round ? null : BorderRadius.circular(radius),
        ),
        child: Center(
          child: Text(
            request ? '?' : initialsOf(name),
            maxLines: 1,
            // The name is written beside it; the initials must fit the shape.
            textScaler: TextScaler.noScaling,
            style: TextStyle(
              fontFamily: t.font,
              fontSize: math.max(14, size * 0.34),
              fontWeight: FontWeight.w700,
              height: 1,
              color: request ? t.warn : t.accentText,
            ),
          ),
        ),
      ),
    );
    final label = semanticLabel;
    if (label == null) return ExcludeSemantics(child: avatar);
    return Semantics(
      image: true,
      label: label,
      child: ExcludeSemantics(child: avatar),
    );
  }
}
