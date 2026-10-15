# Auditoría de red por proceso (TOR-12, R-13)

`scripts/audit-tor.ps1` comprueba, en una corrida real de Trino en Windows,
que nada de lo que Trino abre sale del equipo, salvo esto:

| Proceso | A dónde puede ir |
|---|---|
| `TrinoChat.exe` | Relays de Tor (tu guarda y los directorios). Con puente, solo a `127.0.0.1`, donde escucha `lyrebird` |
| `lyrebird.exe` | El puente. Con Snowflake, también su broker, sus servidores STUN y sus voluntarios; con WebTunnel, el dominio del puente |
| `msedgewebview2.exe` (el de Trino) | El TURN de Cloudflare durante una llamada (`turn.cloudflare.com`), y los servicios de Microsoft que WebView2 usa por su cuenta (W1–W4 del diseño) |

Cualquier otra cosa es un fallo. Es la capa 4 de §3.2 del diseño de Tor, y la
prueba que cumple el criterio de aceptación "una prueba que bloquea la red
directa" (con la variante de lista blanca).

## De dónde saca la evidencia

- **Los eventos 5156 y 5157 del registro de Seguridad** (Plataforma de
  filtrado de Windows: conexión permitida y conexión bloqueada). Cada uno trae
  el programa, su id de proceso, la dirección y el puerto de destino.
- **El registro del cliente DNS** (`Microsoft-Windows-DNS-Client/Operational`):
  qué nombre pidió cada proceso y qué direcciones le respondieron. Con eso el
  informe le pone nombre a cada dirección (por ejemplo, que una IP era
  `turn.cloudflare.com`), y marca como fallo cualquier nombre que Trino
  resuelva en el equipo: con Tor, el nombre lo resuelve la salida.
- **La lista de relays de Tor**, que bajas tú (ver abajo), para saber si una
  dirección es un relay.
- **`Watch`**, que anota los ids de proceso de Trino y de los procesos de
  WebView2 que cuelgan de él. Así no se mezcla el WebView2 de otros
  programas (Teams, los widgets de Windows…).

## Qué cambia en Windows, y cómo se deshace

El script no hace nada solo. Sin `-Action` solo muestra el plan. Las acciones
que cambian algo piden administrador, muestran cada cambio con el comando que
lo deshace, y no aplican nada hasta que escribes `yes`.

| Acción | Cambia | Se deshace con |
|---|---|---|
| `Start` | Guarda toda la política de auditoría (`auditpol /backup`); activa la auditoría de "Conexión de Plataforma de filtrado" (por su GUID, `{0CCE9226-69AE-11D9-BED3-505054503030}`, porque el nombre cambia con el idioma de Windows) para aciertos y errores; sube el registro de Seguridad a 512 MB si era más chico; enciende el registro DNS con 128 MB | `Stop` |
| `AllowList` | Agrega dos reglas de bloqueo del Firewall, en el grupo `Trino audit (TOR-12)` | `Stop` |
| `Stop` | Restaura la política (`auditpol /restore`) y los dos registros como estaban, y borra las reglas del grupo | — |
| `Plan`, `Watch`, `Report` | Nada | — |

Lo que `Start` encontró queda en `%LOCALAPPDATA%\TrinoAudit\` (`state.json` y
`auditpol-before.csv`). Si `Stop` no encuentra ese registro, apaga la
auditoría de esa subcategoría, que es lo que Windows trae por defecto. Si un
paso de `Stop` falla, sigue con los demás y te dice cuál correr a mano.

## Cómo se corre

Antes de empezar:

1. **Cierra Tor Browser**: su `lyrebird.exe` se llama igual que el de Trino.
   Si puedes, cierra también otros programas con WebView2.
2. **Baja la lista de relays de Tor el mismo día**, en una PowerShell normal:

   ```powershell
   Invoke-WebRequest https://onionoo.torproject.org/summary -OutFile $env:TEMP\relays.json
   ```

   Es una conexión directa de tu equipo a torproject.org (no de Trino): tu
   proveedor ve que la pides. Trae los relays que funcionaron la última
   semana, así que tu guarda está ahí aunque sea de días atrás. El script
   también acepta un archivo con una dirección por línea.
3. Ten a mano la versión que vas a probar. Si es un exe de prueba con otro
   nombre (por ejemplo `prueba-tor-c0b26b2.exe`), pásalo en cada acción con
   `-TrinoExe prueba-tor-c0b26b2.exe`.

Después, en el repositorio:

1. **Mira el plan**, sin administrador. No cambia nada:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1
   ```

   `-ExecutionPolicy Bypass` vale solo para esa ventana; no cambia la
   política del equipo.
2. **Empieza**, en una PowerShell **como administrador**:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1 -Action Start
   ```

   Lee la lista y escribe `yes`.
3. **Anota los procesos**, en otra PowerShell normal, y déjala abierta:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1 -Action Watch
   ```

4. **Abre Trino y haz los recorridos**, unos 10 minutos cada uno. Anota la
   hora en que empieza y termina cada uno:
   - la app quieta, desbloqueada;
   - un chat con un enlace, sin tocarlo;
   - el inspector de red abierto;
   - subir y bajar un archivo;
   - una llamada protegida;
   - con un puente integrado (cada transporte en su propia corrida).
5. **El informe**, como administrador (el registro de Seguridad lo pide). Uno
   por recorrido, con sus horas:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1 -Action Report `
     -RelayList $env:TEMP\relays.json -Since '15:00' -Until '15:10' -OutCsv .\llamada.csv
   ```

   Con un puente agrega `-Transport obfs4` (o `snowflake`, `webtunnel`) y
   `-Bridge <IP del puente>`. Sin `-Since`, cuenta desde `Start`.
6. **Deshaz todo**, como administrador:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1 -Action Stop
   ```

   Para comprobarlo: `auditpol /get /subcategory:"{0CCE9226-69AE-11D9-BED3-505054503030}"`.

## La variante de lista blanca

Con un puente obfs4 de prueba configurado en Trino (una línea privada que
consigas tú):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\audit-tor.ps1 -Action AllowList -BridgeAddress <IP del puente>
```

Agrega dos reglas de bloqueo: `TrinoChat.exe` solo puede hablar con este
equipo (con `lyrebird`), y `lyrebird.exe` solo con esa IP. Si Trino no está
instalado en `%LOCALAPPDATA%\Trino Chat\`, pasa `-TrinoPath` (y
`-LyrebirdPath`, si `lyrebird.exe` no está al lado). Haz los recorridos y
saca el informe con `-Transport obfs4 -Bridge <IP>`. **Lo esperado:** ningún
5157 de `TrinoChat.exe` ni de `lyrebird.exe`, y nada en FAIL. Un 5157 quiere
decir que algo intentó salir por otro camino.

**Sin `-BridgeAddress`** las reglas no dejan salir a ninguno de los dos: es la
prueba aparte de "No se pudo conectar". Lo esperado es esa pantalla, y en el
informe solo filas "blocked by the firewall: a Tor relay" (Trino intentando
llegar a Tor, y nada más).

`Stop` borra las reglas. Si el Firewall está apagado en algún perfil,
`AllowList` lo avisa, porque ahí las reglas no hacen nada.

## Cómo se lee el informe

Una fila por proceso, destino y motivo, con cuántas veces pasó:

- **OK**: lo que el diseño permite (un relay, el puente, `127.0.0.1`, el TURN
  de una llamada).
- **KNOWN**: Microsoft, desde WebView2. Sale fuera de Trino y el texto de "Qué
  ve la red" lo dice (W1–W4).
- **REVIEW**: no se pudo decidir. Por ejemplo, sin `-RelayList`, WebView2
  hacia la red local (mDNS) o una dirección de WebTunnel que el DNS no nombra.
- **FAIL**: algo salió por donde no debía.

El código de salida es 0 sin FAIL, 1 con algún FAIL, y 2 si la evidencia
está incompleta: sin lista de relays, sin `Watch`, ningún evento de Trino en
la corrida, o el registro de Seguridad ya había sobrescrito el comienzo.

## Límites

- **El registro DNS y el id de proceso:** el informe supone que el id de
  proceso de cada evento DNS es el del programa que preguntó. Compruébalo una
  vez, después de `Start`: corre `Resolve-DnsName example.org` en una
  PowerShell y mira que el evento 3008 de
  `Get-WinEvent -LogName Microsoft-Windows-DNS-Client/Operational -MaxEvents 5 | Format-List ProcessId, Message`
  traiga el `$PID` de esa ventana.
- **El DNS propio de WebView2:** si WebView2 resolviera por su cuenta, sin el
  cliente DNS de Windows, sus nombres no aparecerían en el registro. Se vería
  como conexiones de `msedgewebview2.exe` al puerto 53 (REVIEW si van a tu
  router) y como direcciones sin nombre. Para el TURN, una dirección de
  Cloudflare (sus rangos publicados) en el puerto 3478, 5349, 443 o 53 cuenta
  como OK aunque no tenga nombre.
- **Los nombres de Microsoft** están en una lista dentro del script. Un nombre
  nuevo de Microsoft sale como FAIL hasta que se agregue.
- **Snowflake**: los voluntarios son direcciones de cualquier parte, así que
  con `-Transport snowflake` todo lo de `lyrebird.exe` es OK. Lo que cuenta ahí
  es que `TrinoChat.exe` no salga a ningún lado.
- El script no mira el tráfico de otros programas, ni sabe qué hizo Windows
  por su cuenta (Defender, Windows Update).

## Las pruebas del script

No tocan nada de Windows: leen eventos de ejemplo (el XML que da Windows) y
prueban las decisiones, los rangos del Firewall y los planes. Corren en
Windows PowerShell 5.1 y en PowerShell 7, sin módulos, y el CI las corre en
Windows:

```powershell
pwsh -NoProfile -File scripts/audit-tor.tests.ps1
```
