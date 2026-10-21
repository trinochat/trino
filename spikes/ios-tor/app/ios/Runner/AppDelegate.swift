import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let spike = TorSpike()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "TrinoTorSpike") {
      spike.attach(to: registrar.messenger())
    }
  }
}

/// The native half of lib/main.dart's SpikeChannel: each call goes to a C
/// function of spike_ios.h (the Rust library) off the main thread, and its
/// JSON goes back as it is.
///
/// Starting, probing and stopping block, so they run one at a time on their
/// own queue; the state, notes and the report are quick and run beside them,
/// so the screen can follow a start while it goes on.
final class TorSpike {
  static let channelName = "org.trinochat.spike/tor"

  private var channel: FlutterMethodChannel?
  private let slow = DispatchQueue(label: "org.trinochat.spike.slow", qos: .userInitiated)
  private let quick = DispatchQueue(
    label: "org.trinochat.spike.quick", qos: .userInitiated, attributes: .concurrent)

  /// Application Support/spike/tor-spike: kept out of iCloud backups (the
  /// "spike" folder; Rust wipes and remakes "tor-spike" on a cold start).
  private lazy var torHome: String = {
    let fm = FileManager.default
    let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    var parent = support.appendingPathComponent("spike", isDirectory: true)
    try? fm.createDirectory(at: parent, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? parent.setResourceValues(values)
    return parent.appendingPathComponent("tor-spike", isDirectory: true).path
  }()

  func attach(to messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: TorSpike.channelName, binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
    self.channel = channel
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "start":
      let fresh = arguments["fresh"] as? Bool ?? false
      let trustDirs = arguments["trustDirs"] as? Bool ?? false
      let home = torHome
      run(on: slow, result) { spike_tor_start(home, fresh, trustDirs) }
    case "status":
      run(on: quick, result) { spike_tor_status() }
    case "probe":
      let url = arguments["url"] as? String ?? "wss://nos.lol"
      let limit = UInt32(arguments["limitSecs"] as? Int ?? 90)
      run(on: slow, result) { spike_ws_probe(url, limit) }
    case "stop":
      run(on: slow, result) { spike_tor_stop() }
    case "note":
      let text = arguments["text"] as? String ?? ""
      run(on: quick, result) { spike_note(text) }
    case "report":
      run(on: quick, result) { spike_report() }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  /// Calls `body` on `queue`, turns its JSON into a String, frees it, and
  /// answers on the main thread.
  private func run(
    on queue: DispatchQueue, _ result: @escaping FlutterResult,
    _ body: @escaping () -> UnsafeMutablePointer<CChar>?
  ) {
    queue.async {
      let json: String
      if let pointer = body() {
        json = String(cString: pointer)
        spike_free(pointer)
      } else {
        json = "{\"ok\":false,\"error\":\"null from Rust\"}"
      }
      DispatchQueue.main.async { result(json) }
    }
  }
}
