package app.trino.gui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps the trino process (Rust runtime + relay
 * websockets) alive while the app is backgrounded, so messages and calls
 * arrive without trino being in the foreground. Equivalent to the desktop
 * "close to tray" behavior. Android requires a persistent notification for
 * this; we keep it minimal and silent.
 */
class TrinoForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val channelId = "trino_background"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        channelId,
        "trino en segundo plano",
        NotificationManager.IMPORTANCE_MIN, // silent, no sound, collapsed
      )
      channel.setShowBadge(false)
      val nm = getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(channel)
    }

    val openIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )

    val notification: Notification =
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        Notification.Builder(this, channelId)
      else
        @Suppress("DEPRECATION") Notification.Builder(this))
        .setContentTitle("trino activo")
        .setContentText("recibiendo mensajes en segundo plano")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentIntent(openIntent)
        .setOngoing(true)
        .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        1001,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      startForeground(1001, notification)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // If the system kills us, restart — the app process (and its sockets)
    // comes back up and reconnects.
    return START_STICKY
  }
}
