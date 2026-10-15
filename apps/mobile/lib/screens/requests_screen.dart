// Message requests: people who are not your contacts. The list says who they
// say they are ("dice llamarse"), how they reached you and when; one request
// shows its messages as plain text, with no tappable links and no downloads,
// and the choices: Aceptar, Eliminar, Bloquear and Reportar.
import 'dart:async';

import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/banner.dart';
import '../ui/button.dart';
import '../ui/icon_button.dart';
import 'chat_screen.dart';
import 'common.dart';

/// The name as the request shows it: with "~" when it comes from a group,
/// where the admin set it.
String shownName(MessageRequest request) =>
    request.origin == RequestOrigin.group ? '~${request.claimedName}' : request.claimedName;

/// How they reached you: "por tu @nombre", "usó tu enlace «Taller»"…
String originOf(MessageRequest request, AppLocalizations l10n) {
  final label = request.originLabel;
  return switch (request.origin) {
    RequestOrigin.username => l10n.requestOriginUsername,
    RequestOrigin.link => label == null ? l10n.requestOriginLinkUnnamed : l10n.requestOriginLink(label),
    RequestOrigin.code => label == null ? l10n.requestOriginCodeUnnamed : l10n.requestOriginCode(label),
    RequestOrigin.group => l10n.requestOriginGroup(label ?? ''),
  };
}

/// "dice llamarse" and the name in bold.
class _ClaimedName extends StatelessWidget {
  const _ClaimedName({required this.request, required this.nameStyle});

  final MessageRequest request;
  final TextStyle nameStyle;

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(
      children: [
        TextSpan(text: '${context.l10n.requestClaims} ', style: context.text.secondary),
        TextSpan(
          text: shownName(request),
          style: nameStyle.copyWith(color: context.tokens.ink, fontWeight: FontWeight.w700),
        ),
      ],
    ),
  );
}

class RequestsScreen extends StatefulWidget {
  const RequestsScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const RequestsScreen());

  @override
  State<RequestsScreen> createState() => _RequestsScreenState();
}

class _RequestsScreenState extends State<RequestsScreen> {
  late final Stream<List<MessageRequest>> _requests = context.engine.requests;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            SubPageBar(title: l10n.requestsTitle),
            Expanded(
              child: StreamBuilder<List<MessageRequest>>(
                stream: _requests,
                builder: (context, snapshot) {
                  final requests = snapshot.data;
                  if (requests == null) return const SizedBox.shrink();
                  return ListView(
                    children: [
                      DecoratedBox(
                        decoration: BoxDecoration(
                          border: Border(bottom: BorderSide(color: t.line)),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                          child: Text(l10n.requestsNotice, style: context.text.secondary),
                        ),
                      ),
                      if (requests.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(l10n.noRequests, textAlign: TextAlign.center, style: context.text.secondary),
                        ),
                      for (final request in requests)
                        RequestRow(
                          key: ValueKey(request.id),
                          request: request,
                          onTap: () => Navigator.of(context).push(RequestScreen.route(request.id)),
                        ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A request in the list: initials (never a photo), "dice llamarse", how it
/// came and when, the first words and, if the name is like a contact's, a
/// line in the warning colour.
class RequestRow extends StatelessWidget {
  const RequestRow({super.key, required this.request, required this.onTap});

  final MessageRequest request;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    final firstWords =
        request.messages.firstOrNull?.text ??
        (request.attachments.isNotEmpty
            ? l10n.requestPreviewFile
            : request.triedToCall
            ? l10n.requestPreviewCall
            : null);
    final resembles = request.resemblesContact;
    return MergeSemantics(
      child: Semantics(
        button: true,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: t.line)),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TrinoAvatar(name: request.claimedName, size: 40),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _ClaimedName(request: request, nameStyle: text.secondary),
                          Text(
                            '${originOf(request, l10n)} · ${formatAgo(context, request.receivedAt, context.now())}',
                            style: text.caption,
                          ),
                          if (request.origin == RequestOrigin.group) Text(l10n.requestAdminName, style: text.caption),
                          if (firstWords != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                firstWords,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: text.secondary.copyWith(color: t.ink),
                              ),
                            ),
                          if (resembles != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                l10n.requestResembles(resembles),
                                style: text.secondary.copyWith(color: t.warn, fontWeight: FontWeight.w600),
                              ),
                            ),
                        ],
                      ),
                    ),
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

class RequestScreen extends StatefulWidget {
  const RequestScreen({super.key, required this.requestId});

  static Route<void> route(String requestId) => MaterialPageRoute(builder: (_) => RequestScreen(requestId: requestId));

  static const headerKey = ValueKey('request-header');

  final String requestId;

  @override
  State<RequestScreen> createState() => _RequestScreenState();
}

class _RequestScreenState extends State<RequestScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<MessageRequest>> _requests = _engine.requests;

  /// The request as last seen: it stays on screen while the page leaves.
  MessageRequest? _request;
  var _busy = false;

  Future<void> _accept() async {
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    final chatId = await _engine.acceptRequest(widget.requestId);
    final chats = await _engine.chats.first;
    final chat = chats.firstWhere((chat) => chat.id == chatId);
    unawaited(navigator.pushReplacement(ChatScreen.route(chat)));
  }

  Future<void> _delete() async {
    final l10n = context.l10n;
    await _leaveWith(_engine.deleteRequest(widget.requestId), l10n.requestDeleted);
  }

  Future<void> _block(MessageRequest request) async {
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
              Semantics(
                container: true,
                header: true,
                child: Text(l10n.requestBlockTitle(request.claimedName), style: dialog.text.title),
              ),
              const SizedBox(height: 8),
              Text(l10n.requestBlockBody, style: dialog.text.body),
              const SizedBox(height: 20),
              TrinoButton(
                label: l10n.requestBlock,
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
    if (confirmed != true || !mounted) return;
    await _leaveWith(_engine.blockRequest(widget.requestId), l10n.requestBlocked(request.claimedName));
  }

  Future<void> _report() async {
    final l10n = context.l10n;
    await _engine.reportRequest(widget.requestId);
    if (mounted) showNotice(context, l10n.requestReported);
  }

  /// Waits for [action], goes back to the list and says what happened there.
  Future<void> _leaveWith(Future<void> action, String notice) async {
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    await action;
    navigator.pop();
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(notice)));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: StreamBuilder<List<MessageRequest>>(
        stream: _requests,
        builder: (context, snapshot) {
          final current = snapshot.data?.where((r) => r.id == widget.requestId).firstOrNull;
          if (current != null) _request = current;
          final request = _request;
          if (request == null) return SubPageBar(title: context.l10n.requestsTitle);
          return Column(
            children: [
              _Header(key: RequestScreen.headerKey, request: request),
              Expanded(child: _Body(request: request)),
              _Actions(
                busy: _busy,
                onAccept: _accept,
                onDelete: _delete,
                onBlock: () => _block(request),
                onReport: _report,
              ),
            ],
          );
        },
      ),
    ),
  );
}

class _Header extends StatelessWidget {
  const _Header({super.key, required this.request});

  final MessageRequest request;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = context.text;
    final shortFingerprint = request.fingerprint.split(' ').take(2).join(' ');
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: context.tokens.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 16, 8),
        child: Row(
          children: [
            TrinoIconButton(icon: TrinoIcons.back, label: l10n.back, onPressed: () => Navigator.maybePop(context)),
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    container: true,
                    header: true,
                    child: _ClaimedName(request: request, nameStyle: text.bodyStrong),
                  ),
                  Text(
                    '${originOf(request, l10n)} · ${l10n.requestFingerprint(shortFingerprint)}',
                    style: text.caption,
                  ),
                  if (request.origin == RequestOrigin.group) Text(l10n.requestAdminName, style: text.caption),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What they sent, in time order. Messages are plain text: a link in them
/// is only text. Files are described, never downloaded; a call attempt is a
/// line of words.
class _Body extends StatelessWidget {
  const _Body({required this.request});

  final MessageRequest request;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final resembles = request.resemblesContact;
    final items = <(DateTime, int, Widget)>[
      for (final (index, message) in request.messages.indexed) (message.sentAt, index, _MessageText(message: message)),
      for (final attachment in request.attachments)
        (attachment.sentAt, request.messages.length, _AttachmentNote(attachment: attachment)),
      if (request.callAttemptAt case final at?)
        (at, request.messages.length + 1, _CallAttempt(name: request.claimedName, at: at)),
    ]..sort((a, b) => a.$1.compareTo(b.$1) != 0 ? a.$1.compareTo(b.$1) : a.$2.compareTo(b.$2));
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      children: [
        if (resembles != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: TrinoBanner(tone: BannerTone.warn, message: l10n.requestResemblesLong(resembles)),
          ),
        for (final (_, _, widget) in items) Padding(padding: const EdgeInsets.only(bottom: 10), child: widget),
      ],
    );
  }
}

class _MessageText extends StatelessWidget {
  const _MessageText({required this.message});

  final RequestMessage message;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: t.bubbleIn,
            border: Border.all(color: t.bubbleInLine),
            borderRadius: BorderRadius.circular(t.radiusLg),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                SizedBox(
                  width: double.infinity,
                  child: Text(message.text, style: context.text.body.copyWith(color: t.bubbleInInk)),
                ),
                Text(formatTime(context, message.sentAt), style: context.text.mono),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AttachmentNote extends StatelessWidget {
  const _AttachmentNote({required this.attachment});

  final RequestAttachment attachment;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: t.line),
        borderRadius: BorderRadius.circular(t.radius),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TrinoIcon(TrinoIcons.file, size: 18, color: t.muted),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                l10n.requestSentFile(
                  l10n.attachmentKind(attachment.kind.name),
                  formatFileSize(context, attachment.sizeBytes),
                ),
                style: context.text.secondary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CallAttempt extends StatelessWidget {
  const _CallAttempt({required this.name, required this.at});

  final String name;
  final DateTime at;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return MergeSemantics(
      child: Wrap(
        alignment: WrapAlignment.center,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 6,
        children: [
          TrinoIcon(TrinoIcons.phoneMissed, size: 15, color: t.muted),
          Text(context.l10n.requestTriedToCall(name), style: context.text.caption),
          Text(formatTime(context, at), style: context.text.mono),
        ],
      ),
    );
  }
}

/// Aceptar, the one main action; under it Eliminar, and Bloquear and
/// Reportar in the danger colour. In a column at large text sizes.
class _Actions extends StatelessWidget {
  const _Actions({
    required this.busy,
    required this.onAccept,
    required this.onDelete,
    required this.onBlock,
    required this.onReport,
  });

  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onDelete;
  final VoidCallback onBlock;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final enabled = !busy;
    final secondary = [
      TrinoButton(
        label: l10n.requestDelete,
        icon: TrinoIcons.trash,
        compact: true,
        expand: true,
        onPressed: enabled ? onDelete : null,
      ),
      TrinoButton(
        label: l10n.requestBlock,
        icon: TrinoIcons.ban,
        variant: ButtonVariant.danger,
        compact: true,
        expand: true,
        onPressed: enabled ? onBlock : null,
      ),
      TrinoButton(
        label: l10n.requestReport,
        icon: TrinoIcons.flag,
        variant: ButtonVariant.danger,
        compact: true,
        expand: true,
        onPressed: enabled ? onReport : null,
      ),
    ];
    final large = MediaQuery.textScalerOf(context).scale(16) > 20;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: context.tokens.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TrinoButton(
              label: l10n.requestAccept,
              variant: ButtonVariant.primary,
              expand: true,
              loading: busy,
              onPressed: onAccept,
            ),
            const SizedBox(height: 8),
            if (large)
              for (final (index, button) in secondary.indexed)
                Padding(
                  padding: EdgeInsets.only(top: index == 0 ? 0 : 8),
                  child: button,
                )
            else
              Row(
                children: [
                  for (final (index, button) in secondary.indexed) ...[
                    if (index > 0) const SizedBox(width: 8),
                    Expanded(child: button),
                  ],
                ],
              ),
          ],
        ),
      ),
    );
  }
}
