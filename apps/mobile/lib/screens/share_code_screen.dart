// "Compartir mi código": your contact code, to copy and send, and the key your
// contacts compare to verify you.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/button.dart';
import 'common.dart';

class ShareCodeScreen extends StatelessWidget {
  const ShareCodeScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const ShareCodeScreen());

  @override
  Widget build(BuildContext context) =>
      SubPage(title: context.l10n.shareMyCode, padding: const EdgeInsets.all(16), children: const [ShareCodeView()]);
}

class ShareCodeView extends StatefulWidget {
  const ShareCodeView({super.key});

  @override
  State<ShareCodeView> createState() => _ShareCodeViewState();
}

class _ShareCodeViewState extends State<ShareCodeView> {
  late final Stream<Profile> _profile = context.engine.profile;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    return StreamBuilder<Profile>(
      stream: _profile,
      builder: (context, snapshot) {
        final profile = snapshot.data;
        if (profile == null) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.shareCodeBody, style: text.body),
            const SizedBox(height: 20),
            TrinoLabel(l10n.yourCode),
            const SizedBox(height: 8),
            DecoratedBox(
              decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(t.radius)),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(profile.contactCode, style: text.code.copyWith(fontSize: 14)),
              ),
            ),
            const SizedBox(height: 10),
            TrinoButton(
              label: l10n.copyCode,
              icon: TrinoIcons.copy,
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: profile.contactCode));
                if (context.mounted) showNotice(context, l10n.copied);
              },
            ),
            const SizedBox(height: 8),
            Text(l10n.codeNotSecret, style: text.caption),
            const SizedBox(height: 24),
            TrinoLabel(l10n.yourKey),
            const SizedBox(height: 8),
            Text(profile.fingerprint, style: text.code.copyWith(fontSize: 18, letterSpacing: 1)),
            const SizedBox(height: 4),
            Text(l10n.yourKeyHelp, style: text.caption),
          ],
        );
      },
    );
  }
}
