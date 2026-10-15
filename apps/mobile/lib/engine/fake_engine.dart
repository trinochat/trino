// An in-memory TrinoEngine with demo data, for building and testing the
// screens before the Rust engine is wired in (task M6). Nothing leaves the
// phone and nothing is stored: every start is a fresh demo.
import 'dart:async';

import 'engine.dart';

class FakeTrinoEngine implements TrinoEngine {
  /// [onboarded] false starts at the first run; the demo contacts and chats
  /// appear once the identity is created. [locked] starts at the unlock
  /// screen, as after a restart. [connectAfter] starts connecting and connects
  /// after that long, as do retrying and the other network calls (without it
  /// they connect at once); [sendDelay] is how long a message shows as sending;
  /// [callStartsAt] is the time a new call shows.
  FakeTrinoEngine({
    DateTime Function()? clock,
    bool onboarded = true,
    bool locked = false,
    this.connectAfter,
    this.sendDelay = Duration.zero,
    this.callStartsAt = Duration.zero,
    this.linkConfirmAfter,
  }) : _clock = clock ?? DateTime.now,
       _identityState = _Live(
         onboarded ? (locked ? IdentityState.locked : IdentityState.unlocked) : IdentityState.needsOnboarding,
       ),
       _network = _Live(connectAfter == null ? const NetworkState.connected() : const NetworkState.connecting()) {
    if (onboarded) {
      _passphrase = demoPassphrase;
      // Started unlocked: as if the passphrase had just been typed.
      if (!locked) _lastPassphraseAt = _clock();
      _profile.value = _demoProfile(demoName);
      _seedDemo();
      _devices.value = _linkedDevices(_clock().subtract(const Duration(hours: 2)));
    }
    if (connectAfter != null) _connect();
    _call.onActive = _updateCallTimer;
  }

  /// The passphrase of the demo identity when it starts onboarded.
  static const demoPassphrase = 'caballo-correcto-bateria';

  /// The only code the fake authenticator accepts.
  static const demoTotpCode = '123456';
  static const demoName = 'Sofía';

  /// The QR payload the fake accepts: any with the prefix of [demoLinkPayload].
  static const demoLinkPayload = 'trino-link:v1:7Q2M9XKD4R';
  static const demoLinkCode = '418 207';
  static const demoComputerName = 'Computador de la casa';

  final Duration? connectAfter;
  final Duration sendDelay;
  final Duration callStartsAt;
  final Duration? linkConfirmAfter;
  final DateTime Function() _clock;

  final _Live<IdentityState> _identityState;
  final _Live<NetworkState> _network;
  final _profile = _Live<Profile?>(null);
  final _contacts = _Live<List<Contact>>(const []);
  final _chats = _Live<List<ChatSummary>>(const []);
  final _call = _Live<CallSession?>(null);
  final _callHistory = _Live<List<CallRecord>>(const []);
  final _requests = _Live<List<MessageRequest>>(const []);
  final _devices = _Live<List<LinkedDevice>>(const []);
  final _linking = _Live<LinkSession?>(null);
  final _dismissedUntil = <String, DateTime>{};
  final _blocked = <String>{};
  final _reported = <String>[];
  final _settings = _Live(const EngineSettings());
  final _bridges = _Live(const BridgeSettings());
  final _relays = _Live(const [
    RelayStatus(url: 'wss://relay.damus.io', connected: true),
    RelayStatus(url: 'wss://nos.lol', connected: true),
    RelayStatus(url: 'wss://relay.snort.social', connected: true),
  ]);
  final _messages = <String, _Live<List<ChatMessage>>>{};
  final _rooms = <String, _Room>{};
  final _timers = <Timer>{};
  final _networkTimers = <Timer>{};
  final _linkTimers = <Timer>{};
  Timer? _callTimer;
  DateTime? _callStartedAt;

  String? _passphrase;
  bool _totpEnabled = false;
  bool _totpVerified = false;
  LockReason _lockReason = LockReason.coldStart;

  /// When the passphrase was last typed, for the reask interval.
  DateTime? _lastPassphraseAt;
  var _nextId = 0;

  // Identity and lock.

  @override
  Stream<IdentityState> get identityState => _identityState.stream;

  @override
  Future<UnlockInfo> unlockInfo() async {
    final settings = _settings.value;
    final offered = settings.biometricUnlock && !settings.reinforcedProtection && _lockReason != LockReason.coldStart;
    final interval = switch (settings.reaskInterval) {
      ReaskInterval.day => const Duration(days: 1),
      ReaskInterval.threeDays => const Duration(days: 3),
      ReaskInterval.week => const Duration(days: 7),
    };
    final last = _lastPassphraseAt;
    final due = last == null || !_clock().isBefore(last.add(interval));
    return UnlockInfo(
      totpEnabled: _totpEnabled,
      reason: offered && due ? LockReason.reask : _lockReason,
      biometricAllowed: offered && !due,
    );
  }

  static const _minLength = 10;
  static const _common = {
    '1234567890',
    '0123456789',
    'qwertyuiop',
    'asdfghjklñ',
    'password123',
    'contraseña123',
    'contrasena123',
    'trinotrino',
    'iloveyou123',
    'teamo12345',
  };

  @override
  Future<PassphraseCheck> checkPassphrase(String passphrase) async {
    // Counted in Unicode scalars, as the desktop does.
    final length = passphrase.runes.length;
    final strength = switch (length) {
      >= 24 => PassphraseStrength.strong,
      >= 16 => PassphraseStrength.good,
      >= 12 => PassphraseStrength.fair,
      _ => PassphraseStrength.weak,
    };
    final PassphraseProblem? problem;
    if (length < _minLength) {
      problem = PassphraseProblem.tooShort;
    } else if (_common.contains(passphrase.toLowerCase()) || passphrase.runes.toSet().length == 1) {
      problem = PassphraseProblem.tooCommon;
    } else {
      problem = null;
    }
    return PassphraseCheck(
      strength: problem == null ? strength : PassphraseStrength.weak,
      minLength: _minLength,
      problem: problem,
    );
  }

  static const _totpSecret = 'JBSWY3DPEHPK3PXP';

  @override
  Future<TotpSetup> beginTotp() async {
    _totpVerified = false;
    final grouped = [for (var i = 0; i < _totpSecret.length; i += 4) _totpSecret.substring(i, i + 4)].join(' ');
    return TotpSetup(secret: grouped, uri: 'otpauth://totp/Trino?secret=$_totpSecret&issuer=Trino');
  }

  @override
  Future<bool> verifyTotp(String code) async {
    _totpVerified = code.replaceAll(' ', '') == demoTotpCode;
    return _totpVerified;
  }

  @override
  Future<void> createIdentity({required String name, required String passphrase, required bool withTotp}) async {
    if (_identityState.value != IdentityState.needsOnboarding) throw StateError('There is an identity already');
    if (withTotp && !_totpVerified) throw StateError('Verify the authenticator code first');
    _passphrase = passphrase;
    _totpEnabled = withTotp;
    _profile.value = _demoProfile(name.trim());
    _seedDemo();
    // Created here: this phone holds the account key.
    _devices.value = [
      LinkedDevice(
        id: 'device-this',
        name: _phoneName,
        platform: DevicePlatform.android,
        linkedAt: _clock(),
        isThisDevice: true,
        isPrimary: true,
      ),
    ];
    _lastPassphraseAt = _clock();
    _identityState.value = IdentityState.unlocked;
  }

  @override
  Future<UnlockResult> unlock(String passphrase, {String? code}) async {
    if (_identityState.value != IdentityState.locked) return UnlockResult.ok;
    // Asking for the code first tells nothing about the passphrase.
    if (_totpEnabled && (code == null || code.trim().isEmpty)) return UnlockResult.codeRequired;
    final codeOk = !_totpEnabled || code!.replaceAll(' ', '') == demoTotpCode;
    if (passphrase != _passphrase || !codeOk) {
      return _totpEnabled ? UnlockResult.wrongPassphraseOrCode : UnlockResult.wrongPassphrase;
    }
    _lastPassphraseAt = _clock();
    _identityState.value = IdentityState.unlocked;
    return UnlockResult.ok;
  }

  @override
  Future<bool> unlockWithBiometrics() async {
    if (_identityState.value != IdentityState.locked || !(await unlockInfo()).biometricAllowed) return false;
    _identityState.value = IdentityState.unlocked;
    return true;
  }

  @override
  Future<void> lock() async {
    if (_identityState.value != IdentityState.unlocked) return;
    await hangUp();
    _lockReason = LockReason.manual;
    _identityState.value = IdentityState.locked;
  }

  @override
  Future<void> wipe() async {
    await hangUp();
    _passphrase = null;
    _totpEnabled = _totpVerified = false;
    _lockReason = LockReason.coldStart;
    _lastPassphraseAt = null;
    _profile.value = null;
    _rooms.clear();
    _callHistory.value = const [];
    _requests.value = const [];
    _devices.value = const [];
    _cancelAll(_linkTimers);
    _linking.value = null;
    _dismissedUntil.clear();
    _blocked.clear();
    _reported.clear();
    for (final live in _messages.values) {
      live.value = const [];
    }
    _contacts.value = const [];
    _publishChats();
    _identityState.value = IdentityState.needsOnboarding;
  }

  // Network.

  @override
  Stream<NetworkState> get network => _network.stream;

  /// For tests and demos: the network comes and goes.
  void setNetwork(NetworkState state) {
    _cancelAll(_networkTimers);
    _network.value = state;
  }

  @override
  Future<void> retryConnection() async => _connect();

  @override
  Future<void> tryAnotherWay() async {
    _bridges.value = BridgeSettings(hasCustomBridge: _bridges.value.hasCustomBridge);
    _connect(tryingAnotherWay: true);
  }

  @override
  Future<void> connectUnprotected() async => setNetwork(const NetworkState.unprotected());

  @override
  Future<void> reconnectPrivately() async => _connect();

  @override
  Stream<BridgeSettings> get bridges => _bridges.stream;

  @override
  Future<void> setBridgeMode(BridgeMode mode) async {
    final hasCustom = _bridges.value.hasCustomBridge;
    if (mode == BridgeMode.custom && !hasCustom) throw StateError('Set a bridge code first');
    _bridges.value = BridgeSettings(mode: mode, hasCustomBridge: hasCustom);
  }

  /// One bridge per line: a transport and an address, or just an address.
  static final _bridgeLine = RegExp(
    r'^((obfs4|webtunnel|snowflake|meek_lite|conjure)\s+)?(\[[0-9a-fA-F:]+\]|\d{1,3}(\.\d{1,3}){3}):\d{1,5}(\s+\S+)*$',
  );

  @override
  Future<void> setCustomBridge(String code) async {
    final lines = [
      for (final line in code.split('\n'))
        if (line.trim().isNotEmpty) line.trim(),
    ];
    if (lines.isEmpty || !lines.every(_bridgeLine.hasMatch)) throw const InvalidBridgeCode();
    // The real engine stores the code protected with the passphrase; the demo
    // only remembers that there is one.
    _bridges.value = const BridgeSettings(mode: BridgeMode.custom, hasCustomBridge: true);
    _settings.value = _withRules(_settings.value);
  }

  @override
  Future<void> removeCustomBridge() async {
    final mode = _bridges.value.mode == BridgeMode.custom ? BridgeMode.automatic : _bridges.value.mode;
    _bridges.value = BridgeSettings(mode: mode);
  }

  // Profile and settings.

  @override
  Stream<List<RelayStatus>> get relays => _relays.stream;

  @override
  Stream<Profile> get profile => _profile.stream.where((profile) => profile != null).cast<Profile>();

  @override
  Future<void> setName(String name) async {
    final profile = _profile.value;
    if (profile != null && name.trim().isNotEmpty) _profile.value = profile.copyWith(name: name.trim());
  }

  @override
  Stream<EngineSettings> get settings => _settings.stream;

  @override
  Future<void> updateSettings(EngineSettings settings) async => _settings.value = _withRules(settings);

  EngineSettings _withRules(EngineSettings settings) => settings.copyWith(
    connectAfterUnlockOnly: settings.connectAfterUnlockOnly || _bridges.value.hasCustomBridge,
    biometricUnlock: settings.biometricUnlock && !settings.reinforcedProtection,
  );

  // Contacts and chats.

  @override
  Stream<List<Contact>> get contacts => _contacts.stream;

  static final _contactCode = RegExp(r'^trino2:[A-Za-z0-9_-]{16,}$');

  @override
  Future<Contact> addContact(String code) async {
    if (!_contactCode.hasMatch(code.trim())) throw const InvalidContactCode();
    final contact = Contact(
      id: 'contact-${_nextId++}',
      name: 'Valentina Gómez',
      trust: Trust.unverified,
      fingerprint: '3C9E 0A71 D46B 28F5',
    );
    _contacts.value = [..._contacts.value, contact];
    return contact;
  }

  @override
  Future<String> openChat(String contactId) async {
    for (final room in _rooms.values) {
      if (room.contactId == contactId) return room.id;
    }
    final contact = _contacts.value.firstWhere((c) => c.id == contactId);
    final room = _Room(
      id: 'chat-$contactId',
      kind: ChatKind.direct,
      title: contact.name,
      contactId: contactId,
      createdAt: _clock(),
    );
    _rooms[room.id] = room;
    _publish(room);
    return room.id;
  }

  @override
  Stream<List<ChatSummary>> get chats => _chats.stream;

  @override
  Stream<List<ChatMessage>> messages(String chatId) => _messagesOf(chatId).stream;

  @override
  Future<void> send(String chatId, String text) async {
    final room = _rooms[chatId];
    if (room == null || text.trim().isEmpty) return;
    final message = ChatMessage(
      id: 'm${_nextId++}',
      chatId: chatId,
      outgoing: true,
      text: text,
      sentAt: _clock(),
      status: MessageStatus.sending,
    );
    room.messages.add(message);
    room.draft = null;
    _publish(room);
    _later(() => _setStatus(room, message.id, MessageStatus.sent));
  }

  @override
  Future<void> retry(String chatId, String messageId) async {
    final room = _rooms[chatId];
    if (room == null) return;
    _setStatus(room, messageId, MessageStatus.sending);
    _later(() => _setStatus(room, messageId, MessageStatus.sent));
  }

  @override
  Future<void> saveDraft(String chatId, String draft) async {
    final room = _rooms[chatId];
    if (room == null) return;
    room.draft = draft.trim().isEmpty ? null : draft;
    _publish(room);
  }

  @override
  Future<void> markRead(String chatId) async {
    final room = _rooms[chatId];
    if (room == null || room.unread == 0) return;
    room.unread = 0;
    _publish(room);
  }

  /// For tests and demos: a message arrives.
  void receive(String chatId, String text, {String? sender}) {
    final room = _rooms[chatId];
    if (room == null) return;
    room.messages.add(
      ChatMessage(id: 'm${_nextId++}', chatId: chatId, outgoing: false, text: text, sentAt: _clock(), sender: sender),
    );
    room.unread++;
    _publish(room);
  }

  // Message requests.

  @override
  Stream<List<MessageRequest>> get requests => _requests.stream;

  @override
  Future<String> acceptRequest(String id) async {
    final request = _takeRequest(id);
    final contact = Contact(
      id: 'contact-${_nextId++}',
      name: request.claimedName,
      trust: Trust.unverified,
      fingerprint: request.fingerprint,
    );
    _contacts.value = [..._contacts.value, contact];
    final room = _Room(
      id: 'chat-${contact.id}',
      kind: ChatKind.direct,
      title: contact.name,
      contactId: contact.id,
      createdAt: request.receivedAt,
      unread: request.messages.length,
    );
    room.messages.addAll([
      for (final message in request.messages)
        ChatMessage(id: 'm${_nextId++}', chatId: room.id, outgoing: false, text: message.text, sentAt: message.sentAt),
    ]);
    _rooms[room.id] = room;
    _publish(room);
    final callAt = request.callAttemptAt;
    if (callAt != null) {
      _addCall(
        CallRecord(
          id: 'call-${_nextId++}',
          contactId: contact.id,
          peerName: contact.name,
          direction: CallDirection.missed,
          startedAt: callAt,
        ),
      );
    }
    return room.id;
  }

  @override
  Future<void> deleteRequest(String id) async {
    final request = _takeRequest(id);
    _dismissedUntil[request.fingerprint] = _clock().add(const Duration(days: 30));
  }

  @override
  Future<void> blockRequest(String id) async => _blocked.add(_takeRequest(id).fingerprint);

  @override
  Future<void> reportRequest(String id) async {
    _requestOf(id);
    _reported.add(id);
  }

  /// For tests and demos: a request arrives, unless its identity is blocked
  /// or was dismissed less than 30 days ago.
  void receiveRequest(MessageRequest request) {
    final dismissedUntil = _dismissedUntil[request.fingerprint];
    if (_blocked.contains(request.fingerprint)) return;
    if (dismissedUntil != null && _clock().isBefore(dismissedUntil)) return;
    _requests.value = List.unmodifiable(
      <MessageRequest>[request, ..._requests.value]..sort((a, b) => b.receivedAt.compareTo(a.receivedAt)),
    );
  }

  /// The ids of the requests reported, oldest first.
  List<String> get reportedRequests => List.unmodifiable(_reported);

  MessageRequest _requestOf(String id) =>
      _requests.value.where((r) => r.id == id).firstOrNull ?? (throw StateError('No request $id'));

  MessageRequest _takeRequest(String id) {
    final request = _requestOf(id);
    _requests.value = List.unmodifiable(_requests.value.where((r) => r.id != id));
    return request;
  }

  // Devices and linking.

  static const _phoneName = 'Pixel 8';

  /// This phone, linked at [phoneLinkedAt], and the computer with the account
  /// key.
  List<LinkedDevice> _linkedDevices(DateTime phoneLinkedAt) => [
    LinkedDevice(
      id: 'device-this',
      name: _phoneName,
      platform: DevicePlatform.android,
      linkedAt: phoneLinkedAt,
      isThisDevice: true,
    ),
    LinkedDevice(
      id: 'device-computer',
      name: demoComputerName,
      platform: DevicePlatform.windows,
      linkedAt: _clock().subtract(const Duration(days: 60)),
      isPrimary: true,
      lastSeen: _clock().subtract(const Duration(minutes: 5)),
    ),
  ];

  @override
  Stream<List<LinkedDevice>> get devices => _devices.stream;

  @override
  Future<void> unlinkThisDevice() async {
    final self = _devices.value.where((device) => device.isThisDevice).firstOrNull;
    if (self == null || self.isPrimary) throw StateError('This device holds the account key');
    await wipe();
  }

  @override
  Stream<LinkSession?> get linking => _linking.stream;

  static const _linkPrefix = 'trino-link:v1:';

  @override
  Future<LinkSession> beginLink(String qrPayload) async {
    if (_identityState.value != IdentityState.needsOnboarding) throw StateError('There is an identity already');
    final payload = qrPayload.trim();
    if (!payload.startsWith(_linkPrefix) || payload.length < _linkPrefix.length + 8) throw const InvalidLinkCode();
    _cancelAll(_linkTimers);
    const session = LinkSession(
      code: demoLinkCode,
      computerName: demoComputerName,
      status: LinkStatus.waitingForConfirmation,
    );
    _linking.value = session;
    final after = linkConfirmAfter;
    if (after != null) _schedule(_linkTimers, after, confirmLinkOnComputer);
    return session;
  }

  @override
  Future<void> setBringChats(bool on) async {
    final session = _linking.value;
    if (session?.status == LinkStatus.waitingForConfirmation) _linking.value = session!.copyWith(bringChats: on);
  }

  @override
  Future<void> cancelLink() async => failLink(LinkFailure.cancelled);

  @override
  Future<void> finishLink({required String passphrase, required bool withTotp}) async {
    final session = _linking.value;
    if (session?.status != LinkStatus.linked || _identityState.value != IdentityState.needsOnboarding) {
      throw StateError('The computer has not confirmed the link');
    }
    if (withTotp && !_totpVerified) throw StateError('Verify the authenticator code first');
    _passphrase = passphrase;
    _totpEnabled = withTotp;
    _profile.value = _demoProfile(demoName);
    _seedDemo(withChats: session!.bringChats);
    _devices.value = _linkedDevices(_clock());
    _lastPassphraseAt = _clock();
    _identityState.value = IdentityState.unlocked;
  }

  /// For tests and demos: the user confirmed on the computer. With
  /// [linkConfirmAfter], the chats then arrive a quarter at a time.
  void confirmLinkOnComputer() {
    final session = _linking.value;
    if (session?.status != LinkStatus.waitingForConfirmation) return;
    final bring = session!.bringChats;
    _linking.value = session.copyWith(status: LinkStatus.linked, chatsProgress: () => bring ? 0 : null);
    final after = linkConfirmAfter;
    if (after == null || !bring) return;
    for (var step = 1; step <= 4; step++) {
      _schedule(_linkTimers, after * step, () => setLinkProgress(step * 25));
    }
  }

  /// For tests and demos: the QR expired or the computer said no.
  void failLink(LinkFailure failure) {
    final session = _linking.value;
    if (session == null || session.status == LinkStatus.linked) return;
    _cancelAll(_linkTimers);
    _linking.value = session.copyWith(status: LinkStatus.failed, failure: failure);
  }

  /// For tests and demos: how much of the chats arrived.
  void setLinkProgress(int percent) {
    final session = _linking.value;
    if (session?.status == LinkStatus.linked && session!.bringChats) {
      _linking.value = session.copyWith(chatsProgress: () => percent.clamp(0, 100));
    }
  }

  // Calls.

  static const _sas = [
    SasSymbol('fox', '🦊'),
    SasSymbol('guitar', '🎸'),
    SasSymbol('cactus', '🌵'),
    SasSymbol('anchor', '⚓'),
    SasSymbol('mushroom', '🍄'),
    SasSymbol('bicycle', '🚲'),
    SasSymbol('bell', '🔔'),
  ];

  @override
  Stream<CallSession?> get call => _call.stream;

  @override
  Stream<List<CallRecord>> get callHistory => _callHistory.stream;

  @override
  Future<void> startCall(String contactId) async {
    if (_call.value != null) return;
    final contact = _contacts.value.firstWhere((c) => c.id == contactId);
    _call.value = CallSession(
      id: 'call-${_nextId++}',
      contactId: contactId,
      peerName: contact.name,
      sas: _sas,
      elapsed: callStartsAt,
    );
    _callStartedAt = _clock();
    _updateCallTimer();
  }

  @override
  Future<void> setMuted(bool muted) async => _updateCall((call) => call.copyWith(muted: muted));

  @override
  Future<void> setSpeaker(bool on) async => _updateCall((call) => call.copyWith(speaker: on));

  @override
  Future<void> setCamera(bool on) async => _updateCall((call) => call.copyWith(camera: on));

  @override
  Future<void> confirmSas({required bool matches}) async =>
      _updateCall((call) => call.copyWith(verified: matches, mismatch: !matches));

  @override
  Future<void> hangUp() async {
    final call = _call.value;
    if (call == null) return;
    _call.value = null;
    _updateCallTimer();
    _addCall(
      CallRecord(
        id: call.id,
        contactId: call.contactId,
        peerName: call.peerName,
        direction: CallDirection.outgoing,
        startedAt: _callStartedAt ?? _clock(),
        duration: call.elapsed,
      ),
    );
  }

  /// Into the history, the latest first, and into the chat with the contact
  /// if there is one, at the time the call started.
  void _addCall(CallRecord record) {
    _callHistory.value = List.unmodifiable(
      <CallRecord>[record, ..._callHistory.value]..sort((a, b) => b.startedAt.compareTo(a.startedAt)),
    );
    final room = _rooms.values.where((room) => room.contactId == record.contactId).firstOrNull;
    if (room == null) return;
    final event = ChatMessage(
      id: 'm${_nextId++}',
      chatId: room.id,
      outgoing: record.direction == CallDirection.outgoing,
      text: '',
      sentAt: record.startedAt,
      call: record,
    );
    final index = room.messages.indexWhere((m) => m.sentAt.isAfter(record.startedAt));
    room.messages.insert(index < 0 ? room.messages.length : index, event);
    _publish(room);
  }

  @override
  Future<void> dispose() async {
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    _cancelAll(_networkTimers);
    _cancelAll(_linkTimers);
    _callTimer?.cancel();
    for (final live in [
      _identityState,
      _network,
      _profile,
      _contacts,
      _chats,
      _call,
      _callHistory,
      _requests,
      _devices,
      _linking,
      _settings,
      _bridges,
      _relays,
    ]) {
      live.close();
    }
    for (final live in _messages.values) {
      live.close();
    }
  }

  // Internals.

  /// Connects through Tor: from 0 %, halfway at 50 %, then connected. When
  /// [tryingAnotherWay], the failure stays on screen while the search runs.
  void _connect({bool tryingAnotherWay = false}) {
    _cancelAll(_networkTimers);
    final current = _network.value;
    _network.value = tryingAnotherWay
        ? (current.status == NetworkStatus.failed
              ? current.copyWith(tryingAnotherWay: true)
              : const NetworkState(status: NetworkStatus.connecting, tryingAnotherWay: true))
        : const NetworkState.connecting();
    final after = connectAfter;
    if (after == null) {
      _schedule(_networkTimers, Duration.zero, () => _network.value = const NetworkState.connected());
      return;
    }
    if (!tryingAnotherWay) {
      _schedule(_networkTimers, after ~/ 2, () => _network.value = const NetworkState.connecting(50));
    }
    _schedule(_networkTimers, after, () => _network.value = const NetworkState.connected());
  }

  /// Runs [action] after [delay], unless [_cancelAll] of [timers] comes first.
  void _schedule(Set<Timer> timers, Duration delay, void Function() action) {
    late final Timer timer;
    timer = Timer(delay, () {
      timers.remove(timer);
      action();
    });
    timers.add(timer);
  }

  void _cancelAll(Set<Timer> timers) {
    for (final timer in timers) {
      timer.cancel();
    }
    timers.clear();
  }

  void _updateCall(CallSession Function(CallSession) change) {
    final call = _call.value;
    if (call != null) _call.value = change(call);
  }

  /// The clock of a call runs while the call exists and someone watches it.
  void _updateCallTimer() {
    final running = _call.value != null && _call.hasListeners;
    if (running && _callTimer == null) {
      _callTimer = Timer.periodic(
        const Duration(seconds: 1),
        (_) => _updateCall((call) => call.copyWith(elapsed: call.elapsed + const Duration(seconds: 1))),
      );
    } else if (!running) {
      _callTimer?.cancel();
      _callTimer = null;
    }
  }

  void _later(void Function() action) {
    if (sendDelay == Duration.zero) {
      scheduleMicrotask(action);
      return;
    }
    late final Timer timer;
    timer = Timer(sendDelay, () {
      _timers.remove(timer);
      action();
    });
    _timers.add(timer);
  }

  void _setStatus(_Room room, String messageId, MessageStatus status) {
    final index = room.messages.indexWhere((m) => m.id == messageId);
    if (index < 0 || !_rooms.containsKey(room.id)) return;
    room.messages[index] = room.messages[index].copyWith(status: status);
    _publish(room);
  }

  _Live<List<ChatMessage>> _messagesOf(String chatId) => _messages.putIfAbsent(chatId, () => _Live(const []));

  void _publish(_Room room) {
    _messagesOf(room.id).value = List.unmodifiable(room.messages);
    _publishChats();
  }

  void _publishChats() {
    final contacts = {for (final contact in _contacts.value) contact.id: contact};
    final summaries = [
      for (final room in _rooms.values)
        if (room.messages.where((m) => !m.isCall).lastOrNull case final last)
          ChatSummary(
            id: room.id,
            kind: room.kind,
            title: room.title,
            contactId: room.contactId,
            trust: contacts[room.contactId]?.trust ?? Trust.unverified,
            memberNames: room.memberNames,
            lastMessage: last?.text,
            lastSender: last?.sender,
            lastIsMine: last?.outgoing ?? false,
            lastActivity: last?.sentAt ?? room.createdAt,
            unread: room.unread,
            draft: room.draft,
          ),
    ]..sort((a, b) => b.lastActivity!.compareTo(a.lastActivity!));
    _chats.value = List.unmodifiable(summaries);
  }

  Profile _demoProfile(String name) => Profile(
    name: name,
    contactCode: 'trino2:AQdTb2bDrWFotLtRjmyXPBrAv0nRPk5Y81qxN69GnwnX8vHuj',
    fingerprint: '70A5 83C6 766D AAD7',
  );

  /// The demo contacts and requests, and with [withChats] the chats and the
  /// calls.
  void _seedDemo({bool withChats = true}) {
    final now = _clock();
    DateTime ago(int minutes) => now.subtract(Duration(minutes: minutes));
    DateTime daysAgo(int days, int hour, int minute) => DateTime(now.year, now.month, now.day - days, hour, minute);

    _contacts.value = const [
      Contact(id: 'ana', name: 'Ana Torres', trust: Trust.verified, fingerprint: '7F3A 91C2 0B5E D4A8'),
      Contact(id: 'carlos', name: 'Carlos Méndez', trust: Trust.unverified, fingerprint: '2B91 C0D4 77E1 5A06'),
      Contact(id: 'lucia', name: 'Lucía', trust: Trust.unverified, fingerprint: 'E4C2 1F08 9B3D 6A75'),
      Contact(id: 'mama', name: 'Mamá', trust: Trust.verified, fingerprint: 'A1D3 5C7E 92B4 0F68'),
      Contact(id: 'papa', name: 'Papá', trust: Trust.unverified, fingerprint: '5E0B D2A9 4C17 83F6'),
    ];

    ChatMessage message(
      String chatId,
      bool outgoing,
      String text,
      DateTime at, {
      String? sender,
      MessageStatus status = MessageStatus.sent,
    }) => ChatMessage(
      id: 'm${_nextId++}',
      chatId: chatId,
      outgoing: outgoing,
      text: text,
      sentAt: at,
      sender: sender,
      status: status,
    );

    final rooms = [
      _Room(id: 'chat-ana', kind: ChatKind.direct, title: 'Ana Torres', contactId: 'ana', createdAt: ago(60), unread: 1)
        ..messages.addAll([
          message('chat-ana', true, '¿Te llegó el documento que te mandé?', ago(29)),
          message('chat-ana', false, 'Sí, ya lo revisé. Está todo bien.', ago(25)),
          message('chat-ana', true, '¿El jueves a las 6, entonces?', ago(22)),
          message('chat-ana', false, 'Perfecto, nos vemos el jueves', ago(18)),
        ]),
      _Room(
          id: 'chat-familia',
          kind: ChatKind.group,
          title: 'Familia',
          memberNames: const ['Mamá', 'Papá'],
          createdAt: ago(600),
          unread: 1,
        )
        ..messages.addAll([
          message('chat-familia', false, '¿Quién trae el pan para la cena?', ago(130), sender: 'Mamá'),
          message('chat-familia', true, 'Yo lo compro de camino', ago(125)),
          message('chat-familia', false, 'Llego a las 7', ago(105), sender: 'Papá'),
        ]),
      _Room(
          id: 'chat-carlos',
          kind: ChatKind.direct,
          title: 'Carlos Méndez',
          contactId: 'carlos',
          createdAt: daysAgo(1, 9, 0),
          draft: 'Mañana te confirmo la hora',
        )
        ..messages.addAll([
          message('chat-carlos', false, 'Te envié el archivo del contrato', daysAgo(1, 18, 20)),
          message('chat-carlos', true, 'Gracias, lo miro esta noche', daysAgo(1, 18, 24)),
          message('chat-carlos', true, 'Te paso la dirección luego', daysAgo(1, 18, 30), status: MessageStatus.failed),
        ]),
      _Room(id: 'chat-lucia', kind: ChatKind.direct, title: 'Lucía', contactId: 'lucia', createdAt: daysAgo(3, 9, 0))
        ..messages.addAll([
          message('chat-lucia', false, '¿Me pasas la receta del ajiaco?', daysAgo(3, 19, 2)),
          message('chat-lucia', true, 'Claro, te la mando ahorita', daysAgo(3, 19, 10)),
          message('chat-lucia', false, '¡Gracias!', daysAgo(3, 19, 15)),
        ]),
    ];
    for (final room in withChats ? rooms : const <_Room>[]) {
      _rooms[room.id] = room;
      _messagesOf(room.id).value = List.unmodifiable(room.messages);
    }
    _publishChats();

    // Calls do not move a chat up: the preview stays on the last message.
    CallRecord call(String contactId, String name, CallDirection direction, DateTime at, [int minutes = 0]) =>
        CallRecord(
          id: 'call-${_nextId++}',
          contactId: contactId,
          peerName: name,
          direction: direction,
          startedAt: at,
          duration: Duration(minutes: minutes),
        );
    for (final record in [
      call('mama', 'Mamá', CallDirection.outgoing, daysAgo(5, 19, 30), 25),
      call('lucia', 'Lucía', CallDirection.missed, daysAgo(3, 18, 40)),
      call('carlos', 'Carlos Méndez', CallDirection.incoming, daysAgo(1, 17, 5), 12),
      call('ana', 'Ana Torres', CallDirection.outgoing, ago(24), 4),
      call('ana', 'Ana Torres', CallDirection.missed, ago(16)),
    ]) {
      if (withChats) _addCall(record);
    }

    DateTime today(int hour, int minute) => daysAgo(0, hour, minute);
    _requests.value = List.unmodifiable([
      MessageRequest(
        id: 'req-ana',
        claimedName: 'ana',
        origin: RequestOrigin.username,
        fingerprint: '9D2E 4B70 C1A8 35F6',
        receivedAt: today(8, 15),
        messages: [
          RequestMessage(
            text: 'Hola, soy Ana, la del taller de cerámica. Te mando las fotos de la clase: www.ejemplo.com/fotos',
            sentAt: today(8, 12),
          ),
        ],
        attachments: [RequestAttachment(kind: AttachmentKind.photo, sizeBytes: 1200000, sentAt: today(8, 12))],
        callAttemptAt: today(8, 15),
        resemblesContact: 'Ana Torres',
      ),
      MessageRequest(
        id: 'req-mara',
        claimedName: 'mara',
        origin: RequestOrigin.group,
        originLabel: 'Familia',
        fingerprint: '4F81 0C2D 9A57 E36B',
        receivedAt: daysAgo(1, 20, 15),
        messages: [RequestMessage(text: 'Hola, ¿me pasas la dirección?', sentAt: daysAgo(1, 20, 15))],
      ),
      MessageRequest(
        id: 'req-julian',
        claimedName: 'julián',
        origin: RequestOrigin.code,
        originLabel: 'Trabajo',
        fingerprint: 'B03C 7E19 62DA 4F85',
        receivedAt: daysAgo(4, 9, 30),
        messages: [RequestMessage(text: 'Buenas, te escribo por lo del contrato', sentAt: daysAgo(4, 9, 30))],
      ),
    ]);
  }
}

class _Room {
  _Room({
    required this.id,
    required this.kind,
    required this.title,
    required this.createdAt,
    this.contactId,
    this.memberNames = const [],
    this.unread = 0,
    this.draft,
  });

  final String id;
  final ChatKind kind;
  final String title;
  final String? contactId;
  final List<String> memberNames;
  final DateTime createdAt;
  final messages = <ChatMessage>[];
  int unread;
  String? draft;
}

/// A value and its changes: each listener gets the current value first, then
/// every change, like the streams the Rust engine will expose.
class _Live<T> {
  _Live(this._value);

  T _value;
  final _listeners = <MultiStreamController<T>>{};

  /// Called when the first listener comes or the last one leaves.
  void Function()? onActive;

  T get value => _value;
  set value(T next) {
    _value = next;
    for (final listener in [..._listeners]) {
      listener.add(next);
    }
  }

  bool get hasListeners => _listeners.isNotEmpty;

  Stream<T> get stream => Stream<T>.multi((controller) {
    controller.add(_value);
    _listeners.add(controller);
    if (_listeners.length == 1) onActive?.call();
    controller.onCancel = () {
      _listeners.remove(controller);
      if (_listeners.isEmpty) onActive?.call();
    };
  });

  void close() {
    for (final listener in [..._listeners]) {
      listener.closeSync();
    }
    _listeners.clear();
  }
}
