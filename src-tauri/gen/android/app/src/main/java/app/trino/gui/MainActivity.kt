package app.trino.gui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the process (relay sockets + vault) alive when backgrounded so
    // messages and calls still arrive. See TrinoForegroundService.
    val svc = Intent(this, TrinoForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(svc)
    } else {
      startService(svc)
    }
  }
}
