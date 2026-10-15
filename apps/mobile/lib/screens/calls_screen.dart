// The Llamadas tab: a large title, Todas or only the Perdidas, and every call
// with its direction in words and a button that calls the person back.
import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/call_row.dart';
import '../ui/segmented.dart';
import 'call_screen.dart';
import 'common.dart';

enum CallsFilter { all, missed }

class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});

  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<CallRecord>> _history = _engine.callHistory;
  var _filter = CallsFilter.all;

  Future<void> _callBack(CallRecord call) async {
    final navigator = Navigator.of(context);
    await _engine.startCall(call.contactId);
    await navigator.push(CallScreen.route());
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SafeArea(
      bottom: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LargeTitleBar(title: l10n.callsTitle),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: IntrinsicWidth(
                child: TrinoSegmented<CallsFilter>(
                  semanticLabel: l10n.callsShow,
                  options: [
                    (value: CallsFilter.all, label: l10n.callsAll),
                    (value: CallsFilter.missed, label: l10n.callsMissed),
                  ],
                  selected: _filter,
                  onChanged: (filter) => setState(() => _filter = filter),
                ),
              ),
            ),
          ),
          Expanded(
            child: StreamBuilder<List<CallRecord>>(
              stream: _history,
              builder: (context, snapshot) {
                final all = snapshot.data;
                if (all == null) return const SizedBox.shrink();
                final calls = [
                  for (final call in all)
                    if (_filter == CallsFilter.all || call.direction == CallDirection.missed) call,
                ];
                if (calls.isEmpty) {
                  return Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      _filter == CallsFilter.all ? l10n.noCalls : l10n.noMissedCalls,
                      textAlign: TextAlign.center,
                      style: context.text.secondary,
                    ),
                  );
                }
                return ListView.builder(
                  itemCount: calls.length,
                  itemBuilder: (context, index) => _row(context, calls[index]),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, CallRecord call) {
    final l10n = context.l10n;
    final time = formatChatTime(context, call.startedAt, context.now());
    final (icon, word) = switch (call.direction) {
      CallDirection.incoming => (TrinoIcons.phoneIncoming, l10n.callIncoming),
      CallDirection.outgoing => (TrinoIcons.phoneOutgoing, l10n.callOutgoing),
      CallDirection.missed => (TrinoIcons.phoneMissed, l10n.callMissed),
    };
    final missed = call.direction == CallDirection.missed;
    return CallRow(
      key: ValueKey(call.id),
      name: call.peerName,
      icon: icon,
      missed: missed,
      detail: [word, if (!missed) formatCallLength(context, call.duration), time].join(' · '),
      callBackLabel: l10n.callBack(call.peerName),
      onCallBack: () => _callBack(call),
    );
  }
}
