// "Qué ven los demás": three short lines and one that promises nothing more.
// What the phone itself gives away (the app store, the notifications) and the
// bridge codes wait under "Opciones avanzadas".
//
// The notifications line follows the user's choice in Notificaciones: with
// "Nombre y mensaje" the text does show, and the screen says so.
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../ui/advanced_section.dart';
import '../common.dart';

class WhatOthersSeeScreen extends StatefulWidget {
  const WhatOthersSeeScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const WhatOthersSeeScreen());

  @override
  State<WhatOthersSeeScreen> createState() => _WhatOthersSeeScreenState();
}

class _WhatOthersSeeScreenState extends State<WhatOthersSeeScreen> {
  late final Stream<EngineSettings> _settings = context.engine.settings;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    return SubPage(
      title: l10n.connectionWhatOthersSee,
      children: [
        const SizedBox(height: 12),
        _Line(icon: TrinoIcons.globe, text: l10n.seeServers),
        _Line(icon: TrinoIcons.door, text: l10n.seeProvider),
        _Line(icon: TrinoIcons.phone, text: l10n.seeCalls),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
          child: DecoratedBox(
            decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.radius)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Text(l10n.seeNotInvisible, style: text.body.copyWith(fontWeight: FontWeight.w700)),
            ),
          ),
        ),
        StreamBuilder<EngineSettings>(
          stream: _settings,
          builder: (context, snapshot) {
            final preview = snapshot.data?.notificationPreview;
            return AdvancedSection(
              title: l10n.advancedOptions,
              children: [
                const SizedBox(height: 4),
                _Line(text: l10n.seeStores),
                if (preview != null)
                  _Line(
                    text: preview == NotificationPreview.nameAndMessage
                        ? l10n.seeNotificationsWithContent
                        : l10n.seeNotificationsNoContent,
                  ),
                _Line(text: l10n.seeBridgeCode),
              ],
            );
          },
        ),
      ],
    );
  }
}

/// One thing someone can see, with an icon when it stands out.
class _Line extends StatelessWidget {
  const _Line({required this.text, this.icon});

  final String text;
  final TrinoIcons? icon;

  @override
  Widget build(BuildContext context) {
    final style = icon == null ? context.text.secondary : context.text.body;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (icon != null) ...[
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: TrinoIcon(icon!, size: 20, color: context.tokens.muted),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(child: Text(text, style: style)),
        ],
      ),
    );
  }
}
