// The SAS v2 table: a byte-for-byte copy of the desktop's
// assets/sas/sas-v2.json, so the phone draws and names the same 64 symbols
// as the computer for the same call.
import 'dart:io';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/sas/sas_table.dart';

/// The bounds of what a path draws, by sampling it: [Path.getBounds] also
/// counts the control points of curves, which may fall outside.
Rect drawnBounds(Path path) {
  var bounds = Rect.zero;
  var first = true;
  for (final metric in path.computeMetrics()) {
    for (var distance = 0.0; distance <= metric.length; distance += 0.05) {
      final point = metric.getTangentForOffset(distance)!.position;
      final dot = Rect.fromCircle(center: point, radius: 0);
      bounds = first ? dot : bounds.expandToInclude(dot);
      first = false;
    }
  }
  return bounds;
}

SasTable readTable() => SasTable.parse(File('assets/sas/sas-v2.json').readAsStringSync());

void main() {
  test('is the copy of feat/rediseno @ 7b3d454: version 2, lucide-react 0.468.0, 26 516 bytes', () {
    expect(kSasSourceCommit, startsWith('7b3d454'));
    expect(File(kSasAsset).lengthSync(), 26516, reason: 'copied byte for byte, never reformatted');
    final table = readTable();
    expect(table.version, 2);
    expect(table.source, 'lucide-react@0.468.0');
    expect(table.strokeWidth, 2);
  });

  test('has 64 symbols in index order, each with a drawing and a word in es, en and pt', () {
    final table = readTable();
    expect(table.symbols, hasLength(64));
    for (final (i, symbol) in table.symbols.indexed) {
      expect(symbol.index, i);
      expect(symbol.nodes, isNotEmpty, reason: symbol.lucide);
      for (final language in ['es', 'en', 'pt']) {
        expect(symbol.words[language], isNotNull, reason: '${symbol.lucide} $language');
        expect(symbol.words[language]!.trim(), isNotEmpty, reason: '${symbol.lucide} $language');
      }
    }
    // Spot checks against the desktop's table and the mock.
    expect(table.symbols.first.lucide, 'Cat');
    expect(
      [
        for (final i in [0, 9, 17, 23, 31, 40, 52]) table.symbols[i].words['es'],
      ],
      ['Gato', 'Pluma', 'Sol', 'Rayo', 'Café', 'Avión', 'Castillo'],
    );
    expect(table.symbols[1].words, {'es': 'Perro', 'en': 'Dog', 'pt': 'Cachorro'});
  });

  test('gives the words in the language asked, English for any other, and refuses a wrong index', () {
    final table = readTable();
    expect(table.words([0, 1], 'pt'), ['Gato', 'Cachorro']);
    expect(table.words([0, 1], 'en'), ['Cat', 'Dog']);
    expect(table.words([0, 1], 'fr'), ['Cat', 'Dog']);
    expect(() => table.symbol(64), throwsRangeError);
    expect(() => table.symbol(-1), throwsRangeError);
  });

  test('refuses a table of another version or size', () {
    expect(() => SasTable.parse('{"version": 1, "symbols": []}'), throwsFormatException);
    expect(
      () => SasTable.parse('{"version": 2, "source": "x", "strokeWidth": 2, "symbols": []}'),
      throwsFormatException,
    );
  });

  group('drawing', () {
    test('every symbol draws inside the 24 × 24 box, with nothing the app cannot draw', () {
      for (final symbol in readTable().symbols) {
        final drawing = symbol.drawing;
        final bounds = drawnBounds(drawing.stroke);
        expect(bounds.width + bounds.height, greaterThan(4), reason: symbol.lucide);
        expect(bounds.left, greaterThanOrEqualTo(0), reason: symbol.lucide);
        expect(bounds.top, greaterThanOrEqualTo(0), reason: symbol.lucide);
        expect(bounds.right, lessThanOrEqualTo(24), reason: symbol.lucide);
        expect(bounds.bottom, lessThanOrEqualTo(24), reason: symbol.lucide);
      }
    });

    test('draws circles, ellipses, rounded rectangles, lines and polylines', () {
      Rect boundsOf(String tag, Map<String, String> attrs) => SasNode(tag, attrs).path().getBounds();
      expect(boundsOf('circle', {'cx': '12', 'cy': '12', 'r': '3'}), const Rect.fromLTRB(9, 9, 15, 15));
      expect(boundsOf('ellipse', {'cx': '12', 'cy': '9', 'rx': '10', 'ry': '5'}), const Rect.fromLTRB(2, 4, 22, 14));
      expect(
        boundsOf('rect', {'x': '3', 'y': '8', 'width': '18', 'height': '4', 'rx': '1'}),
        const Rect.fromLTRB(3, 8, 21, 12),
      );
      expect(boundsOf('line', {'x1': '2', 'y1': '3', 'x2': '8', 'y2': '9'}), const Rect.fromLTRB(2, 3, 8, 9));
      expect(boundsOf('polyline', {'points': '12 10 12 12 13 13'}), const Rect.fromLTRB(12, 10, 13, 13));
      expect(() => const SasNode('text', {}).path(), throwsFormatException);
    });

    test('fills only the nodes that say fill="currentColor": the dot of the die', () {
      final table = readTable();
      final filled = [
        for (final symbol in table.symbols)
          if (!symbol.drawing.fill.getBounds().isEmpty) symbol.lucide,
      ];
      expect(filled, hasLength(1));
    });
  });
}
