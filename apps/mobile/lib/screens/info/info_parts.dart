// What the contact info and the group info share: the bar with back (and
// "Editar" for who administers), the large avatar with the name and a line in
// words under it, the row of actions, and the question before something that
// cannot be undone from here.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/haptics.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../ui/avatar.dart';
import '../../ui/button.dart';
import '../../ui/icon_button.dart';
import '../../ui/trust_badge.dart';

/// Back, and on the right [actions] such as "Editar". Beside the chat, on a
/// wide screen, close takes the place of back.
class InfoBar extends StatelessWidget {
  const InfoBar({super.key, this.actions = const [], this.onClose});

  final List<Widget> actions;

  /// Closes the info shown beside the chat.
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: context.tokens.line)),
    ),
    child: Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 8, 4),
      child: Row(
        children: [
          if (onClose case final close?)
            TrinoIconButton(icon: TrinoIcons.close, label: context.l10n.infoPaneClose, onPressed: close)
          else
            TrinoIconButton(
              icon: TrinoIcons.back,
              label: context.l10n.back,
              onPressed: () => Navigator.maybePop(context),
            ),
          const Spacer(),
          ...actions,
        ],
      ),
    ),
  );
}

/// The large avatar, the name (with the verified shield of a contact) as the
/// page's heading, and one line under it.
class InfoHeader extends StatelessWidget {
  const InfoHeader({
    super.key,
    required this.name,
    required this.kind,
    required this.subtitle,
    this.trust,
    this.warn = false,
  });

  final String name;
  final AvatarKind kind;
  final String subtitle;

  /// The shield beside the name; its label goes to screen readers.
  final ({TrustKind kind, String label})? trust;

  /// The line under the name in the warning colour, as a changed key.
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final trust = this.trust;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 16),
      child: Column(
        children: [
          TrinoAvatar(name: name, size: 88, kind: kind),
          const SizedBox(height: 12),
          Semantics(
            container: true,
            header: true,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(name, textAlign: TextAlign.center, style: context.text.title.copyWith(fontSize: 22)),
                ),
                if (trust != null) ...[
                  const SizedBox(width: 6),
                  TrustBadge(kind: trust.kind, label: trust.label, compact: true),
                ],
              ],
            ),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: context.text.secondary.copyWith(color: warn ? t.warn : t.muted),
          ),
        ],
      ),
    );
  }
}

/// The actions under the name, side by side and the same width.
class InfoActions extends StatelessWidget {
  const InfoActions({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
    child: Row(
      children: [
        for (final (index, child) in children.indexed) ...[
          if (index > 0) const SizedBox(width: 8),
          Expanded(child: child),
        ],
      ],
    ),
  );
}

/// An icon over its word, in an outlined tile: accentText on surface, or on
/// accentSoft while a toggle is on (both reach 4.5:1 in every theme).
class InfoAction extends StatelessWidget {
  const InfoAction({super.key, required this.icon, required this.label, required this.onPressed, this.pressed});

  final TrinoIcons icon;
  final String label;
  final VoidCallback onPressed;

  /// Makes it a toggle, such as "Silenciar".
  final bool? pressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final on = pressed == true;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(t.radiusLg),
      side: BorderSide(color: t.line),
    );
    return Semantics(
      container: true,
      button: true,
      toggled: pressed,
      label: label,
      excludeSemantics: true,
      onTap: onPressed,
      child: Material(
        color: on ? t.accentSoft : t.surface,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 60),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  TrinoIcon(icon, size: 22, color: t.accentText),
                  const SizedBox(height: 4),
                  Text(
                    label,
                    textAlign: TextAlign.center,
                    style: context.text.caption.copyWith(color: t.accentText, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Asks before something that cannot be undone from here: [title], what
/// happens in [body], and [confirm] in red or "Cancelar". Says whether the
/// user confirmed.
Future<bool> confirmDanger(
  BuildContext context, {
  required String title,
  required String body,
  required String confirm,
}) async {
  final l10n = context.l10n;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialog) => Dialog(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(container: true, header: true, child: Text(title, style: dialog.text.title)),
            const SizedBox(height: 8),
            Text(body, style: dialog.text.body),
            const SizedBox(height: 20),
            TrinoButton(
              label: confirm,
              variant: ButtonVariant.danger,
              expand: true,
              onPressed: () => Navigator.of(dialog).pop(true),
            ),
            const SizedBox(height: 8),
            TrinoButton(
              label: l10n.cancel,
              variant: ButtonVariant.ghost,
              expand: true,
              onPressed: () => Navigator.of(dialog).pop(false),
            ),
          ],
        ),
      ),
    ),
  );
  if (confirmed == true) unawaited(TrinoHaptics.destructiveConfirmed());
  return confirmed == true;
}
