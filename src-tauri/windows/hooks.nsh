; Trino's hooks for Tauri's NSIS installer (tauri.conf.json,
; bundle.windows.nsis.installerHooks). Tor design §6.3, spike S9.
;
; lyrebird.exe, Trino's bridge program (docs/tor.md, "Puentes"), is started
; by Trino itself, and Tauri's installer only closes TrinoChat.exe before it
; writes the new files. Trino's own updater stops Tor, and lyrebird with it,
; before it runs the installer; this is the backup for an installer started
; by hand while Trino runs with bridges, which could not overwrite a
; lyrebird.exe still running.
;
; Nothing is killed by name: Tor Browser's lyrebird.exe has the same name.
; A running program cannot be deleted, but its file can be renamed, so the
; one in Trino's folder is moved aside; the new one is written in its place,
; and the old one leaves by itself once TrinoChat.exe is closed (its input
; closes, TOR_PT_EXIT_ON_STDIN_CLOSE). The next install removes the old file.

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\lyrebird.old.exe"
  ClearErrors
  Delete "$INSTDIR\lyrebird.exe"
  IfErrors 0 +2
    Rename "$INSTDIR\lyrebird.exe" "$INSTDIR\lyrebird.old.exe"
  ClearErrors
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\lyrebird.old.exe"
!macroend
