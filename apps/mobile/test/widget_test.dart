import 'package:flutter_test/flutter_test.dart';

import 'package:trino_mobile/main.dart';

void main() {
  testWidgets('shows the mobile conversations workspace', (tester) async {
    await tester.pumpWidget(const TrinoMobileApp());

    expect(find.text('Trino'), findsOneWidget);
    expect(find.text('Mara'), findsOneWidget);
  });
}
