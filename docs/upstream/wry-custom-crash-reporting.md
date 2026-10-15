# wry: los informes de fallos de WebView2 (decisión 20, R-08)

> **Nota para David, no va en el PR.** Nada de esto se ha publicado. Abrir el
> PR (en `tauri-apps/wry`, con tu cuenta) es decisión tuya. El parche está en
> `wry-custom-crash-reporting.patch`, al lado de este archivo.

## Por qué

- WebView2 sube a Microsoft los informes de sus caídas (crashpad). Puede
  incluir pedazos de memoria del proceso que se cayó, y con ellos lo que la
  ventana mostraba.
- La opción que lo apaga, `IsCustomCrashReportingEnabled`, es del *entorno*
  de WebView2: vale solo si se pone antes de
  `CreateCoreWebView2EnvironmentWithOptions`, y esa llamada la hace wry por
  dentro sin exponerla (`wry-0.55.1/src/webview2/mod.rs`, `create_environment`).
- El spike (S5) mostró que las banderas de Chromium (`--disable-breakpad`,
  `--disable-crash-reporter`) **no** apagan `crashpad-handler`. Por eso la
  decisión 20 tomó la ruta del PR, sin mantener un fork de wry.
- Mientras tanto: `traces.rs` borra los minivolcados al abrir cada ventana
  (CL-6b), pero para entonces pudieron haber salido; y el texto de "Qué ve la
  red" dice que pueden salir.

## Qué falta después de wry

1. **wry** (este parche): `WebViewBuilderExtWindows::with_custom_crash_reporting`.
2. **tauri-runtime-wry y tauri**: otro PR que lleve la opción hasta
   `WebviewWindowBuilder` (y quizá a `tauri.conf.json`, por ejemplo
   `app.windows[].customCrashReporting`), porque Trino crea su ventana con
   Tauri (`window_renewal.rs`, `WebviewWindowBuilder::from_config`).
3. **Trino**: encenderla en la ventana principal y en las renovadas, con una
   prueba, y cambiar el texto de "Qué ve la red".

Las ventanas que comparten carpeta de datos comparten el entorno de WebView2,
así que todas las de Trino tienen que pedir lo mismo.

## Cómo se probó (15 oct 2026)

- Sobre wry 0.55.1 de crates.io, en una copia aparte: la prueba nueva
  (`custom_crash_reporting_is_off_unless_asked_for`) no compila sin el cambio
  y pasa con él (`cargo test --lib`, Windows). `rustfmt --check` limpio.
- `webview2-com` 0.38.2 ya trae `set_is_custom_crash_reporting_enabled` y
  sus pruebas, así que wry no necesita nada nuevo.
- **No se probó** que con la opción encendida WebView2 deje de subir un
  informe: hace falta provocar una caída del renderer y mirar la red (por
  ejemplo con la auditoría de `docs/audit-tor.md`). Queda para cuando Tauri
  lo exponga.
- Antes de abrir el PR hay que pasarlo a la rama `dev` de wry, que puede
  haber cambiado desde 0.55.1.

---

## The pull request (English, as it would be posted)

**Title:** feat(windows): add `with_custom_crash_reporting` to keep WebView2 crash reports local

**Body:**

WebView2 sends crash reports to Microsoft by default. Apps that handle
sensitive content may want those reports to stay on the machine: a crash
dump can hold parts of the renderer's memory, and with them what the page
was showing.

WebView2 has an option for this, `IsCustomCrashReportingEnabled`
([`ICoreWebView2EnvironmentOptions3`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions3#get_iscustomcrashreportingenabled)).
When it is `true`, the runtime does not send crash data to Microsoft; the
dumps are still written locally, to the folder
`ICoreWebView2Environment11::FailureReportFolderPath` names, for the app to
handle. It is an environment option, so it only works if it is set before
`CreateCoreWebView2EnvironmentWithOptions`, which wry calls internally in
`create_environment`. Today there is no way for an app to set it, and the
Chromium switches one might try in `with_additional_browser_args`
(`--disable-breakpad`, `--disable-crash-reporter`) do not stop WebView2's
`crashpad-handler`: we checked on WebView2 155.

This PR adds, on Windows:

- `WebViewBuilderExtWindows::with_custom_crash_reporting(enabled: bool)`;
- a `custom_crash_reporting` platform attribute, `false` by default
  (WebView2's own default, so nothing changes for existing apps);
- `options.set_is_custom_crash_reporting_enabled(...)` in
  `create_environment`, next to the other environment options.

`webview2-com` already implements the option on
`CoreWebView2EnvironmentOptions`, so no dependency changes. As with the
other environment options, it does nothing when the app passes its own
environment with `with_environment`, and webviews that share a data
directory must agree on it (documented on the method, like
`with_scroll_bar_style`).

Tests: a unit test that the attribute is off by default and follows the
builder. A covector change file is included (`.changes/custom-crash-reporting.md`,
`minor`).

If this lands, a follow-up in `tauri-runtime-wry`/`tauri` would expose it on
`WebviewWindowBuilder` (and possibly the window config), since Tauri apps do
not build wry webviews themselves.
