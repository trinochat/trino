import 'package:flutter/widgets.dart';

import 'app/app.dart';
import 'engine/fake_engine.dart';

/// Trino on the in-memory demo engine until the Rust engine is wired in
/// (task M6): it starts at the first run, connects after a moment, and shows
/// messages as sending for a short while, as the real network would.
void main() {
  runApp(
    TrinoApp(
      engine: FakeTrinoEngine(
        onboarded: false,
        connectAfter: const Duration(seconds: 2),
        sendDelay: const Duration(milliseconds: 600),
      ),
    ),
  );
}
