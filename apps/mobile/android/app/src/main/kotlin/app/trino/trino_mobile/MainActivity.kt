package app.trino.trino_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/** Opens the app's own channels (see lib/platform/) on the engine it configures. */
class MainActivity : FlutterActivity() {
    private var callSounds: CallSounds? = null
    private var proximity: ProximityScreen? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        callSounds = CallSounds(applicationContext, messenger)
        proximity = ProximityScreen(applicationContext, messenger)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        callSounds?.dispose()
        callSounds = null
        proximity?.dispose()
        proximity = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
