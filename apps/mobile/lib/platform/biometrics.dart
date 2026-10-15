// The phone's fingerprint or face check, behind a small interface: the app
// adds no package for it yet, so the demo stands in until the platform code
// arrives (task M6). Trino never sees the fingerprint or the face; the phone
// only answers whether it was you.
abstract interface class BiometricAuth {
  /// The phone has a fingerprint or a face set up that apps can ask for.
  Future<bool> isAvailable();

  /// Asks the phone to check, showing [reason]; says whether it confirmed.
  Future<bool> authenticate(String reason);
}

/// Stands in for the phone: there unless told otherwise, and always confirms.
class DemoBiometricAuth implements BiometricAuth {
  const DemoBiometricAuth({this.available = true});

  final bool available;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<bool> authenticate(String reason) async => available;
}
