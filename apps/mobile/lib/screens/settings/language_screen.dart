// Idioma: Español, English or Português, applied at once.
import 'package:flutter/material.dart';

import '../../app/language.dart';
import '../../app/scope.dart';
import '../../design/theme.dart';
import '../../ui/list_row.dart';
import '../common.dart';

class LanguageScreen extends StatelessWidget {
  const LanguageScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final language = AppScope.of(context).language;
    final current = Localizations.localeOf(context).languageCode;
    return SubPage(
      title: l10n.sectionLanguage,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text(l10n.languageHelp, style: context.text.secondary),
        ),
        for (final (:locale, :name) in kLanguages)
          ChoiceRow(title: name, selected: locale.languageCode == current, onTap: () => language.setLocale(locale)),
      ],
    );
  }
}
