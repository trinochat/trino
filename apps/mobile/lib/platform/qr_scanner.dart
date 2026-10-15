// Reading a QR code with the camera, behind a small interface: the app adds
// no camera package yet, so the demo stands in until the platform code
// arrives (task M6). The scanner only hands over the text of each code it
// reads; what that text means is the engine's business.
import 'dart:async';

import 'package:flutter/widgets.dart';

import '../engine/fake_engine.dart';

abstract interface class QrScanner {
  /// Opens the camera: the text of each code it reads, until the listener
  /// cancels.
  Stream<String> scan();

  /// The camera's picture, for behind the viewfinder; null without one.
  Widget? preview(BuildContext context);
}

/// Stands in for the camera: it shows nothing and reads a code only when told
/// to, so the screen can offer a clearly labelled "simulate" action.
class DemoQrScanner implements QrScanner {
  DemoQrScanner({this.payload = FakeTrinoEngine.demoLinkPayload});

  /// What [simulate] reads when given nothing: the demo computer's QR.
  final String payload;
  final _scans = StreamController<String>.broadcast();

  @override
  Stream<String> scan() => _scans.stream;

  @override
  Widget? preview(BuildContext context) => null;

  /// As if the camera had read [code], or the demo computer's QR.
  void simulate([String? code]) => _scans.add(code ?? payload);
}
