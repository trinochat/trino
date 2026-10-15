// The first run. The welcome offers two ways in, "Crear una cuenta" and "Ya
// uso Trino en mi computador", with the language in words below them.
// Creating an account says first how Trino connects (Tor, in plain words,
// with a way out to the bridges when Tor is blocked), then asks for a name,
// a password (with the honest "nobody can recover it"), the style, optional
// two-step verification, and ends at "Todo listo" with your code.
//
// "Ya uso Trino en mi computador" links this phone instead (link_steps.dart):
// the instructions, the scanner, the code to compare while the computer
// confirms, "Listo", and then this phone's own password, the style and the
// optional 2FA, which open the chats. A phone links only here, at the first
// run: one that already has its own account does not mix with another.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/language.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../platform/qr_scanner.dart';
import '../ui/banner.dart';
import '../ui/button.dart';
import '../ui/list_row.dart';
import '../ui/text_field.dart';
import 'common.dart';
import 'connection/bridges_screen.dart';
import 'link_steps.dart';

enum _Step { welcome, tor, name, linkIntro, linkScan, linkConfirm, linkDone, password, style, twofa, twofaSetup, done }

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.onFinished});

  /// The user left "Todo listo": to the chats, or to add a first contact.
  final void Function({required bool addContact}) onFinished;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  late final TrinoEngine _engine = context.engine;
  final _name = TextEditingController();
  final _pass = TextEditingController();
  final _pass2 = TextEditingController();
  final _code = TextEditingController();
  var _step = _Step.welcome;
  String? _nameError;
  String? _passError;
  String? _pass2Error;
  String? _codeError;
  String? _createError;
  PassphraseCheck? _strength;
  TotpSetup? _totp;
  Profile? _profile;
  var _busy = false;

  /// "Ya uso Trino en mi computador": the password and 2FA steps finish the
  /// link instead of creating an account.
  var _linking = false;
  LinkSession? _session;
  StreamSubscription<LinkSession?>? _sessionSubscription;
  StreamSubscription<String>? _scans;
  String? _scanError;

  @override
  void dispose() {
    for (final controller in [_name, _pass, _pass2, _code]) {
      controller.dispose();
    }
    unawaited(_sessionSubscription?.cancel());
    unawaited(_scans?.cancel());
    super.dispose();
  }

  void _go(_Step step) => setState(() => _step = step);

  // Linking.

  void _startLink() => setState(() {
    _linking = true;
    _step = _Step.linkIntro;
  });

  void _leaveLink() => setState(() {
    _linking = false;
    _step = _Step.welcome;
  });

  void _openScanner() {
    unawaited(_scans?.cancel());
    _scans = context.scanner.scan().listen(_onScan);
    setState(() {
      _scanError = null;
      _step = _Step.linkScan;
    });
  }

  void _closeScanner() {
    unawaited(_scans?.cancel());
    _scans = null;
    _go(_Step.linkIntro);
  }

  Future<void> _onScan(String payload) async {
    if (_busy) return;
    final l10n = context.l10n;
    setState(() => _busy = true);
    try {
      final session = await _engine.beginLink(payload);
      if (!mounted) return;
      unawaited(_scans?.cancel());
      _scans = null;
      _sessionSubscription ??= _engine.linking.listen(_onSession);
      setState(() {
        _session = session;
        _step = _Step.linkConfirm;
      });
    } on InvalidLinkCode {
      if (mounted) setState(() => _scanError = l10n.linkScanInvalid);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The computer confirmed, said no, or the QR expired.
  void _onSession(LinkSession? session) {
    if (!mounted) return;
    setState(() {
      _session = session;
      if (session?.status == LinkStatus.linked && _step == _Step.linkConfirm) _step = _Step.linkDone;
    });
  }

  void _submitName() {
    if (_name.text.trim().isEmpty) {
      setState(() => _nameError = context.l10n.onbErrNameRequired);
      return;
    }
    setState(() => _nameError = null);
    _go(_Step.password);
  }

  Future<void> _rateStrength(String passphrase) async {
    final check = await _engine.checkPassphrase(passphrase);
    if (mounted && _pass.text == passphrase) setState(() => _strength = check);
  }

  Future<void> _submitPassword() async {
    final l10n = context.l10n;
    final check = await _engine.checkPassphrase(_pass.text);
    if (!mounted) return;
    setState(() {
      _strength = check;
      _passError = switch (check.problem) {
        PassphraseProblem.tooShort => l10n.onbErrTooShort(check.minLength),
        PassphraseProblem.tooCommon => l10n.onbErrTooCommon,
        null => null,
      };
      _pass2Error = _passError == null && _pass.text != _pass2.text ? l10n.onbErrMismatch : null;
    });
    if (_passError == null && _pass2Error == null) _go(_Step.style);
  }

  Future<void> _beginTotp() async {
    final setup = await _engine.beginTotp();
    if (!mounted) return;
    setState(() {
      _totp = setup;
      _codeError = null;
      _step = _Step.twofaSetup;
    });
  }

  Future<void> _verifyTotp() async {
    final ok = await _engine.verifyTotp(_code.text.trim());
    if (!mounted) return;
    if (!ok) {
      setState(() => _codeError = context.l10n.onbErrCode);
      return;
    }
    await (_linking ? _finishLink(withTotp: true) : _create(withTotp: true));
  }

  /// This phone's own password (and 2FA) opens the account of the computer.
  Future<void> _finishLink({required bool withTotp}) async {
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _createError = null;
    });
    try {
      await _engine.finishLink(passphrase: _pass.text, withTotp: withTotp);
      if (mounted) widget.onFinished(addContact: false);
    } on Object {
      if (mounted) setState(() => _createError = l10n.linkErrFinish);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _create({required bool withTotp}) async {
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _createError = null;
    });
    try {
      await _engine.createIdentity(name: _name.text.trim(), passphrase: _pass.text, withTotp: withTotp);
      final profile = await _engine.profile.first;
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _step = _Step.done;
      });
    } on Object {
      if (mounted) setState(() => _createError = l10n.onbErrCreate);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (_step == _Step.welcome) return _welcome(l10n);
    if (_step == _Step.linkScan) {
      final scanner = context.scanner;
      return LinkScanPage(
        onClose: _closeScanner,
        error: _scanError,
        onSimulate: scanner is DemoQrScanner ? scanner.simulate : null,
      );
    }
    final header = switch (_step) {
      _Step.linkIntro => LinkStepBar(title: l10n.linkTitle, onBack: _leaveLink),
      _Step.linkConfirm || _Step.linkDone => LinkStepBar(title: l10n.linkTitle),
      _ => Padding(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
        child: Row(
          children: [ExcludeSemantics(child: Text(context.tokens.wordmark, style: context.text.title))],
        ),
      ),
    };
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            header,
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: _content(l10n)),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Column(mainAxisSize: MainAxisSize.min, children: _actions(l10n)),
            ),
          ],
        ),
      ),
    );
  }

  /// The wordmark, what Trino is in one line, and the two ways in.
  Widget _welcome(AppLocalizations l10n) {
    final t = context.tokens;
    final current = Localizations.localeOf(context);
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 48, 24, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ExcludeSemantics(
                      child: Text(
                        t.wordmark,
                        style: context.text.largeTitle.copyWith(fontSize: 36, color: t.accentText),
                      ),
                    ),
                    const SizedBox(height: 24),
                    _title(l10n.onbTagline),
                    _body(l10n.onbIntro),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TrinoButton(
                    label: l10n.onbCreate,
                    variant: ButtonVariant.primary,
                    expand: true,
                    onPressed: () => _go(_Step.tor),
                  ),
                  const SizedBox(height: 8),
                  TrinoButton(label: l10n.linkStart, expand: true, onPressed: _startLink),
                  const SizedBox(height: 4),
                  Center(
                    child: TrinoButton(
                      label: languageName(current),
                      icon: TrinoIcons.globe,
                      variant: ButtonVariant.quiet,
                      onPressed: () => unawaited(_chooseLanguage()),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The languages, each named in itself; choosing one applies it at once.
  Future<void> _chooseLanguage() {
    final language = AppScope.read(context).language;
    final current = Localizations.localeOf(context).languageCode;
    return showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SectionLabel(sheet.l10n.onbLanguage),
            for (final (:locale, :name) in kLanguages)
              ChoiceRow(
                title: name,
                selected: locale.languageCode == current,
                onTap: () {
                  language.setLocale(locale);
                  Navigator.of(sheet).pop();
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Widget _title(String text) =>
      Semantics(container: true, header: true, child: Text(text, style: context.text.headline));

  Widget _body(String text) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 24),
    child: Text(text, style: context.text.body.copyWith(color: context.tokens.muted)),
  );

  List<Widget> _content(AppLocalizations l10n) {
    switch (_step) {
      case _Step.welcome:
        return const [];
      case _Step.tor:
        return [_title(l10n.onbTorTitle), _body(l10n.onbTorBody)];
      case _Step.linkIntro:
        return const [LinkInstructions()];
      case _Step.linkScan:
        return const [];
      case _Step.linkConfirm:
        final session = _session;
        return [
          if (session != null)
            LinkConfirmation(session: session, onBringChats: (on) => unawaited(_engine.setBringChats(on))),
        ];
      case _Step.linkDone:
        return [LinkDone(session: _session)];
      case _Step.name:
        return [
          _title(l10n.onbNameTitle),
          _body(l10n.onbNameBody),
          TrinoTextField(
            controller: _name,
            label: l10n.onbNameLabel,
            error: _nameError,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.next,
            onSubmitted: (_) => _submitName(),
          ),
        ];
      case _Step.password:
        final strength = _strength;
        return [
          _title(_linking ? l10n.linkPassTitle : l10n.onbPassTitle),
          _body(_linking ? l10n.linkPassBody : l10n.onbPassBody),
          TrinoPasswordField(
            controller: _pass,
            label: l10n.onbPassLabel,
            showLabel: l10n.showPassword,
            error: _passError,
            autofillHints: const [AutofillHints.newPassword],
            onChanged: _rateStrength,
          ),
          if (strength != null && _pass.text.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Semantics(
                liveRegion: true,
                child: Text(_strengthLabel(strength.strength, l10n), style: context.text.caption),
              ),
            ),
          const SizedBox(height: 16),
          TrinoPasswordField(
            controller: _pass2,
            label: l10n.onbPass2Label,
            showLabel: l10n.showPassword,
            error: _pass2Error,
            autofillHints: const [AutofillHints.newPassword],
          ),
          const SizedBox(height: 20),
          _NoRecoveryNote(l10n.onbNoRecovery),
        ];
      case _Step.style:
        final appearance = AppScope.of(context).appearance;
        return [
          _title(l10n.onbStyleTitle),
          _body(l10n.onbStyleBody),
          for (final (style, name, description) in [
            (TrinoStyle.calma, l10n.styleCalma, l10n.onbCalmaDesc),
            (TrinoStyle.terminal, l10n.styleTerminal, l10n.onbTerminalDesc),
          ])
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _StyleCard(
                style: style,
                name: name,
                description: description,
                selected: appearance.value.style == style,
                onTap: () => appearance.setStyle(style),
              ),
            ),
        ];
      case _Step.twofa:
        return [_title(l10n.onbTwofaTitle), _body(l10n.onbTwofaBody), ..._createErrorBanner()];
      case _Step.twofaSetup:
        final totp = _totp;
        return [
          _title(l10n.onbTwofaTitle),
          _body(l10n.onbTwofaSetup),
          TrinoLabel(l10n.onbTwofaKey),
          const SizedBox(height: 8),
          if (totp != null) _CodeBox(text: totp.secret, copyLabel: l10n.onbCopy),
          const SizedBox(height: 20),
          TrinoTextField(
            controller: _code,
            label: l10n.onbTwofaCode,
            error: _codeError,
            mono: true,
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.done,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            onSubmitted: (_) => _verifyTotp(),
          ),
          ..._createErrorBanner(),
        ];
      case _Step.done:
        final profile = _profile;
        return [
          _title(l10n.onbDoneTitle),
          _body(l10n.onbDoneBody),
          TrinoLabel(l10n.yourCode),
          const SizedBox(height: 8),
          if (profile != null) _CodeBox(text: profile.contactCode, copyLabel: l10n.onbCopy),
        ];
    }
  }

  List<Widget> _createErrorBanner() => [
    if (_createError != null) ...[
      const SizedBox(height: 16),
      TrinoBanner(tone: BannerTone.danger, message: _createError!),
    ],
  ];

  List<Widget> _actions(AppLocalizations l10n) {
    Widget primary(String label, VoidCallback? onPressed) => TrinoButton(
      label: _busy ? (_linking ? l10n.linkFinishing : l10n.onbCreating) : label,
      variant: ButtonVariant.primary,
      expand: true,
      loading: _busy,
      onPressed: onPressed,
    );
    Widget secondary(String label, VoidCallback? onPressed, {ButtonVariant variant = ButtonVariant.secondary}) =>
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: TrinoButton(label: label, variant: variant, expand: true, onPressed: _busy ? null : onPressed),
        );
    Widget backAndNext(_Step back, VoidCallback next) => Row(
      children: [
        TrinoButton(label: l10n.onbBack, variant: ButtonVariant.ghost, onPressed: () => _go(back)),
        const SizedBox(width: 8),
        Expanded(
          child: TrinoButton(label: l10n.onbNext, variant: ButtonVariant.primary, expand: true, onPressed: next),
        ),
      ],
    );
    switch (_step) {
      case _Step.welcome:
        return const [];
      case _Step.tor:
        return [
          backAndNext(_Step.welcome, () => _go(_Step.name)),
          secondary(
            l10n.onbTorBlocked,
            () => unawaited(Navigator.of(context).push(BridgesScreen.route())),
            variant: ButtonVariant.quiet,
          ),
        ];
      case _Step.name:
        return [backAndNext(_Step.tor, _submitName)];
      case _Step.linkIntro:
        return [
          TrinoButton(
            label: l10n.linkScan,
            icon: TrinoIcons.scan,
            variant: ButtonVariant.primary,
            expand: true,
            onPressed: _openScanner,
          ),
        ];
      case _Step.linkScan:
        return const [];
      case _Step.linkConfirm:
        if (_session?.status == LinkStatus.failed) {
          return [
            TrinoButton(
              label: l10n.linkRestart,
              variant: ButtonVariant.primary,
              expand: true,
              onPressed: () => _go(_Step.linkIntro),
            ),
          ];
        }
        return [TrinoButton(label: l10n.cancel, expand: true, onPressed: () => unawaited(_engine.cancelLink()))];
      case _Step.linkDone:
        return [
          TrinoButton(
            label: l10n.onbNext,
            variant: ButtonVariant.primary,
            expand: true,
            onPressed: () => _go(_Step.password),
          ),
        ];
      case _Step.password:
        return [backAndNext(_linking ? _Step.linkDone : _Step.name, _submitPassword)];
      case _Step.style:
        return [backAndNext(_Step.password, () => _go(_Step.twofa))];
      case _Step.twofa:
        return [
          primary(l10n.onbTwofaOn, _busy ? null : _beginTotp),
          secondary(l10n.onbTwofaLater, () => _linking ? _finishLink(withTotp: false) : _create(withTotp: false)),
          secondary(l10n.onbBack, () => _go(_Step.style), variant: ButtonVariant.ghost),
        ];
      case _Step.twofaSetup:
        return [
          primary(l10n.onbVerify, _busy ? null : _verifyTotp),
          secondary(l10n.onbTwofaBack, () => _go(_Step.twofa), variant: ButtonVariant.ghost),
        ];
      case _Step.done:
        return [
          primary(l10n.onbGoChats, () => widget.onFinished(addContact: false)),
          secondary(l10n.onbAddFirst, () => widget.onFinished(addContact: true)),
        ];
    }
  }

  static String _strengthLabel(PassphraseStrength strength, AppLocalizations l10n) => switch (strength) {
    PassphraseStrength.weak => l10n.onbStrengthWeak,
    PassphraseStrength.fair => l10n.onbStrengthFair,
    PassphraseStrength.good => l10n.onbStrengthGood,
    PassphraseStrength.strong => l10n.onbStrengthStrong,
  };
}

/// "Si la olvidas, nadie la puede recuperar…": a line with a lock, not a panel.
class _NoRecoveryNote extends StatelessWidget {
  const _NoRecoveryNote(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 1),
        child: TrinoIcon(TrinoIcons.lock, size: 18, color: context.tokens.muted),
      ),
      const SizedBox(width: 8),
      Expanded(
        child: Text(text, style: context.text.secondary.copyWith(color: context.tokens.ink)),
      ),
    ],
  );
}

/// A style to choose, previewed in its own tokens.
class _StyleCard extends StatelessWidget {
  const _StyleCard({
    required this.style,
    required this.name,
    required this.description,
    required this.selected,
    required this.onTap,
  });

  final TrinoStyle style;
  final String name;
  final String description;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final current = context.trino;
    final preview = resolveTokens(style, current.brightness, TrinoAccent.verde);
    final l10n = context.l10n;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(current.tokens.radiusLg),
      side: BorderSide(color: selected ? current.tokens.accentText : current.tokens.line, width: 2),
    );
    Widget bubble(String text, {required bool mine}) => Align(
      alignment: mine ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: mine ? preview.bubbleMe : preview.bubbleIn,
          border: Border.all(color: mine ? preview.bubbleMeLine : preview.bubbleInLine),
          borderRadius: BorderRadius.circular(preview.bubbleRadius),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          child: Text(
            text,
            style: TextStyle(
              fontFamily: preview.font,
              fontSize: 13,
              color: mine ? preview.bubbleMeInk : preview.bubbleInInk,
            ),
          ),
        ),
      ),
    );
    return MergeSemantics(
      child: Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        child: DecoratedBox(
          decoration: ShapeDecoration(color: current.tokens.surface, shape: shape),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              customBorder: shape,
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ExcludeSemantics(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: preview.bg,
                          border: Border.all(color: preview.line),
                          borderRadius: BorderRadius.circular(preview.radius),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.all(10),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              bubble(l10n.onbPreviewIn, mine: false),
                              const SizedBox(height: 6),
                              bubble(l10n.onbPreviewOut, mine: true),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(child: Text(name, style: context.text.bodyStrong)),
                        if (selected) TrinoIcon(TrinoIcons.check, size: 20, color: current.tokens.accentText),
                      ],
                    ),
                    Text(description, style: context.text.secondary),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A code to read and copy, such as your contact code or the 2FA key.
class _CodeBox extends StatelessWidget {
  const _CodeBox({required this.text, required this.copyLabel});

  final String text;
  final String copyLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DecoratedBox(
          decoration: BoxDecoration(color: t.raised, borderRadius: BorderRadius.circular(t.radius)),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Text(text, style: context.text.code),
          ),
        ),
        const SizedBox(height: 8),
        TrinoButton(
          label: copyLabel,
          icon: TrinoIcons.copy,
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: text.replaceAll(' ', '')));
            if (context.mounted) showNotice(context, context.l10n.copied);
          },
        ),
      ],
    );
  }
}
