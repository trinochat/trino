// Trino iOS spike: one screen that starts Tor (Arti, through trino-net) in
// this app, opens a WebSocket to a relay over it, and shows what the Rust
// library measured as JSON. Throwaway: spikes/ios-tor/README.md.
//
// The Rust functions are reached through one method channel; the Swift side
// (ios/Runner/AppDelegate.swift) calls the C functions of spike_ios.h off the
// main thread and answers their JSON as it is.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

void main() => runApp(const SpikeApp());

/// The relay the probe opens: read-only, a REQ and its EOSE.
const relay = 'wss://nos.lol';

/// How long the full run waits for Tor before probing anyway.
const readyLimit = Duration(seconds: 180);

/// The Rust library, behind the channel. Every call answers a JSON object.
class SpikeChannel {
  SpikeChannel([MethodChannel? channel])
    : _channel = channel ?? const MethodChannel('org.trinochat.spike/tor');

  final MethodChannel _channel;

  Future<Map<String, dynamic>> _call(
    String method, [
    Map<String, Object?>? args,
  ]) async {
    try {
      final text = await _channel.invokeMethod<String>(method, args);
      return jsonDecode(text ?? '{}') as Map<String, dynamic>;
    } on PlatformException catch (e) {
      return {'ok': false, 'channel': e.code, 'error': e.message};
    } on MissingPluginException {
      return {'ok': false, 'error': 'no native side (not on the iPhone)'};
    }
  }

  Future<Map<String, dynamic>> start({
    required bool fresh,
    bool trustDirs = false,
  }) => _call('start', {'fresh': fresh, 'trustDirs': trustDirs});
  Future<Map<String, dynamic>> status() => _call('status');
  Future<Map<String, dynamic>> probe({int limitSecs = 90}) =>
      _call('probe', {'url': relay, 'limitSecs': limitSecs});
  Future<Map<String, dynamic>> stop() => _call('stop');
  Future<Map<String, dynamic>> note(String text) =>
      _call('note', {'text': text});
  Future<Map<String, dynamic>> report() => _call('report');
}

class SpikeApp extends StatelessWidget {
  const SpikeApp({super.key, this.channel});

  final SpikeChannel? channel;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Trino Tor (spike)',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.teal),
      home: SpikeScreen(channel: channel ?? SpikeChannel()),
    );
  }
}

class SpikeScreen extends StatefulWidget {
  const SpikeScreen({super.key, required this.channel});

  final SpikeChannel channel;

  @override
  State<SpikeScreen> createState() => _SpikeScreenState();
}

class _SpikeScreenState extends State<SpikeScreen> {
  late final AppLifecycleListener _lifecycle;
  bool _busy = false;
  String _line = 'Sin arrancar';
  String _json = '';
  DateTime? _hiddenAt;

  SpikeChannel get _rust => widget.channel;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onHide: _onHide, onShow: _onShow);
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  void _show(String line, Map<String, dynamic> json) {
    if (!mounted) return;
    setState(() {
      _line = line;
      _json = const JsonEncoder.withIndent('  ').convert(json);
    });
  }

  /// Runs [task] unless another one runs, with the buttons off meanwhile.
  Future<void> _run(Future<void> Function() task) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await task();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Polls the state every second until Tor is ready, gives up, or
  /// [readyLimit] passes. Answers the last state.
  Future<Map<String, dynamic>> _waitReady() async {
    final until = DateTime.now().add(readyLimit);
    var last = <String, dynamic>{};
    while (DateTime.now().isBefore(until)) {
      last = await _rust.status();
      final status = last['status'] as Map<String, dynamic>?;
      final state = status?['state'];
      final pct = status?['pct'];
      final elapsed = (last['current'] as Map<String, dynamic>?)?['elapsedMs'];
      _show(
        'Tor: $state${pct == null ? '' : ' $pct %'} · ${elapsed ?? '?'} ms',
        last,
      );
      if (state == 'ready' ||
          state == null ||
          state == 'off' ||
          state == 'ptMissing' ||
          state == 'obsolete') {
        return last;
      }
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    return last;
  }

  /// The whole measurement: start (cold or warm), wait for ready, one
  /// probe, then the report.
  Future<void> _fullRun({required bool fresh, bool trustDirs = false}) =>
      _run(() async {
        final kind = fresh ? 'en frío' : 'en caliente';
        _show('Arrancando Tor $kind…', {});
        final started = await _rust.start(fresh: fresh, trustDirs: trustDirs);
        if (started['ok'] != true) {
          _show('No arrancó', started);
          return;
        }
        await _waitReady();
        _show('Probando el WebSocket a $relay…', {});
        final probe = await _rust.probe();
        final ok = (probe['result'] as Map<String, dynamic>?)?['ok'] == true;
        final report = await _rust.report();
        _show(
          ok ? 'Listo: EOSE recibido ($kind)' : 'El WebSocket falló ($kind)',
          report,
        );
      });

  Future<void> _probe() => _run(() async {
    _show('Probando el WebSocket a $relay…', {});
    final probe = await _rust.probe();
    final ok = (probe['result'] as Map<String, dynamic>?)?['ok'] == true;
    _show(ok ? 'EOSE recibido' : 'El WebSocket falló', probe);
  });

  Future<void> _status() =>
      _run(() async => _show('Estado', await _rust.status()));

  Future<void> _stop() =>
      _run(() async => _show('Tor detenido', await _rust.stop()));

  Future<void> _report() =>
      _run(() async => _show('Informe', await _rust.report()));

  Future<void> _copy() async {
    final report = await _rust.report();
    final text = const JsonEncoder.withIndent('  ').convert(report);
    await Clipboard.setData(ClipboardData(text: text));
    _show('Informe copiado', report);
  }

  // Going to the background and coming back: noted in Rust with the time
  // and the memory, and on return a probe says whether Tor survived.
  void _onHide() {
    _hiddenAt = DateTime.now();
    unawaited(_rust.note('background'));
  }

  Future<void> _onShow() async {
    final away = _hiddenAt == null
        ? null
        : DateTime.now().difference(_hiddenAt!);
    await _rust.note('foreground after ${away?.inSeconds ?? '?'} s');
    final status = await _rust.status();
    if (status['running'] != true) {
      _show(
        'De vuelta (${away?.inSeconds ?? '?'} s fuera): Tor no estaba arrancado',
        status,
      );
      return;
    }
    await _run(() async {
      _show('De vuelta (${away?.inSeconds ?? '?'} s fuera): probando…', status);
      final probe = await _rust.probe(limitSecs: 60);
      final ok = (probe['result'] as Map<String, dynamic>?)?['ok'] == true;
      _show(
        ok
            ? 'Sobrevivió: EOSE tras ${away?.inSeconds ?? '?'} s fuera'
            : 'Tras ${away?.inSeconds ?? '?'} s fuera, el WebSocket falló',
        probe,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final buttons = <(String, VoidCallback)>[
      ('Prueba completa en frío', () => _fullRun(fresh: true)),
      ('Prueba completa en caliente', () => _fullRun(fresh: false)),
      ('Probar WebSocket', _probe),
      ('Estado', _status),
      ('Detener Tor', _stop),
      ('Informe', _report),
      ('Copiar informe', _copy),
      (
        'En frío sin revisar permisos',
        () => _fullRun(fresh: true, trustDirs: true),
      ),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('Trino · Tor en iPhone (spike)')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final (label, action) in buttons)
                    FilledButton.tonal(
                      onPressed: _busy ? null : action,
                      child: Text(label),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                _line,
                key: const Key('line'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Expanded(
                child: SingleChildScrollView(
                  child: SelectableText(
                    _json,
                    key: const Key('json'),
                    style: const TextStyle(fontFamily: 'Menlo', fontSize: 12),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
