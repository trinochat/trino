// Apariencia: style, mode and accent, applied at once to the whole app, and
// how much it moves (Animaciones).
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/appearance.dart';
import '../../design/theme.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/list_row.dart';
import '../../ui/message_bubble.dart';
import '../../ui/segmented.dart';
import '../../ui/settings_group.dart';
import '../common.dart';

class AppearanceScreen extends StatelessWidget {
  const AppearanceScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final appearance = AppScope.of(context).appearance;
    return ListenableBuilder(
      listenable: appearance,
      builder: (context, _) {
        final value = appearance.value;
        return SubPage(
          title: l10n.sectionAppearance,
          children: [
            SectionLabel(l10n.appearanceStyle),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TrinoSegmented<TrinoStyle>(
                semanticLabel: l10n.appearanceStyle,
                options: [
                  (value: TrinoStyle.calma, label: l10n.styleCalma),
                  (value: TrinoStyle.terminal, label: l10n.styleTerminal),
                ],
                selected: value.style,
                onChanged: appearance.setStyle,
              ),
            ),
            SectionLabel(l10n.appearanceMode),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TrinoSegmented<AppearanceMode>(
                semanticLabel: l10n.appearanceMode,
                options: [
                  (value: AppearanceMode.light, label: l10n.modeLight),
                  (value: AppearanceMode.dark, label: l10n.modeDark),
                  (value: AppearanceMode.system, label: l10n.modeSystem),
                ],
                selected: value.mode,
                onChanged: appearance.setMode,
              ),
            ),
            SectionLabel(l10n.appearanceAccent),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(l10n.appearanceAccentHelp, style: context.text.secondary),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Wrap(
                spacing: 4,
                children: [
                  for (final accent in TrinoAccent.values)
                    _AccentSwatch(
                      accent: accent,
                      label: accentName(accent, l10n),
                      selected: value.accent == accent,
                      onTap: () => appearance.setAccent(accent),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const _Preview(),
            SectionLabel(l10n.appearanceAnimations),
            SettingsGroup(
              children: [
                for (final (setting, title, subtitle) in [
                  (AnimationsSetting.system, l10n.animationsSystem, l10n.animationsSystemHelp),
                  (AnimationsSetting.reduced, l10n.animationsReduced, l10n.animationsReducedHelp),
                  (AnimationsSetting.none, l10n.animationsNone, l10n.animationsNoneHelp),
                ])
                  ChoiceRow(
                    title: title,
                    subtitle: subtitle,
                    selected: value.animations == setting,
                    onTap: () => appearance.setAnimations(setting),
                  ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Text(l10n.animationsNote, style: context.text.secondary),
            ),
          ],
        );
      },
    );
  }
}

String accentName(TrinoAccent accent, AppLocalizations l10n) => switch (accent) {
  TrinoAccent.verde => l10n.accentVerde,
  TrinoAccent.azul => l10n.accentAzul,
  TrinoAccent.morado => l10n.accentMorado,
  TrinoAccent.naranja => l10n.accentNaranja,
};

/// A circle in the accent's button colour for the current style and mode.
class _AccentSwatch extends StatelessWidget {
  const _AccentSwatch({required this.accent, required this.label, required this.selected, required this.onTap});

  final TrinoAccent accent;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final trino = context.trino;
    final color = resolveTokens(trino.style, trino.brightness, accent).accent;
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      label: label,
      child: ExcludeSemantics(
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox.square(
              dimension: 52,
              child: Center(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    // The ring says which is chosen without relying on the colour.
                    border: Border.all(color: selected ? trino.tokens.ink : Colors.transparent, width: 3),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(3),
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                      child: const SizedBox.square(dimension: 32),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Preview extends StatelessWidget {
  const _Preview();

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: t.bg,
          border: Border.all(color: t.line),
          borderRadius: BorderRadius.circular(t.radius),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              MessageBubble(direction: BubbleDirection.incoming, text: l10n.appearancePreviewIn, time: '10:41'),
              const SizedBox(height: 6),
              MessageBubble(
                direction: BubbleDirection.outgoing,
                text: l10n.appearancePreviewOut,
                time: '10:42',
                status: (state: DeliveryState.sent, label: l10n.statusSent),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
