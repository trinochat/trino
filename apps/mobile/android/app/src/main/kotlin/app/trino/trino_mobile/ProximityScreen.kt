package app.trino.trino_mobile

import android.content.Context
import android.os.PowerManager
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * The native half of lib/platform/proximity.dart: while enabled, the proximity
 * sensor turns the screen off next to the face (a PROXIMITY_SCREEN_OFF_WAKE_LOCK),
 * on phones that have one. The call screen enables it only during an audio call
 * without the speaker or the camera, and disables it as soon as that ends.
 */
class ProximityScreen(context: Context, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "org.trinochat.app/proximity"
        private const val TAG = "trino:call"
    }

    private val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val channel = MethodChannel(messenger, CHANNEL)
    private var lock: PowerManager.WakeLock? = null

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "enable" -> result.success(enable())
            "disable" -> {
                disable()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    /** Says whether the phone can do it. */
    private fun enable(): Boolean {
        if (lock?.isHeld == true) return true
        if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return false
        val next = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, TAG)
        next.setReferenceCounted(false)
        // Released by disable(): on hang-up, speaker, video, leaving the call
        // screen, pausing the app, or with the engine.
        next.acquire()
        lock = next
        return true
    }

    private fun disable() {
        val current = lock ?: return
        lock = null
        // The screen comes back once nothing is next to it, not against the cheek.
        if (current.isHeld) current.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
    }

    /** With the engine: the screen stays on, and no more calls. */
    fun dispose() {
        disable()
        channel.setMethodCallHandler(null)
    }
}
