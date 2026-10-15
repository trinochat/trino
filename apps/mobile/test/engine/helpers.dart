// What the engine tests share: a fixed time and a way to watch a stream.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

/// 11:00 on a Friday, so the demo's "10:42" is today and "Ayer" is Thursday.
final now = DateTime(2026, 10, 9, 11);

/// Every value a stream emits, until the test ends.
List<T> record<T>(Stream<T> stream) {
  final values = <T>[];
  final subscription = stream.listen(values.add);
  addTearDown(subscription.cancel);
  return values;
}
