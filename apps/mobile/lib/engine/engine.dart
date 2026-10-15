// What the screens need from Trino's engine, as plain data and async calls.
//
// The shape is the one flutter_rust_bridge v2 generates for the shared Rust
// engine (crates/trino-engine): immutable data classes and enums, Futures for
// calls and Streams for state that changes. FakeTrinoEngine implements it in
// memory for now; the real engine replaces it without touching the screens.
import 'package:flutter/foundation.dart';

/// Whether there is an identity on this phone, and whether it is open.
enum IdentityState {
  /// No identity yet: the first run.
  needsOnboarding,
  locked,
  unlocked,
}

/// Why the app is locked, for the unlock screen.
enum LockReason {
  /// The app or the phone restarted: the passphrase is always asked.
  coldStart,
  manual,
  idle,

  /// With biometric unlock on: the reask interval passed since the last time
  /// the passphrase was typed, so it is asked again.
  reask,
}

/// Where the connection to the network stands, said in words on screen.
/// Trino always connects through Tor unless the user asks otherwise.
enum NetworkStatus {
  /// Opening the private connection, with [NetworkState.progress].
  connecting,

  /// Connected privately, through Tor.
  connected,

  /// The private connection did not open; [NetworkState.problem] says why
  /// when the engine knows.
  failed,

  /// There is no internet: waiting for it to come back.
  offline,

  /// Connected without Tor because the user asked, only until the app closes.
  /// Never remembered: the next start is private again.
  unprotected,
}

/// Why the private connection failed.
enum NetworkProblem {
  /// The network does not allow Tor.
  blocked,

  /// The phone's time is wrong, and Tor cannot connect with it.
  clock,
}

/// How Trino reaches Tor when the network blocks it.
enum BridgeMode {
  /// Asks the Tor Project what works in this country. The default.
  automatic,

  /// The bridges Trino brings: they work if Tor is blocked, but do not hide
  /// that you use it.
  snowflake,
  obfs4,

  /// A bridge code someone gave you.
  custom,
}

/// How often the passphrase (and the 2FA code) is asked even with biometric
/// unlock. There is no "never": a forgotten passphrase cannot be recovered.
enum ReaskInterval { day, threeDays, week }

/// Whether the user compared keys with a contact.
enum Trust { verified, unverified, keyChanged }

enum ChatKind { direct, group }

/// Delivery of your own message. The protocol reports no "read" state.
enum MessageStatus { sending, sent, failed }

/// What notifications show; "only the name" is the recommended default.
enum NotificationPreview { nameAndMessage, nameOnly, nothing }

enum PassphraseProblem { tooShort, tooCommon }

enum PassphraseStrength { weak, fair, good, strong }

enum UnlockResult { ok, wrongPassphrase, wrongPassphraseOrCode, codeRequired }

@immutable
class Profile {
  const Profile({required this.name, required this.contactCode, required this.fingerprint});

  final String name;

  /// The compact contact code (`trino2:`), safe to share.
  final String contactCode;

  /// The key contacts compare to verify you, in groups of four.
  final String fingerprint;

  Profile copyWith({String? name}) =>
      Profile(name: name ?? this.name, contactCode: contactCode, fingerprint: fingerprint);
}

@immutable
class Contact {
  const Contact({required this.id, required this.name, required this.trust, required this.fingerprint});

  final String id;
  final String name;
  final Trust trust;
  final String fingerprint;
}

@immutable
class ChatSummary {
  const ChatSummary({
    required this.id,
    required this.kind,
    required this.title,
    this.contactId,
    this.trust = Trust.unverified,
    this.memberNames = const [],
    this.lastMessage,
    this.lastSender,
    this.lastIsMine = false,
    this.lastActivity,
    this.unread = 0,
    this.draft,
  });

  final String id;
  final ChatKind kind;
  final String title;

  /// The other person of a direct chat.
  final String? contactId;
  final Trust trust;

  /// The other members of a group.
  final List<String> memberNames;
  final String? lastMessage;

  /// Who wrote the last message of a group, unless it was you.
  final String? lastSender;
  final bool lastIsMine;
  final DateTime? lastActivity;
  final int unread;

  /// What you left written in the composer.
  final String? draft;

  bool get isGroup => kind == ChatKind.group;
}

@immutable
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.chatId,
    required this.outgoing,
    required this.text,
    required this.sentAt,
    this.sender,
    this.status = MessageStatus.sent,
    this.call,
  });

  final String id;
  final String chatId;
  final bool outgoing;
  final String text;
  final DateTime sentAt;

  /// The author of an incoming group message.
  final String? sender;
  final MessageStatus status;

  /// A call shown inside the chat, at the time it started: the text is empty
  /// and the record says what happened.
  final CallRecord? call;

  bool get isCall => call != null;

  ChatMessage copyWith({MessageStatus? status}) => ChatMessage(
    id: id,
    chatId: chatId,
    outgoing: outgoing,
    text: text,
    sentAt: sentAt,
    sender: sender,
    status: status ?? this.status,
    call: call,
  );
}

/// One symbol of a call's short authentication string: the emoji and the id
/// of its word, which the app translates.
@immutable
class SasSymbol {
  const SasSymbol(this.id, this.emoji);

  final String id;
  final String emoji;
}

/// How the call's media travels. Through the call server (a relay that
/// passes the audio, "Por el servidor de llamadas") the other person does not
/// see your IP; direct, they do. Trino calls through the server.
enum CallPath { direct, relay }

enum CallDirection { incoming, outgoing, missed }

/// A call in the history, and inside the chat with that contact.
@immutable
class CallRecord {
  const CallRecord({
    required this.id,
    required this.contactId,
    required this.peerName,
    required this.direction,
    required this.startedAt,
    this.duration = Duration.zero,
  });

  final String id;
  final String contactId;
  final String peerName;
  final CallDirection direction;
  final DateTime startedAt;

  /// Zero for a missed call.
  final Duration duration;
}

@immutable
class CallSession {
  const CallSession({
    required this.id,
    required this.contactId,
    required this.peerName,
    required this.sas,
    this.elapsed = Duration.zero,
    this.path = CallPath.relay,
    this.verified = false,
    this.mismatch = false,
    this.muted = false,
    this.speaker = false,
    this.camera = false,
  });

  final String id;
  final String contactId;
  final String peerName;

  /// Seven symbols, the same on both phones unless someone is in the middle.
  final List<SasSymbol> sas;
  final Duration elapsed;
  final CallPath path;

  /// You both said the symbols match.
  final bool verified;

  /// You said they do not match.
  final bool mismatch;
  final bool muted;
  final bool speaker;
  final bool camera;

  CallSession copyWith({Duration? elapsed, bool? verified, bool? mismatch, bool? muted, bool? speaker, bool? camera}) =>
      CallSession(
        id: id,
        contactId: contactId,
        peerName: peerName,
        sas: sas,
        path: path,
        elapsed: elapsed ?? this.elapsed,
        verified: verified ?? this.verified,
        mismatch: mismatch ?? this.mismatch,
        muted: muted ?? this.muted,
        speaker: speaker ?? this.speaker,
        camera: camera ?? this.camera,
      );
}

/// What the unlock screen shows before you type anything. It carries no name:
/// nothing personal shows before unlocking ("Hola de nuevo" for everyone).
@immutable
class UnlockInfo {
  const UnlockInfo({required this.totpEnabled, required this.reason, this.idleMinutes, this.biometricAllowed = false});

  final bool totpEnabled;
  final LockReason reason;

  /// With [LockReason.idle]: after how long.
  final int? idleMinutes;

  /// The fingerprint or the face can open Trino now: biometric unlock is on,
  /// reinforced protection is off, this is not a cold start and the reask
  /// interval has not passed since the passphrase was last typed.
  final bool biometricAllowed;
}

@immutable
class PassphraseCheck {
  const PassphraseCheck({required this.strength, required this.minLength, this.problem});

  final PassphraseStrength strength;
  final int minLength;

  /// Null when the passphrase can be used.
  final PassphraseProblem? problem;
}

/// The secret to add to an authenticator app.
@immutable
class TotpSetup {
  const TotpSetup({required this.secret, required this.uri});

  /// Base32, in groups of four for typing.
  final String secret;
  final String uri;
}

@immutable
class NetworkState {
  const NetworkState({required this.status, this.progress = 0, this.problem, this.tryingAnotherWay = false});

  const NetworkState.connecting([int progress = 0]) : this(status: NetworkStatus.connecting, progress: progress);
  const NetworkState.connected() : this(status: NetworkStatus.connected);
  const NetworkState.failed([NetworkProblem? problem]) : this(status: NetworkStatus.failed, problem: problem);
  const NetworkState.offline() : this(status: NetworkStatus.offline);
  const NetworkState.unprotected() : this(status: NetworkStatus.unprotected);

  final NetworkStatus status;

  /// From 0 to 100 while [NetworkStatus.connecting].
  final int progress;

  /// With [NetworkStatus.failed]: why, if known.
  final NetworkProblem? problem;

  /// The automatic search for a bridge is running ("Probando otra forma de
  /// conectarse").
  final bool tryingAnotherWay;

  NetworkState copyWith({bool? tryingAnotherWay}) => NetworkState(
    status: status,
    progress: progress,
    problem: problem,
    tryingAnotherWay: tryingAnotherWay ?? this.tryingAnotherWay,
  );

  @override
  bool operator ==(Object other) =>
      other is NetworkState &&
      other.status == status &&
      other.progress == progress &&
      other.problem == problem &&
      other.tryingAnotherWay == tryingAnotherWay;

  @override
  int get hashCode => Object.hash(status, progress, problem, tryingAnotherWay);

  @override
  String toString() => 'NetworkState($status, $progress%, $problem, tryingAnotherWay: $tryingAnotherWay)';
}

@immutable
class BridgeSettings {
  const BridgeSettings({this.mode = BridgeMode.automatic, this.hasCustomBridge = false});

  final BridgeMode mode;

  /// A bridge code is stored, protected with the passphrase. The app never
  /// reads it back.
  final bool hasCustomBridge;
}

@immutable
class RelayStatus {
  const RelayStatus({required this.url, required this.connected});

  final String url;
  final bool connected;
}

@immutable
class EngineSettings {
  const EngineSettings({
    this.notificationPreview = NotificationPreview.nameOnly,
    this.messageSound = true,
    this.muteGroups = false,
    this.autoLockMinutes = 5,
    this.diagnosticLog = false,
    this.keepConnectedInBackground = true,
    this.connectAfterUnlockOnly = false,
    this.biometricUnlock = false,
    this.reaskInterval = ReaskInterval.threeDays,
    this.reinforcedProtection = false,
  });

  final NotificationPreview notificationPreview;
  final bool messageSound;
  final bool muteGroups;

  /// Locks after this long without use. Null: never. Separate from
  /// [reaskInterval].
  final int? autoLockMinutes;
  final bool diagnosticLog;

  /// Stays connected with the app closed, so messages arrive (Android shows
  /// a fixed notification, and it costs battery and data). On by default.
  final bool keepConnectedInBackground;

  /// Does not connect while locked. Always on with a custom bridge.
  final bool connectAfterUnlockOnly;

  /// Unlocks with the fingerprint or the face between passphrase asks.
  /// Always off with [reinforcedProtection].
  final bool biometricUnlock;
  final ReaskInterval reaskInterval;

  /// Always asks for the passphrase: biometric unlock is not offered.
  final bool reinforcedProtection;

  EngineSettings copyWith({
    NotificationPreview? notificationPreview,
    bool? messageSound,
    bool? muteGroups,
    int? Function()? autoLockMinutes,
    bool? diagnosticLog,
    bool? keepConnectedInBackground,
    bool? connectAfterUnlockOnly,
    bool? biometricUnlock,
    ReaskInterval? reaskInterval,
    bool? reinforcedProtection,
  }) => EngineSettings(
    notificationPreview: notificationPreview ?? this.notificationPreview,
    messageSound: messageSound ?? this.messageSound,
    muteGroups: muteGroups ?? this.muteGroups,
    autoLockMinutes: autoLockMinutes == null ? this.autoLockMinutes : autoLockMinutes(),
    diagnosticLog: diagnosticLog ?? this.diagnosticLog,
    keepConnectedInBackground: keepConnectedInBackground ?? this.keepConnectedInBackground,
    connectAfterUnlockOnly: connectAfterUnlockOnly ?? this.connectAfterUnlockOnly,
    biometricUnlock: biometricUnlock ?? this.biometricUnlock,
    reaskInterval: reaskInterval ?? this.reaskInterval,
    reinforcedProtection: reinforcedProtection ?? this.reinforcedProtection,
  );
}

/// A bridge code that is not one.
class InvalidBridgeCode implements Exception {
  const InvalidBridgeCode();

  @override
  String toString() => 'InvalidBridgeCode';
}

/// A contact code that is not one.
class InvalidContactCode implements Exception {
  const InvalidContactCode();

  @override
  String toString() => 'InvalidContactCode';
}

abstract interface class TrinoEngine {
  // Identity and lock.

  /// The current state first, then each change.
  Stream<IdentityState> get identityState;
  Future<UnlockInfo> unlockInfo();
  Future<PassphraseCheck> checkPassphrase(String passphrase);
  Future<TotpSetup> beginTotp();
  Future<bool> verifyTotp(String code);

  /// Creates the identity and opens the session (the first run does not go
  /// through the unlock screen). With [withTotp], [beginTotp] and a passing
  /// [verifyTotp] must come first.
  Future<void> createIdentity({required String name, required String passphrase, required bool withTotp});
  Future<UnlockResult> unlock(String passphrase, {String? code});

  /// After the phone confirmed the fingerprint or the face. Opens only when
  /// [UnlockInfo.biometricAllowed]; says whether it opened.
  Future<bool> unlockWithBiometrics();
  Future<void> lock();

  /// Deletes the identity, the chats and the contacts from this phone.
  Future<void> wipe();

  // Network.

  /// The current state first, then each change.
  Stream<NetworkState> get network;

  /// Tries the private connection again.
  Future<void> retryConnection();

  /// Starts the automatic bridge search ([BridgeMode.automatic]) and connects
  /// through what it finds.
  Future<void> tryAnotherWay();

  /// Connects without Tor until the app closes. Never remembered.
  Future<void> connectUnprotected();

  /// Leaves [NetworkStatus.unprotected] and connects through Tor again.
  Future<void> reconnectPrivately();
  Stream<BridgeSettings> get bridges;

  /// [BridgeMode.custom] needs a code from [setCustomBridge] first.
  Future<void> setBridgeMode(BridgeMode mode);

  /// Stores the code, switches to [BridgeMode.custom] and turns on
  /// [EngineSettings.connectAfterUnlockOnly]. Throws [InvalidBridgeCode].
  Future<void> setCustomBridge(String code);

  /// Forgets the code; with [BridgeMode.custom], back to automatic.
  Future<void> removeCustomBridge();

  // Profile and settings.
  Stream<List<RelayStatus>> get relays;
  Stream<Profile> get profile;
  Future<void> setName(String name);
  Stream<EngineSettings> get settings;

  /// The engine keeps the rules: a custom bridge forces
  /// [EngineSettings.connectAfterUnlockOnly] on, and reinforced protection
  /// forces [EngineSettings.biometricUnlock] off.
  Future<void> updateSettings(EngineSettings settings);

  // Contacts and chats.
  Stream<List<Contact>> get contacts;

  /// Throws [InvalidContactCode].
  Future<Contact> addContact(String code);

  /// The direct chat with a contact, created if needed.
  Future<String> openChat(String contactId);

  /// By activity, the latest first.
  Stream<List<ChatSummary>> get chats;

  /// Oldest first.
  Stream<List<ChatMessage>> messages(String chatId);
  Future<void> send(String chatId, String text);
  Future<void> retry(String chatId, String messageId);
  Future<void> saveDraft(String chatId, String draft);
  Future<void> markRead(String chatId);

  // Calls.

  /// The call in progress, or null.
  Stream<CallSession?> get call;

  /// Every call, the latest first. Hanging up adds one.
  Stream<List<CallRecord>> get callHistory;
  Future<void> startCall(String contactId);
  Future<void> setMuted(bool muted);
  Future<void> setSpeaker(bool on);
  Future<void> setCamera(bool on);

  /// The user compared the symbols with the other person.
  Future<void> confirmSas({required bool matches});
  Future<void> hangUp();

  Future<void> dispose();
}
