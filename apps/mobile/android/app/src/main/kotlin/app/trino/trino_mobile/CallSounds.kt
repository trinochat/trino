package app.trino.trino_mobile

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The native half of lib/platform/call_sounds.dart: plays the WAV the Dart side
 * renders (lib/sound/tones.dart: 16-bit PCM, mono, 44.1 kHz, a 44-byte header),
 * vibrates and reads the ringer mode. Only the Android SDK.
 *
 * The ring plays as a ringtone (it follows the ringtone volume); the ringback
 * and the end tone play on the voice stream, as part of the call.
 */
class CallSounds(private val context: Context, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "org.trinochat.app/call_sounds"
        private const val SAMPLE_RATE = 44100
        private const val WAV_HEADER_BYTES = 44
    }

    private val channel = MethodChannel(messenger, CHANNEL)
    private var track: AudioTrack? = null

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "playLoop" -> {
                val loop = call.argument<ByteArray>("loop")
                if (loop != null) play(call.argument<String>("usage"), call.argument<ByteArray>("intro"), loop, true)
                result.success(null)
            }
            "playOnce" -> {
                val wav = call.argument<ByteArray>("wav")
                if (wav != null) play(call.argument<String>("usage"), null, wav, false)
                result.success(null)
            }
            "stop" -> {
                stop()
                result.success(null)
            }
            "vibrate" -> {
                val pattern = call.argument<List<Number>>("pattern")
                if (pattern != null) vibrate(pattern.map { it.toLong() }.toLongArray())
                result.success(null)
            }
            "cancelVibration" -> {
                vibrator()?.cancel()
                result.success(null)
            }
            "ringerMode" -> {
                val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                result.success(
                    when (audio.ringerMode) {
                        AudioManager.RINGER_MODE_SILENT -> "silent"
                        AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
                        else -> "normal"
                    },
                )
            }
            else -> result.notImplemented()
        }
    }

    /** The samples of a WAV written by lib/sound/tones.dart. */
    private fun samplesOf(wav: ByteArray): ShortArray {
        if (wav.size <= WAV_HEADER_BYTES) return ShortArray(0)
        val shorts = ByteBuffer.wrap(wav, WAV_HEADER_BYTES, wav.size - WAV_HEADER_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
            .asShortBuffer()
        return ShortArray(shorts.remaining()).also { shorts.get(it) }
    }

    /** Plays [intro] once and then [sound], looping it when [loop]. */
    private fun play(usage: String?, intro: ByteArray?, sound: ByteArray, loop: Boolean) {
        stop()
        val head = intro?.let { samplesOf(it) } ?: ShortArray(0)
        val samples = head + samplesOf(sound)
        if (samples.isEmpty()) return
        val ringtone = usage == "ringtone"
        val attributes = AudioAttributes.Builder()
            .setUsage(
                if (ringtone) AudioAttributes.USAGE_NOTIFICATION_RINGTONE else AudioAttributes.USAGE_VOICE_COMMUNICATION,
            )
            .setContentType(
                if (ringtone) AudioAttributes.CONTENT_TYPE_SONIFICATION else AudioAttributes.CONTENT_TYPE_SPEECH,
            )
            .build()
        val format = AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val next = try {
            AudioTrack(attributes, format, samples.size * 2, AudioTrack.MODE_STATIC, AudioManager.AUDIO_SESSION_ID_GENERATE)
        } catch (error: IllegalArgumentException) {
            return
        }
        if (next.state == AudioTrack.STATE_UNINITIALIZED) {
            next.release()
            return
        }
        next.write(samples, 0, samples.size)
        if (loop) {
            next.setLoopPoints(head.size, samples.size, -1)
        } else {
            // A tone played once lets go of its buffer when it ends.
            next.notificationMarkerPosition = samples.size
            next.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(ended: AudioTrack) {
                    if (track === ended) stop()
                }

                override fun onPeriodicNotification(ended: AudioTrack) {}
            })
        }
        next.play()
        track = next
    }

    private fun stop() {
        val current = track ?: return
        track = null
        try {
            current.stop()
        } catch (error: IllegalStateException) {
            // Never started.
        }
        current.release()
    }

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager?)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator?
        }

    /** Waits, vibrates and pauses as [pattern] says (ms), over and over, until cancelled. */
    private fun vibrate(pattern: LongArray) {
        val vibrator = vibrator() ?: return
        if (!vibrator.hasVibrator()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            @Suppress("DEPRECATION")
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), attributes)
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(pattern, 0)
        }
    }

    /** With the engine: silence, and no more calls. */
    fun dispose() {
        stop()
        vibrator()?.cancel()
        channel.setMethodCallHandler(null)
    }
}
