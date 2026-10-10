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
enum LockReason { coldStart, manual, idle }

enum ConnectionStatus { connecting, connected }

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
  });

  final String id;
  final String chatId;
  final bool outgoing;
  final String text;
  final DateTime sentAt;

  /// The author of an incoming group message.
  final String? sender;
  final MessageStatus status;

  ChatMessage copyWith({MessageStatus? status}) => ChatMessage(
    id: id,
    chatId: chatId,
    outgoing: outgoing,
    text: text,
    sentAt: sentAt,
    sender: sender,
    status: status ?? this.status,
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

/// How the call's media travels. Direct means the other person sees your IP.
enum CallPath { direct }

@immutable
class CallSession {
  const CallSession({
    required this.id,
    required this.contactId,
    required this.peerName,
    required this.sas,
    this.elapsed = Duration.zero,
    this.path = CallPath.direct,
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

/// What the unlock screen shows before you type anything.
@immutable
class UnlockInfo {
  const UnlockInfo({required this.name, required this.totpEnabled, required this.reason, this.idleMinutes});

  final String name;
  final bool totpEnabled;
  final LockReason reason;

  /// With [LockReason.idle]: after how long.
  final int? idleMinutes;
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
    this.hideIpWithTor = true,
    this.warnBeforeDirectCall = true,
    this.autoLockMinutes = 5,
    this.diagnosticLog = false,
  });

  final NotificationPreview notificationPreview;
  final bool messageSound;
  final bool muteGroups;
  final bool hideIpWithTor;

  /// Ask before a call that shows your IP to the other person.
  final bool warnBeforeDirectCall;

  /// Null: never.
  final int? autoLockMinutes;
  final bool diagnosticLog;

  EngineSettings copyWith({
    NotificationPreview? notificationPreview,
    bool? messageSound,
    bool? muteGroups,
    bool? hideIpWithTor,
    bool? warnBeforeDirectCall,
    int? Function()? autoLockMinutes,
    bool? diagnosticLog,
  }) => EngineSettings(
    notificationPreview: notificationPreview ?? this.notificationPreview,
    messageSound: messageSound ?? this.messageSound,
    muteGroups: muteGroups ?? this.muteGroups,
    hideIpWithTor: hideIpWithTor ?? this.hideIpWithTor,
    warnBeforeDirectCall: warnBeforeDirectCall ?? this.warnBeforeDirectCall,
    autoLockMinutes: autoLockMinutes == null ? this.autoLockMinutes : autoLockMinutes(),
    diagnosticLog: diagnosticLog ?? this.diagnosticLog,
  );
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
  Future<void> lock();

  /// Deletes the identity, the chats and the contacts from this phone.
  Future<void> wipe();

  // Network, profile and settings.
  Stream<ConnectionStatus> get connection;
  Stream<List<RelayStatus>> get relays;
  Stream<Profile> get profile;
  Future<void> setName(String name);
  Stream<EngineSettings> get settings;
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
  Future<void> startCall(String contactId);
  Future<void> setMuted(bool muted);
  Future<void> setSpeaker(bool on);
  Future<void> setCamera(bool on);

  /// The user compared the symbols with the other person.
  Future<void> confirmSas({required bool matches});
  Future<void> hangUp();

  Future<void> dispose();
}
