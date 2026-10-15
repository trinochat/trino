<#
.SYNOPSIS
  Per-process network audit of one run of Trino (Tor design §3.2 layer 4,
  test R-13). Read docs/audit-tor.md first.

.DESCRIPTION
  Proves, for one run of Trino on Windows, that nothing it opens leaves the
  machine except:
    - TrinoChat.exe to Tor relays (its guard and directory mirrors) or, with
      bridges, to lyrebird on 127.0.0.1;
    - lyrebird.exe to the bridge (or, with Snowflake, its broker, STUN
      servers and volunteers; with WebTunnel, the bridge's domain);
    - msedgewebview2.exe to Cloudflare's TURN during a call, and the
      Microsoft endpoints WebView2 itself talks to (outside Trino).
  It reads what Windows records per process: the Windows Filtering Platform
  audit events 5156 (connection allowed) and 5157 (connection blocked) in the
  Security log, and the DNS client log
  (Microsoft-Windows-DNS-Client/Operational).

  NOTHING RUNS BY ITSELF. Without -Action it only prints the plan. The
  actions that change Windows settings (Start, AllowList, Stop) need an
  administrator, print every change with the command that undoes it, and
  apply nothing until you type "yes".

  Actions:
    Plan       (default) Print what Start, AllowList and Stop would change.
               Changes nothing.
    Start      Turn on auditing of filtering-platform connections and the DNS
               client log, and make both logs big enough for a walkthrough.
               Saves how they were, for Stop. Administrator; asks first.
    Watch      While you use Trino, write down the process ids of Trino and
               of its own WebView2 processes (Ctrl+C to end). Changes
               nothing, needs no administrator.
    Report     Read the events of the run and print one row per process and
               destination with a verdict: OK, KNOWN (outside Trino, as the
               design says), REVIEW or FAIL. Changes nothing; administrator,
               to read the Security log. Exit code 0 with no FAIL, 1 with a
               FAIL, 2 when the evidence is incomplete.
    AllowList  The allow-list variant: firewall rules that let TrinoChat.exe
               reach only this machine (lyrebird) and lyrebird.exe only the
               test bridge. Administrator; asks first.
    Stop       Undo everything: the audit policy and both logs as they were,
               and the allow-list rules removed. Administrator; asks first.

.EXAMPLE
  .\scripts\audit-tor.ps1                       # the plan; changes nothing
  .\scripts\audit-tor.ps1 -Action Start
  .\scripts\audit-tor.ps1 -Action Watch
  .\scripts\audit-tor.ps1 -Action Report -RelayList .\relays.json -Transport obfs4 -Bridge 192.0.2.10
  .\scripts\audit-tor.ps1 -Action Stop
#>
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Start', 'Watch', 'Report', 'AllowList', 'Stop')]
    [string]$Action = 'Plan',
    # The names Trino's own process can have: the installed one, and a test
    # exe renamed by hand.
    [string[]]$TrinoExe = @('TrinoChat.exe'),
    # How Trino reached Tor in this run.
    [ValidateSet('none', 'obfs4', 'snowflake', 'webtunnel')]
    [string]$Transport = 'none',
    # The address of each bridge in use (from its line), for Report.
    [string[]]$Bridge = @(),
    # Tor relays: Onionoo's summary document (JSON) or one address per line.
    [string]$RelayList,
    # The run to read; by default, from Start until now.
    [datetime]$Since,
    [datetime]$Until,
    # Report: also write every row to this CSV file.
    [string]$OutCsv,
    # AllowList: the programs to fence, and the test bridge (IPv4).
    [string]$TrinoPath = (Join-Path $env:LOCALAPPDATA 'Trino Chat\TrinoChat.exe'),
    [string]$LyrebirdPath,
    [string]$BridgeAddress,
    # Where Start keeps how things were, and Watch the process ids.
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'TrinoAudit')
)

Set-StrictMode -Version 2.0

# ---- Constants -------------------------------------------------------------

# "Filtering Platform Connection", by GUID: the name is translated on a
# Windows in another language, the GUID is not.
$script:WfpConnectionGuid = '{0CCE9226-69AE-11D9-BED3-505054503030}'
$script:DnsLog = 'Microsoft-Windows-DNS-Client/Operational'
# Big enough for a 10-minute walkthrough on a busy machine: 5156 records
# every connection of every program, about 1 KB each.
$script:SecurityLogBytes = 512MB
$script:DnsLogBytes = 128MB
$script:FirewallGroup = 'Trino audit (TOR-12)'
$script:Lyrebird = 'lyrebird.exe'
$script:WebView = 'msedgewebview2.exe'

# Cloudflare's published ranges (https://www.cloudflare.com/ips-v4 and
# /ips-v6). TURN answers from them; used only when the DNS log did not name
# an address.
$script:CloudflareRanges = @(
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
)
# TURN and STUN of Trino's calls (docs/llamadas-turn.md).
$script:TurnNames = @('turn.cloudflare.com', 'stun.cloudflare.com')
$script:TurnPorts = @(3478, 5349, 443, 53)
# What WebView2 and Windows send to Microsoft by themselves (design §3,
# W1-W4): outside Trino, reported as KNOWN.
$script:MicrosoftSuffixes = @(
    'microsoft.com', 'msedge.net', 'live.com', 'windows.com', 'windows.net',
    'bing.com', 'msn.com', 'office.com', 'office.net', 'microsoftonline.com',
    'azureedge.net', 'azurefd.net', 'trafficmanager.net', 'akamaized.net',
    'msftconnecttest.com', 'smartscreen.microsoft.com', 'edge.microsoft.com',
    'gvt1.com'
)

# ---- Addresses -------------------------------------------------------------

# The canonical text of an address, or $null: no brackets, no port, and an
# IPv4-mapped IPv6 address ("::ffff:1.2.3.4") as plain IPv4.
function ConvertTo-PlainAddress([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $t = $Text.Trim()
    # A bare number parses as an address ("1" is 0.0.0.1): never one here.
    if ($t -notmatch '[.:]') { return $null }
    if ($t -match '^\[([^\]]+)\](:\d+)?$') { $t = $Matches[1] }
    elseif ($t -match '^(\d{1,3}(\.\d{1,3}){3}):\d+$') { $t = $Matches[1] }
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($t, [ref]$ip)) { return $null }
    if ($ip.AddressFamily -eq 'InterNetworkV6' -and $ip.IsIPv4MappedToIPv6) {
        $ip = $ip.MapToIPv4()
    }
    return $ip.ToString()
}

function Test-InCidr([string]$Address, [string]$Cidr) {
    $parts = $Cidr.Split('/')
    $ip = [System.Net.IPAddress]::Parse($Address)
    $net = [System.Net.IPAddress]::Parse($parts[0])
    if ($ip.AddressFamily -ne $net.AddressFamily) { return $false }
    $a = $ip.GetAddressBytes(); $b = $net.GetAddressBytes()
    $bits = [int]$parts[1]
    for ($i = 0; $i -lt $a.Length; $i++) {
        $take = [Math]::Max(0, [Math]::Min(8, $bits - 8 * $i))
        if ($take -eq 0) { break }
        $mask = (0xFF -shl (8 - $take)) -band 0xFF
        if (($a[$i] -band $mask) -ne ($b[$i] -band $mask)) { return $false }
    }
    return $true
}

function Test-Loopback([string]$Address) {
    $ip = [System.Net.IPAddress]::Parse($Address)
    return [System.Net.IPAddress]::IsLoopback($ip)
}

# Local network, link-local, multicast and broadcast: they do not leave for
# the internet, but they do leave the machine.
function Test-LocalNetwork([string]$Address) {
    foreach ($cidr in @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
            '169.254.0.0/16', '224.0.0.0/4', '255.255.255.255/32',
            'fe80::/10', 'fc00::/7', 'ff00::/8')) {
        if (Test-InCidr $Address $cidr) { return $true }
    }
    return $false
}

function Test-Cloudflare([string]$Address) {
    foreach ($cidr in $script:CloudflareRanges) {
        if (Test-InCidr $Address $cidr) { return $true }
    }
    return $false
}

function Test-NameIn([string]$Name, [string[]]$Suffixes) {
    if ([string]::IsNullOrEmpty($Name)) { return $false }
    $n = $Name.TrimEnd('.').ToLowerInvariant()
    foreach ($s in $Suffixes) {
        if ($n -eq $s -or $n.EndsWith(".$s")) { return $true }
    }
    return $false
}

# ---- Tor relays ------------------------------------------------------------

# Every relay address in $Text: Onionoo's summary document
# (https://onionoo.torproject.org/summary, "relays": [{"a": [...]}]) or one
# address per line ("#" starts a comment; a port is dropped).
function ConvertFrom-RelayList([string]$Text) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    $trimmed = $Text.TrimStart()
    if ($trimmed.StartsWith('{')) {
        $doc = $trimmed | ConvertFrom-Json
        foreach ($relay in @($doc.relays)) {
            foreach ($a in @($relay.a)) {
                $plain = ConvertTo-PlainAddress $a
                if ($plain) { [void]$set.Add($plain) }
            }
        }
    }
    else {
        foreach ($line in $Text -split "`r?`n") {
            $l = ($line -replace '#.*$', '').Trim()
            $plain = ConvertTo-PlainAddress $l
            if ($plain) { [void]$set.Add($plain) }
        }
    }
    return , $set
}

# ---- Events ----------------------------------------------------------------

# By DOM methods, not PowerShell's XML properties: those throw under
# strict mode for an element that is missing or empty.
function Get-SystemValue([xml]$Doc, [string]$Element, [string]$Attribute) {
    $node = $Doc.DocumentElement['System'][$Element]
    if ($null -eq $node) { return $null }
    if ($Attribute) { return $node.GetAttribute($Attribute) }
    return $node.InnerText
}

function Get-EventDataValue([xml]$Doc, [string]$Name) {
    $data = $Doc.DocumentElement['EventData']
    if ($null -eq $data) { return $null }
    foreach ($d in $data.ChildNodes) {
        if ($d -is [System.Xml.XmlElement] -and $d.GetAttribute('Name') -eq $Name) {
            return $d.InnerText
        }
    }
    return $null
}

# A 5156 or 5157 event, from its XML: who opened what.
function ConvertFrom-AuditEventXml([string]$Xml) {
    $doc = [xml]$Xml
    $app = [string](Get-EventDataValue $doc 'Application')
    $direction = switch (Get-EventDataValue $doc 'Direction') {
        '%%14592' { 'in' }
        '%%14593' { 'out' }
        default { 'unknown' }
    }
    $protocol = switch (Get-EventDataValue $doc 'Protocol') {
        '6' { 'TCP' }
        '17' { 'UDP' }
        '1' { 'ICMP' }
        '58' { 'ICMPv6' }
        default { [string]$_ }
    }
    [pscustomobject]@{
        EventId   = [int](Get-SystemValue $doc 'EventID')
        Time      = [datetime](Get-SystemValue $doc 'TimeCreated' 'SystemTime')
        ProcessId = [int](Get-EventDataValue $doc 'ProcessID')
        Process   = ($app -split '\\')[-1].ToLowerInvariant()
        Path      = $app
        Direction = $direction
        Protocol  = $protocol
        Local     = ConvertTo-PlainAddress (Get-EventDataValue $doc 'SourceAddress')
        Remote    = ConvertTo-PlainAddress (Get-EventDataValue $doc 'DestAddress')
        Port      = [int](Get-EventDataValue $doc 'DestPort')
    }
}

# The addresses in a DNS client event's QueryResults:
# "type:  5 name;::ffff:192.0.2.1;2001:db8::1;" (CNAMEs are skipped).
function Get-DnsResultAddresses([string]$Results) {
    $out = @()
    if ([string]::IsNullOrEmpty($Results)) { return , $out }
    foreach ($part in $Results.Split(';')) {
        $p = $part.Trim()
        if ($p -eq '' -or $p.StartsWith('type:')) { continue }
        $plain = ConvertTo-PlainAddress $p
        if ($plain) { $out += $plain }
    }
    return , $out
}

# A DNS client event (3006 asked, 3008 answered, 3020 a server's answer),
# from its XML: which process asked for which name, and what came back.
function ConvertFrom-DnsEventXml([string]$Xml) {
    $doc = [xml]$Xml
    [pscustomobject]@{
        EventId   = [int](Get-SystemValue $doc 'EventID')
        Time      = [datetime](Get-SystemValue $doc 'TimeCreated' 'SystemTime')
        ProcessId = [int](Get-SystemValue $doc 'Execution' 'ProcessID')
        Name      = ([string](Get-EventDataValue $doc 'QueryName')).TrimEnd('.').ToLowerInvariant()
        Addresses = Get-DnsResultAddresses (Get-EventDataValue $doc 'QueryResults')
    }
}

# ---- Verdicts --------------------------------------------------------------

# What a run is checked against.
function New-AuditContext {
    param(
        [string[]]$TrinoExe = @('TrinoChat.exe'),
        [string]$Transport = 'none',
        [string[]]$Bridge = @(),
        $Relays = $null,
        [int[]]$WebViewPids = $null,
        $Dns = @()
    )
    $bridges = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($b in $Bridge) {
        $plain = ConvertTo-PlainAddress $b
        if ($plain) { [void]$bridges.Add($plain) }
    }
    # Each address with the names the DNS log answered it for, by process.
    $names = @{}
    foreach ($q in @($Dns)) {
        foreach ($a in @($q.Addresses)) {
            $key = "$($q.ProcessId)|$a"
            if (-not $names.ContainsKey($key)) { $names[$key] = @() }
            if ($names[$key] -notcontains $q.Name) { $names[$key] += $q.Name }
            if (-not $names.ContainsKey("*|$a")) { $names["*|$a"] = @() }
            if ($names["*|$a"] -notcontains $q.Name) { $names["*|$a"] += $q.Name }
        }
    }
    [pscustomobject]@{
        Trino       = @($TrinoExe | ForEach-Object { $_.ToLowerInvariant() })
        Transport   = $Transport
        Bridges     = $bridges
        Relays      = $Relays
        WebViewPids = $WebViewPids
        Names       = $names
    }
}

function Get-NamesFor($Context, [int]$ProcessId, [string]$Address) {
    $key = "$ProcessId|$Address"
    if ($Context.Names.ContainsKey($key)) { return $Context.Names[$key] }
    if ($Context.Names.ContainsKey("*|$Address")) { return $Context.Names["*|$Address"] }
    return @()
}

function New-Verdict([string]$Verdict, [string]$Why) {
    [pscustomobject]@{ Verdict = $Verdict; Why = $Why }
}

# Whether a process is one this audit looks at, and as what.
function Get-Role($Context, $Event) {
    if ($Context.Trino -contains $Event.Process) { return 'trino' }
    if ($Event.Process -eq $script:Lyrebird) { return 'lyrebird' }
    if ($Event.Process -eq $script:WebView) {
        if ($null -eq $Context.WebViewPids -or $Context.WebViewPids -contains $Event.ProcessId) {
            return 'webview'
        }
    }
    return $null
}

# The verdict on one connection event (5156 or 5157).
function Get-ConnectionVerdict($Context, $Event) {
    $role = Get-Role $Context $Event
    $remote = $Event.Remote
    if ($null -eq $remote) { return New-Verdict 'REVIEW' 'no remote address in the event' }
    if (Test-Loopback $remote) { return New-Verdict 'OK' 'this machine (127.0.0.1: lyrebird or the app itself)' }
    if ($Event.EventId -eq 5157) {
        if ($role -eq 'webview') { return New-Verdict 'REVIEW' 'WebView2 tried this and the firewall blocked it' }
        # In the block-everything test these are expected, and every one
        # must be a Tor relay or the bridge.
        if ($Context.Bridges.Contains($remote)) { return New-Verdict 'FAIL' 'blocked by the firewall: the bridge' }
        if ($null -ne $Context.Relays -and $Context.Relays.Contains($remote)) {
            return New-Verdict 'FAIL' 'blocked by the firewall: a Tor relay'
        }
        return New-Verdict 'FAIL' 'blocked by the firewall: neither a Tor relay nor the bridge'
    }
    if ($Event.Direction -eq 'in') {
        if ($role -eq 'webview' -and (Test-LocalNetwork $remote)) {
            return New-Verdict 'REVIEW' 'WebView2 received from the local network'
        }
        return New-Verdict 'FAIL' 'accepted a connection from outside this machine'
    }
    $names = @(Get-NamesFor $Context $Event.ProcessId $remote)
    switch ($role) {
        'trino' {
            if ($Context.Bridges.Contains($remote)) { return New-Verdict 'OK' 'a bridge of this run' }
            if ($Context.Transport -ne 'none') {
                return New-Verdict 'FAIL' "Trino went out by itself while the $($Context.Transport) bridge was in use (it should talk only to lyrebird)"
            }
            if ($null -eq $Context.Relays) {
                return New-Verdict 'REVIEW' 'not checked: no -RelayList to tell a Tor relay'
            }
            if ($Context.Relays.Contains($remote)) { return New-Verdict 'OK' 'a Tor relay (guard or directory)' }
            return New-Verdict 'FAIL' 'Trino opened this directly: not a Tor relay nor a bridge'
        }
        'lyrebird' {
            if ($Context.Bridges.Contains($remote)) { return New-Verdict 'OK' 'the bridge' }
            switch ($Context.Transport) {
                'snowflake' { return New-Verdict 'OK' 'Snowflake: its broker, a STUN server or a volunteer' }
                'webtunnel' {
                    if ($names.Count -gt 0) { return New-Verdict 'OK' "WebTunnel's domain ($($names -join ', '))" }
                    return New-Verdict 'REVIEW' 'WebTunnel: an address the DNS log does not name'
                }
                'none' { return New-Verdict 'FAIL' 'lyrebird ran in a run without bridges' }
                default { return New-Verdict 'FAIL' "lyrebird went somewhere that is not the $($Context.Transport) bridge" }
            }
        }
        'webview' {
            foreach ($n in $names) {
                if (Test-NameIn $n $script:TurnNames) { return New-Verdict 'OK' "TURN of a call ($n): outside Tor by design" }
            }
            foreach ($n in $names) {
                if (Test-NameIn $n $script:MicrosoftSuffixes) { return New-Verdict 'KNOWN' "Microsoft ($n): WebView2's own, outside Trino (W1-W4)" }
            }
            if ($names.Count -eq 0 -and (Test-Cloudflare $remote) -and $script:TurnPorts -contains $Event.Port) {
                return New-Verdict 'OK' "a Cloudflare address on port $($Event.Port): TURN of a call, outside Tor by design"
            }
            if (Test-LocalNetwork $remote) { return New-Verdict 'REVIEW' 'WebView2 to the local network (mDNS or a LAN candidate?)' }
            if ($names.Count -gt 0) { return New-Verdict 'FAIL' "WebView2 went to $($names -join ', '): neither TURN nor Microsoft" }
            return New-Verdict 'FAIL' 'WebView2 went to an address that is neither TURN nor Microsoft'
        }
    }
    return $null
}

# The verdict on one DNS query of a process this audit looks at.
function Get-DnsVerdict($Context, $Query, [string]$Role) {
    switch ($Role) {
        'trino' { return New-Verdict 'FAIL' 'Trino resolved a name on this machine: through Tor, the exit resolves it' }
        'lyrebird' {
            if ($Context.Transport -in @('snowflake', 'webtunnel')) {
                return New-Verdict 'OK' "lyrebird looked up its $($Context.Transport) server"
            }
            return New-Verdict 'REVIEW' 'lyrebird looked up a name: obfs4 bridges are addresses'
        }
        'webview' {
            if (Test-NameIn $Query.Name $script:TurnNames) { return New-Verdict 'OK' 'TURN of a call: outside Tor by design' }
            if (Test-NameIn $Query.Name $script:MicrosoftSuffixes) { return New-Verdict 'KNOWN' "Microsoft: WebView2's own, outside Trino (W1-W4)" }
            return New-Verdict 'FAIL' 'WebView2 looked up a name that is neither TURN nor Microsoft'
        }
    }
    return $null
}

# One row per connection event this audit looks at.
function Get-ConnectionRows($Context, $Events) {
    foreach ($e in @($Events)) {
        $role = Get-Role $Context $e
        if (-not $role) { continue }
        $v = Get-ConnectionVerdict $Context $e
        [pscustomobject]@{
            Verdict = $v.Verdict; Process = $e.Process; ProcessId = $e.ProcessId
            Kind = "$($e.EventId) $($e.Direction) $($e.Protocol)"; Remote = $e.Remote
            Port = $e.Port; Name = (@(Get-NamesFor $Context $e.ProcessId $e.Remote) -join ', ')
            Why = $v.Why; Time = $e.Time
        }
    }
}

# One row per DNS query by a process this audit looks at. Its process is
# known by id: Trino's and lyrebird's ids come from their connection
# events, WebView2's from Watch.
function Get-DnsRows($Context, $Queries, $Pids) {
    foreach ($q in @($Queries)) {
        $role = $null
        if ($Pids.Trino -contains $q.ProcessId) { $role = 'trino' }
        elseif ($Pids.Lyrebird -contains $q.ProcessId) { $role = 'lyrebird' }
        elseif ($Pids.WebView -contains $q.ProcessId) { $role = 'webview' }
        if (-not $role) { continue }
        $v = Get-DnsVerdict $Context $q $role
        [pscustomobject]@{
            Verdict = $v.Verdict; Process = $role; ProcessId = $q.ProcessId
            Kind = "DNS $($q.EventId)"; Remote = ($q.Addresses -join ' ')
            Port = 53; Name = $q.Name; Why = $v.Why; Time = $q.Time
        }
    }
}

# Rows with the same verdict, process, destination and reason, counted.
function Group-AuditRows($Rows) {
    @($Rows) | Group-Object Verdict, Process, Kind, Remote, Port, Name, Why | ForEach-Object {
        $first = $_.Group[0]
        $times = @($_.Group | ForEach-Object { $_.Time } | Sort-Object)
        [pscustomobject]@{
            Verdict = $first.Verdict; Process = $first.Process; Kind = $first.Kind
            Remote = $first.Remote; Port = $first.Port; Name = $first.Name
            Count = $_.Count; First = $times[0]; Last = $times[-1]; Why = $first.Why
        }
    } | Sort-Object @{ Expression = { @('FAIL', 'REVIEW', 'KNOWN', 'OK').IndexOf($_.Verdict) } }, Process, Remote
}

# 0 with no FAIL, 1 with one, 2 when the evidence is incomplete.
function Get-ReportExitCode($Rows, [bool]$Incomplete) {
    if (@($Rows | Where-Object { $_.Verdict -eq 'FAIL' }).Count -gt 0) { return 1 }
    if ($Incomplete) { return 2 }
    return 0
}

# ---- The firewall's allow-list variant -------------------------------------

# An IPv4 address as a number, and back (in 64 bits: no sign to trip on).
function ConvertTo-AddressNumber([string]$Address) {
    $b = [System.Net.IPAddress]::Parse($Address).GetAddressBytes()
    if ($b.Length -ne 4) { throw "audit-tor: $Address is not an IPv4 address." }
    return [uint64]$b[0] * 16777216 + [uint64]$b[1] * 65536 + [uint64]$b[2] * 256 + [uint64]$b[3]
}

function ConvertFrom-AddressNumber([uint64]$Value) {
    $octets = foreach ($shift in 16777216, 65536, 256, 1) {
        [uint64][Math]::Floor($Value / $shift) % 256
    }
    return $octets -join '.'
}

# Every IPv4 address but 127.0.0.0/8 and $Allowed, as firewall ranges.
function Get-Ipv4BlockRanges([string[]]$Allowed = @()) {
    $holes = @([pscustomobject]@{ From = [uint64]2130706432; To = [uint64]2147483647 })
    foreach ($a in $Allowed) {
        $v = ConvertTo-AddressNumber $a
        $holes += [pscustomobject]@{ From = $v; To = $v }
    }
    $ranges = @()
    [uint64]$next = 0
    foreach ($h in @($holes | Sort-Object From)) {
        if ($h.From -gt $next) {
            $ranges += '{0}-{1}' -f (ConvertFrom-AddressNumber $next), (ConvertFrom-AddressNumber ($h.From - 1))
        }
        if ($h.To + 1 -gt $next) { $next = $h.To + 1 }
    }
    if ($next -le [uint64]4294967295) {
        $ranges += '{0}-255.255.255.255' -f (ConvertFrom-AddressNumber $next)
    }
    return , $ranges
}

# Every IPv6 address but ::1.
$script:Ipv6BlockRanges = @('::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')

# The two block rules of the variant: Trino only to this machine, lyrebird
# only to the test bridge (without one, nowhere: Tor cannot connect, which
# is the separate test of the "could not connect" screen).
function Get-AllowListRules([string]$TrinoPath, [string]$LyrebirdPath, [string]$BridgeAddress) {
    $bridge = @()
    if ($BridgeAddress) { $bridge = @($BridgeAddress) }
    # Assigned first: each call returns its array as one object.
    [string[]]$trino = Get-Ipv4BlockRanges @()
    [string[]]$lyrebird = Get-Ipv4BlockRanges $bridge
    $lyrebirdTo = 'nowhere'
    if ($BridgeAddress) { $lyrebirdTo = "only to $BridgeAddress" }
    @(
        [pscustomobject]@{
            Name          = 'Trino audit: TrinoChat.exe only to this machine'
            Program       = $TrinoPath
            RemoteAddress = $trino + $script:Ipv6BlockRanges
        },
        [pscustomobject]@{
            Name          = "Trino audit: lyrebird.exe $lyrebirdTo"
            Program       = $LyrebirdPath
            RemoteAddress = $lyrebird + $script:Ipv6BlockRanges
        }
    )
}

# ---- Plans: what each action changes, and its undo -------------------------

function Get-StartPlan([string]$StateDir) {
    $backup = Join-Path $StateDir 'auditpol-before.csv'
    @(
        [pscustomobject]@{
            What = 'Save the whole audit policy as it is now'
            Do   = "auditpol /backup /file:`"$backup`""
            Undo = '(nothing: it only writes that file)'
        },
        [pscustomobject]@{
            What = 'Audit filtering-platform connections, allowed and blocked (events 5156 and 5157)'
            Do   = "auditpol /set /subcategory:`"$script:WfpConnectionGuid`" /success:enable /failure:enable"
            Undo = "auditpol /restore /file:`"$backup`""
        },
        [pscustomobject]@{
            What = "Security log maximum size to at least $($script:SecurityLogBytes / 1MB) MB, so the walkthrough fits"
            Do   = "wevtutil sl Security /ms:$($script:SecurityLogBytes)"
            Undo = 'wevtutil sl Security /ms:<the size it had, saved in state.json>'
        },
        [pscustomobject]@{
            What = 'Turn on the DNS client log, at least 128 MB'
            Do   = "wevtutil sl $($script:DnsLog) /e:true /ms:$($script:DnsLogBytes)"
            Undo = "wevtutil sl $($script:DnsLog) /e:<as it was> /ms:<as it was>"
        }
    )
}

function Get-AllowListPlan($Rules) {
    foreach ($r in $Rules) {
        [pscustomobject]@{
            What = "$($r.Name) (block, outbound)"
            Do   = "New-NetFirewallRule -Group '$script:FirewallGroup' -DisplayName '$($r.Name)' -Direction Outbound -Action Block -Program '$($r.Program)' -RemoteAddress $($r.RemoteAddress -join ',')"
            Undo = "Remove-NetFirewallRule -Group '$script:FirewallGroup'"
        }
    }
}

function Get-StopPlan($State, [string]$StateDir) {
    $backup = Join-Path $StateDir 'auditpol-before.csv'
    $plan = @()
    if ($State) {
        $plan += [pscustomobject]@{ What = 'The audit policy as it was before Start'; Do = "auditpol /restore /file:`"$backup`""; Undo = '-' }
        $plan += [pscustomobject]@{ What = 'The Security log size as it was'; Do = "wevtutil sl Security /ms:$($State.SecurityMaxSize)"; Undo = '-' }
        $plan += [pscustomobject]@{ What = 'The DNS client log as it was'; Do = "wevtutil sl $($script:DnsLog) /e:$($State.DnsEnabled.ToString().ToLowerInvariant()) /ms:$($State.DnsMaxSize)"; Undo = '-' }
    }
    else {
        # Without Start's record, the usual Windows default: no auditing.
        $plan += [pscustomobject]@{ What = 'No record of Start: filtering-platform connections back to not audited'; Do = "auditpol /set /subcategory:`"$script:WfpConnectionGuid`" /success:disable /failure:disable"; Undo = '-' }
    }
    $plan += [pscustomobject]@{ What = 'Remove the allow-list rules, if any'; Do = "Remove-NetFirewallRule -Group '$script:FirewallGroup'"; Undo = '-' }
    return $plan
}

# ---- What touches Windows --------------------------------------------------

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator([string]$Why) {
    if (-not (Test-Administrator)) {
        throw "audit-tor: $Why needs an administrator. Open PowerShell as administrator and run it again."
    }
}

function Show-Plan([string]$Title, $Plan) {
    Write-Host ''
    Write-Host $Title
    $i = 1
    foreach ($p in $Plan) {
        Write-Host ("  {0}. {1}" -f $i, $p.What)
        Write-Host ("     runs: {0}" -f $p.Do)
        if ($p.Undo -ne '-') { Write-Host ("     undo: {0}" -f $p.Undo) }
        $i++
    }
}

# Only "yes", typed, goes on.
function Confirm-Changes {
    $answer = Read-Host 'Type yes to apply exactly these changes (anything else cancels)'
    if ($answer -ne 'yes') {
        Write-Host 'Cancelled: nothing was changed.'
        return $false
    }
    return $true
}

function Get-LogSetting([string]$Log, [string]$Key) {
    $out = & wevtutil gl $Log
    foreach ($line in $out) {
        if ($line -match "^\s*${Key}:\s*(\S+)") { return $Matches[1] }
    }
    return $null
}

function Invoke-Native([string]$CommandLine) {
    Write-Host "  > $CommandLine"
    $output = & cmd.exe /d /c $CommandLine 2>&1
    if ($LASTEXITCODE -ne 0) { throw "audit-tor: failed ($LASTEXITCODE): $CommandLine`n$output" }
}

function Read-State([string]$StateDir) {
    $path = Join-Path $StateDir 'state.json'
    if (-not (Test-Path $path)) { return $null }
    return Get-Content $path -Raw | ConvertFrom-Json
}

function Invoke-Start {
    Assert-Administrator 'Start'
    if (Read-State $StateDir) {
        throw "audit-tor: a run is already started ($StateDir\state.json). Run -Action Stop first."
    }
    $plan = Get-StartPlan $StateDir
    Show-Plan 'Start will change these Windows settings:' $plan
    if (-not (Confirm-Changes)) { return }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $state = [pscustomobject]@{
        Started         = (Get-Date).ToUniversalTime().ToString('o')
        SecurityMaxSize = [int64](Get-LogSetting 'Security' 'maxSize')
        DnsEnabled      = ((Get-LogSetting $script:DnsLog 'enabled') -eq 'true')
        DnsMaxSize      = [int64](Get-LogSetting $script:DnsLog 'maxSize')
    }
    # Saved before the first change, so Stop can always undo.
    $state | ConvertTo-Json | Set-Content -Path (Join-Path $StateDir 'state.json') -Encoding UTF8
    Invoke-Native $plan[0].Do
    Invoke-Native $plan[1].Do
    if ($state.SecurityMaxSize -lt $script:SecurityLogBytes) { Invoke-Native $plan[2].Do }
    $dnsSize = [Math]::Max($state.DnsMaxSize, $script:DnsLogBytes)
    Invoke-Native "wevtutil sl $($script:DnsLog) /e:true /ms:$dnsSize"
    Write-Host ''
    Write-Host "Started at $($state.Started) (UTC). Now open Trino and do the walkthroughs (docs/audit-tor.md)."
    Write-Host 'In another window, as yourself: .\scripts\audit-tor.ps1 -Action Watch'
    Write-Host 'Afterwards: -Action Report, then -Action Stop to undo all of this.'
}

function Invoke-Stop {
    Assert-Administrator 'Stop'
    $state = Read-State $StateDir
    $plan = Get-StopPlan $state $StateDir
    Show-Plan 'Stop will put back these Windows settings:' $plan
    if (-not (Confirm-Changes)) { return }
    # Every step is tried, so one that fails does not leave the rest as
    # they were.
    $failed = @()
    foreach ($p in $plan) {
        try {
            if ($p.Do.StartsWith('Remove-NetFirewallRule')) {
                Write-Host "  > $($p.Do)"
                Get-NetFirewallRule -Group $script:FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            }
            else {
                Invoke-Native $p.Do
            }
        }
        catch {
            $failed += $p.Do
            Write-Warning $_.Exception.Message
        }
    }
    if ($failed.Count -gt 0) {
        Write-Warning "Not undone; run these by hand, as administrator:`n  $($failed -join "`n  ")"
        return
    }
    if ($state) {
        Remove-Item (Join-Path $StateDir 'state.json')
        Write-Host "Undone. The backup and Watch's file stay in $StateDir; delete the folder when you no longer need them."
    }
}

function Invoke-AllowList {
    Assert-Administrator 'AllowList'
    $lyrebird = $LyrebirdPath
    if (-not $lyrebird) { $lyrebird = Join-Path (Split-Path $TrinoPath) 'lyrebird.exe' }
    foreach ($p in @($TrinoPath, $lyrebird)) {
        if (-not (Test-Path $p)) { throw "audit-tor: $p does not exist; pass -TrinoPath (and -LyrebirdPath)." }
    }
    if ($BridgeAddress -and -not ([System.Net.IPAddress]::Parse($BridgeAddress).AddressFamily -eq 'InterNetwork')) {
        throw 'audit-tor: -BridgeAddress takes an IPv4 address.'
    }
    $off = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled })
    if ($off.Count -gt 0) {
        Write-Warning "The firewall is off for: $($off.Name -join ', '). Its rules do nothing there."
    }
    $rules = Get-AllowListRules $TrinoPath $lyrebird $BridgeAddress
    Show-Plan 'AllowList will add these firewall rules:' (Get-AllowListPlan $rules)
    if (-not (Confirm-Changes)) { return }
    foreach ($r in $rules) {
        New-NetFirewallRule -Group $script:FirewallGroup -DisplayName $r.Name -Direction Outbound `
            -Action Block -Program $r.Program -RemoteAddress $r.RemoteAddress | Out-Null
        Write-Host "  added: $($r.Name)"
    }
    Write-Host 'Remove them with -Action Stop.'
}

# The process ids of Trino and of everything under it (its WebView2).
function Invoke-Watch {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $file = Join-Path $StateDir 'pids.json'
    $seen = @{}
    if (Test-Path $file) {
        foreach ($p in @(Get-Content $file -Raw | ConvertFrom-Json)) { $seen["$($p.Id)"] = $p }
    }
    $names = @($TrinoExe | ForEach-Object { $_.ToLowerInvariant() })
    Write-Host "Writing the process ids of $($TrinoExe -join ', ') and its children to $file. Ctrl+C ends."
    while ($true) {
        $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
        $roots = @($all | Where-Object { $names -contains $_.Name.ToLowerInvariant() } | ForEach-Object { $_.ProcessId })
        $tree = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($r in $roots) { [void]$tree.Add([int]$r) }
        do {
            $grew = $false
            foreach ($p in $all) {
                if ($tree.Contains([int]$p.ParentProcessId) -and $tree.Add([int]$p.ProcessId)) { $grew = $true }
            }
        } while ($grew)
        foreach ($p in $all) {
            if ($tree.Contains([int]$p.ProcessId) -and -not $seen.ContainsKey("$($p.ProcessId)")) {
                $seen["$($p.ProcessId)"] = [pscustomobject]@{ Id = [int]$p.ProcessId; Name = $p.Name; Since = (Get-Date).ToUniversalTime().ToString('o') }
                Write-Host "  $($p.Name) $($p.ProcessId)"
            }
        }
        @($seen.Values) | ConvertTo-Json | Set-Content -Path $file -Encoding UTF8
        Start-Sleep -Seconds 2
    }
}

function Get-EventsOrNone([hashtable]$Filter) {
    try { return @(Get-WinEvent -FilterHashtable $Filter -ErrorAction Stop) }
    catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @() } throw }
}

function Invoke-Report {
    Assert-Administrator 'Report (the Security log)'
    $state = Read-State $StateDir
    # An unbound [datetime] parameter is DateTime.MinValue.
    $from = $Since
    if ($null -eq $from -or $from -eq [datetime]::MinValue) {
        if (-not $state) { throw 'audit-tor: no run started; pass -Since.' }
        $from = [datetime]::Parse($state.Started).ToLocalTime()
    }
    $to = $Until
    if ($null -eq $to -or $to -eq [datetime]::MinValue) { $to = Get-Date }
    $incomplete = $false

    $relays = $null
    if ($RelayList) { $relays = ConvertFrom-RelayList (Get-Content $RelayList -Raw) }
    else { Write-Warning 'No -RelayList: TrinoChat.exe connections are REVIEW, not checked against Tor relays.'; $incomplete = $true }

    $webViewPids = $null
    $watchedPids = @()
    $pidsFile = Join-Path $StateDir 'pids.json'
    if (Test-Path $pidsFile) {
        $watchedPids = @(Get-Content $pidsFile -Raw | ConvertFrom-Json)
        $webViewPids = @($watchedPids | Where-Object { $_.Name -eq $script:WebView } | ForEach-Object { [int]$_.Id })
    }
    else {
        Write-Warning 'No Watch file: every WebView2 on this machine counts, also other programs''.'
        $incomplete = $true
    }

    $oldest = Get-WinEvent -LogName Security -MaxEvents 1 -Oldest
    if ($oldest.TimeCreated -gt $from) {
        Write-Warning "The Security log starts at $($oldest.TimeCreated): events of the run were overwritten."
        $incomplete = $true
    }

    $watched = @($TrinoExe | ForEach-Object { $_.ToLowerInvariant() }) + @($script:Lyrebird, $script:WebView)
    $connections = foreach ($e in (Get-EventsOrNone @{ LogName = 'Security'; Id = 5156, 5157; StartTime = $from; EndTime = $to })) {
        $leaf = ([string]$e.Properties[1].Value -split '\\')[-1].ToLowerInvariant()
        if ($watched -contains $leaf) { ConvertFrom-AuditEventXml $e.ToXml() }
    }
    $queries = foreach ($e in (Get-EventsOrNone @{ LogName = $script:DnsLog; Id = 3006, 3008, 3020; StartTime = $from; EndTime = $to })) {
        ConvertFrom-DnsEventXml $e.ToXml()
    }
    $context = New-AuditContext -TrinoExe $TrinoExe -Transport $Transport -Bridge $Bridge -Relays $relays -WebViewPids $webViewPids -Dns @($queries)
    # Whose DNS queries count: the ids seen in the connection events, and
    # those Watch wrote down.
    $named = @($watchedPids | ForEach-Object { [pscustomobject]@{ Process = ([string]$_.Name).ToLowerInvariant(); ProcessId = [int]$_.Id } }) + @($connections)
    $pids = [pscustomobject]@{
        Trino    = @($named | Where-Object { $context.Trino -contains $_.Process } | ForEach-Object { $_.ProcessId } | Sort-Object -Unique)
        Lyrebird = @($named | Where-Object { $_.Process -eq $script:Lyrebird } | ForEach-Object { $_.ProcessId } | Sort-Object -Unique)
        WebView  = @($webViewPids)
    }
    if ($pids.Trino.Count -eq 0) {
        Write-Warning "No connection of $($TrinoExe -join ', ') in the run: was Trino open, and is that its name (-TrinoExe)?"
        $incomplete = $true
    }
    $rows = @(Get-ConnectionRows $context $connections) + @(Get-DnsRows $context $queries $pids)
    $grouped = @(Group-AuditRows $rows)
    $grouped | Format-Table Verdict, Process, Kind, Remote, Port, Name, Count, Why -AutoSize -Wrap | Out-Host
    if ($OutCsv) { $rows | Export-Csv -Path $OutCsv -NoTypeInformation -Encoding UTF8 }
    foreach ($v in @('FAIL', 'REVIEW', 'KNOWN', 'OK')) {
        Write-Host ("{0,-7}{1}" -f $v, @($rows | Where-Object { $_.Verdict -eq $v }).Count)
    }
    Write-Host "Run: $from to $to. Transport: $Transport."
    exit (Get-ReportExitCode $rows $incomplete)
}

function Invoke-Plan {
    Show-Plan 'Start would change:' (Get-StartPlan $StateDir)
    $lyrebird = $LyrebirdPath
    if (-not $lyrebird) { $lyrebird = Join-Path (Split-Path $TrinoPath) 'lyrebird.exe' }
    $bridge = 'none given (-BridgeAddress): the block-everything variant'
    if ($BridgeAddress) { $bridge = $BridgeAddress }
    Show-Plan "AllowList would add (test bridge: $bridge):" (Get-AllowListPlan (Get-AllowListRules $TrinoPath $lyrebird $BridgeAddress))
    Show-Plan 'Stop would put back:' (Get-StopPlan (Read-State $StateDir) $StateDir)
    Write-Host ''
    Write-Host 'Nothing was changed. Each action asks before it changes anything; see docs/audit-tor.md.'
}

# Dot-sourced (the tests), it only defines the functions above.
if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        'Plan' { Invoke-Plan }
        'Start' { Invoke-Start }
        'Watch' { Invoke-Watch }
        'Report' { Invoke-Report }
        'AllowList' { Invoke-AllowList }
        'Stop' { Invoke-Stop }
    }
}
