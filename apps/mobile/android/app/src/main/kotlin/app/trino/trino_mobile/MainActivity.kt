package app.trino.trino_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/** Opens the app's own channels (see lib/platform/) on the engine it configures. */
class MainActivity : FlutterActivity() {
    private var callSounds: CallSounds? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        callSounds = CallSounds(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        callSounds?.dispose()
        callSounds = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
