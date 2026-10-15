import AVFoundation
import AudioToolbox
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let callSounds = CallSounds()
  private let proximity = ProximityScreen()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // The app's own channels (lib/platform/), on the engine's messenger.
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "TrinoCallSounds") {
      callSounds.attach(to: registrar.messenger())
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "TrinoProximityScreen") {
      proximity.attach(to: registrar.messenger())
    }
  }
}

/// The native half of lib/platform/call_sounds.dart: plays the WAV the Dart
/// side renders (lib/sound/tones.dart) and vibrates. Only system frameworks.
///
/// iOS has no public API to read the ring/silent switch, so "ringerMode"
/// answers "unknown". The ring plays in the .soloAmbient category, which the
/// switch (and the screen lock) mutes, so it still respects the switch; the
/// ringback and the end tone are part of the call and play in .playback.
final class CallSounds {
  static let channelName = "org.trinochat.app/call_sounds"

  private var channel: FlutterMethodChannel?
  private var players: [AVAudioPlayer] = []
  private var vibration: Timer?

  func attach(to messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: CallSounds.channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
    self.channel = channel
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    let usage = arguments["usage"] as? String
    switch call.method {
    case "playLoop":
      if let loop = arguments["loop"] as? FlutterStandardTypedData {
        let intro = arguments["intro"] as? FlutterStandardTypedData
        play(usage: usage, intro: intro?.data, sound: loop.data, loops: true)
      }
      result(nil)
    case "playOnce":
      if let wav = arguments["wav"] as? FlutterStandardTypedData {
        play(usage: usage, intro: nil, sound: wav.data, loops: false)
      }
      result(nil)
    case "stop":
      stop()
      result(nil)
    case "vibrate":
      let pattern = arguments["pattern"] as? [NSNumber] ?? []
      let every = pattern.reduce(0.0) { $0 + $1.doubleValue } / 1000
      vibrate(every: every)
      result(nil)
    case "cancelVibration":
      vibration?.invalidate()
      vibration = nil
      result(nil)
    case "ringerMode":
      result("unknown")
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  /// Plays [intro] once and then [sound], looping it when [loops].
  private func play(usage: String?, intro: Data?, sound: Data, loops: Bool) {
    stop()
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(usage == "ringtone" ? .soloAmbient : .playback)
    try? session.setActive(true)
    guard let main = try? AVAudioPlayer(data: sound) else { return }
    main.numberOfLoops = loops ? -1 : 0
    main.prepareToPlay()
    if let intro = intro, let first = try? AVAudioPlayer(data: intro) {
      first.prepareToPlay()
      let start = first.deviceCurrentTime + 0.05
      first.play(atTime: start)
      main.play(atTime: start + first.duration)
      players = [first, main]
    } else {
      main.play()
      players = [main]
    }
  }

  private func stop() {
    for player in players {
      player.stop()
    }
    players = []
  }

  /// One vibration now and one every [every] seconds, until cancelled.
  private func vibrate(every: TimeInterval) {
    vibration?.invalidate()
    vibration = nil
    AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    guard every > 0 else { return }
    vibration = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
      AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }
  }
}

/// The native half of lib/platform/proximity.dart: while enabled, the
/// proximity sensor turns the screen off next to the face. On a device without
/// the sensor the property stays false and the screen stays on.
final class ProximityScreen {
  static let channelName = "org.trinochat.app/proximity"

  private var channel: FlutterMethodChannel?

  func attach(to messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: ProximityScreen.channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "enable":
        UIDevice.current.isProximityMonitoringEnabled = true
        result(UIDevice.current.isProximityMonitoringEnabled)
      case "disable":
        UIDevice.current.isProximityMonitoringEnabled = false
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    self.channel = channel
  }
}
