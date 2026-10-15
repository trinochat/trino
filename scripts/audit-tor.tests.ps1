# Tests of scripts/audit-tor.ps1 that change nothing: they read sample
# events (the XML Windows gives for 5156, 5157 and the DNS client log) and
# never touch the audit policy, the logs or the firewall. No module needed
# (Pester is not assumed); runs in Windows PowerShell 5.1 and PowerShell 7:
#
#   pwsh -NoProfile -File scripts/audit-tor.tests.ps1
#
# Exit code 0 when every test passes.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'audit-tor.ps1')

$script:Passed = 0
$script:Failed = @()

function Test([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:Passed++
        Write-Host "ok    $Name"
    }
    catch {
        $script:Failed += $Name
        Write-Host "FAIL  $Name"
        Write-Host "      $($_.Exception.Message)"
    }
}

function Assert-Equal($Expected, $Actual, [string]$What = '') {
    $e = ($Expected | ForEach-Object { "$_" }) -join ', '
    $a = ($Actual | ForEach-Object { "$_" }) -join ', '
    if ($e -ne $a) { throw "$What expected [$e], got [$a]" }
}

function Assert-True($Condition, [string]$What) {
    if (-not $Condition) { throw "expected: $What" }
}

# ---- Sample events, as Get-WinEvent's ToXml() gives them --------------------

$TrinoPath = '\device\harddiskvolume3\users\ana\appdata\local\trino chat\trinochat.exe'
$LyrebirdPath = '\device\harddiskvolume3\users\ana\appdata\local\trino chat\lyrebird.exe'
$WebViewPath = '\device\harddiskvolume3\program files (x86)\microsoft\edgewebview\application\155.0.4283.45\msedgewebview2.exe'

function New-WfpXml {
    param(
        [int]$Id = 5156, [int]$ProcessId = 4100, [string]$Application = $TrinoPath,
        [string]$Direction = '%%14593', [string]$Dest = '198.51.100.7', [int]$Port = 9001,
        [int]$Protocol = 6, [string]$Time = '2026-10-15T20:01:02.1234567Z'
    )
    @"
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing' Guid='{54849625-5478-4994-a5ba-3e3b0328c30d}'/><EventID>$Id</EventID><Version>1</Version><Level>0</Level><Task>12810</Task><Opcode>0</Opcode><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='$Time'/><EventRecordID>81234</EventRecordID><Correlation/><Execution ProcessID='4' ThreadID='9876'/><Channel>Security</Channel><Computer>PC-ANA</Computer><Security/></System><EventData><Data Name='ProcessID'>$ProcessId</Data><Data Name='Application'>$Application</Data><Data Name='Direction'>$Direction</Data><Data Name='SourceAddress'>192.168.1.10</Data><Data Name='SourcePort'>50123</Data><Data Name='DestAddress'>$Dest</Data><Data Name='DestPort'>$Port</Data><Data Name='Protocol'>$Protocol</Data><Data Name='FilterRTID'>0</Data><Data Name='LayerName'>%%14611</Data><Data Name='LayerRTID'>48</Data><Data Name='RemoteUserID'>S-1-0-0</Data><Data Name='RemoteMachineID'>S-1-0-0</Data></EventData></Event>
"@
}

function New-DnsXml {
    param(
        [int]$Id = 3008, [int]$ProcessId = 5200, [string]$Name = 'turn.cloudflare.com',
        [string]$Results = 'type:  5 turn.cloudflare.com.cdn.cloudflare.net;::ffff:203.0.113.20;'
    )
    @"
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/><EventID>$Id</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords><TimeCreated SystemTime='2026-10-15T20:01:01.0000000Z'/><EventRecordID>5501</EventRecordID><Correlation/><Execution ProcessID='$ProcessId' ThreadID='7777'/><Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>PC-ANA</Computer><Security UserID='S-1-5-21-1-2-3-1001'/></System><EventData><Data Name='QueryName'>$Name</Data><Data Name='QueryType'>1</Data><Data Name='QueryOptions'>140737488355328</Data><Data Name='QueryStatus'>0</Data><Data Name='QueryResults'>$Results</Data></EventData></Event>
"@
}

function Context {
    param([string]$Transport = 'none', [string[]]$Bridge = @(), [string]$Relays = "198.51.100.7`n2001:db8::7", $WebViewPids = @(5200), $Dns = @())
    $set = $null
    if ($Relays) { $set = ConvertFrom-RelayList $Relays }
    New-AuditContext -TrinoExe @('TrinoChat.exe') -Transport $Transport -Bridge $Bridge -Relays $set -WebViewPids $WebViewPids -Dns $Dns
}

function Verdict($Context, [string]$Xml) {
    Get-ConnectionVerdict $Context (ConvertFrom-AuditEventXml $Xml)
}

# ---- Parsing ----------------------------------------------------------------

Test 'a 5156 event says who opened what' {
    $e = ConvertFrom-AuditEventXml (New-WfpXml)
    Assert-Equal 5156 $e.EventId 'event'
    Assert-Equal 4100 $e.ProcessId 'process id'
    Assert-Equal 'trinochat.exe' $e.Process 'process'
    Assert-Equal 'out' $e.Direction 'direction'
    Assert-Equal 'TCP' $e.Protocol 'protocol'
    Assert-Equal '198.51.100.7' $e.Remote 'remote'
    Assert-Equal 9001 $e.Port 'port'
    Assert-Equal '192.168.1.10' $e.Local 'local'
}

Test 'inbound, UDP and an IPv4-mapped address are read as such' {
    $e = ConvertFrom-AuditEventXml (New-WfpXml -Direction '%%14592' -Protocol 17 -Dest '::ffff:203.0.113.9')
    Assert-Equal 'in' $e.Direction
    Assert-Equal 'UDP' $e.Protocol
    Assert-Equal '203.0.113.9' $e.Remote
}

Test 'addresses come out in one form' {
    Assert-Equal '192.0.2.1' (ConvertTo-PlainAddress '::ffff:192.0.2.1')
    Assert-Equal '2001:db8::1' (ConvertTo-PlainAddress '[2001:db8:0::1]')
    Assert-Equal '2001:db8::1' (ConvertTo-PlainAddress '[2001:db8::1]:443')
    Assert-Equal '192.0.2.1' (ConvertTo-PlainAddress '192.0.2.1:9001')
    Assert-True ($null -eq (ConvertTo-PlainAddress '1')) 'a bare number is not an address'
    Assert-True ($null -eq (ConvertTo-PlainAddress 'type:  5 a.example')) 'a CNAME is not an address'
}

Test 'a DNS event says which process asked for which name and what came back' {
    $q = ConvertFrom-DnsEventXml (New-DnsXml -Results 'type:  5 turn.cloudflare.com.cdn.cloudflare.net;::ffff:203.0.113.20;2001:db8::20;')
    Assert-Equal 3008 $q.EventId
    Assert-Equal 5200 $q.ProcessId
    Assert-Equal 'turn.cloudflare.com' $q.Name
    Assert-Equal @('203.0.113.20', '2001:db8::20') $q.Addresses
}

Test 'a DNS question without an answer has no addresses' {
    $q = ConvertFrom-DnsEventXml (New-DnsXml -Id 3006 -Results '')
    Assert-Equal 0 @($q.Addresses).Count
}

Test 'a relay list is read from Onionoo or from plain lines' {
    $onionoo = '{"version":"8.0","relays":[{"n":"a","f":"AAAA","a":["198.51.100.7","[2001:db8::7]"],"r":true},{"n":"b","f":"BBBB","a":["203.0.113.70"],"r":false}],"bridges":[]}'
    $set = ConvertFrom-RelayList $onionoo
    Assert-Equal 3 $set.Count 'relays'
    Assert-True ($set.Contains('2001:db8::7')) 'the IPv6 address without brackets'
    $lines = ConvertFrom-RelayList "# today's consensus`n198.51.100.7:9001`n`n203.0.113.70 # a guard`n"
    Assert-Equal 2 $lines.Count 'lines'
    Assert-True ($lines.Contains('198.51.100.7')) 'the port is dropped'
}

# ---- Verdicts: Trino --------------------------------------------------------

Test 'Trino to a Tor relay is OK' {
    Assert-Equal 'OK' (Verdict (Context) (New-WfpXml)).Verdict
    Assert-Equal 'OK' (Verdict (Context) (New-WfpXml -Dest '2001:db8::7')).Verdict
}

Test 'Trino to anything else is a FAIL' {
    $v = Verdict (Context) (New-WfpXml -Dest '203.0.113.99' -Port 443)
    Assert-Equal 'FAIL' $v.Verdict
}

Test 'Trino to the local network is a FAIL too' {
    Assert-Equal 'FAIL' (Verdict (Context) (New-WfpXml -Dest '192.168.1.1' -Port 53 -Protocol 17)).Verdict
}

Test 'Trino to this machine is OK' {
    Assert-Equal 'OK' (Verdict (Context -Transport obfs4) (New-WfpXml -Dest '127.0.0.1' -Port 49801)).Verdict
    Assert-Equal 'OK' (Verdict (Context) (New-WfpXml -Dest '::1' -Port 49801)).Verdict
}

Test 'without a relay list Trino is not passed, only left to review' {
    Assert-Equal 'REVIEW' (Verdict (Context -Relays '') (New-WfpXml)).Verdict
}

Test 'with a bridge, Trino reaching a Tor relay by itself is a FAIL' {
    $v = Verdict (Context -Transport obfs4 -Bridge '192.0.2.10') (New-WfpXml)
    Assert-Equal 'FAIL' $v.Verdict
}

Test 'a connection the firewall blocked is a FAIL for Trino, which says where it went' {
    $relay = Verdict (Context) (New-WfpXml -Id 5157)
    Assert-Equal 'FAIL' $relay.Verdict
    Assert-Equal 'blocked by the firewall: a Tor relay' $relay.Why
    $other = Verdict (Context) (New-WfpXml -Id 5157 -Dest '203.0.113.99')
    Assert-Equal 'blocked by the firewall: neither a Tor relay nor the bridge' $other.Why
}

Test 'Trino accepting a connection from outside is a FAIL' {
    Assert-Equal 'FAIL' (Verdict (Context) (New-WfpXml -Direction '%%14592' -Dest '203.0.113.5')).Verdict
}

Test 'a renamed test exe counts as Trino' {
    $ctx = New-AuditContext -TrinoExe @('TrinoChat.exe', 'prueba-tor-c0b26b2.exe') -Relays (ConvertFrom-RelayList '198.51.100.7')
    $e = ConvertFrom-AuditEventXml (New-WfpXml -Application '\device\harddiskvolume3\users\ana\desktop\prueba-tor-c0b26b2.exe' -Dest '203.0.113.99')
    Assert-Equal 'FAIL' (Get-ConnectionVerdict $ctx $e).Verdict
}

# ---- Verdicts: lyrebird -----------------------------------------------------

Test 'lyrebird to the obfs4 bridge is OK, anywhere else a FAIL' {
    $ctx = Context -Transport obfs4 -Bridge '192.0.2.10:443'
    Assert-Equal 'OK' (Verdict $ctx (New-WfpXml -Application $LyrebirdPath -ProcessId 4200 -Dest '192.0.2.10' -Port 443)).Verdict
    Assert-Equal 'FAIL' (Verdict $ctx (New-WfpXml -Application $LyrebirdPath -ProcessId 4200 -Dest '203.0.113.99' -Port 443)).Verdict
}

Test 'lyrebird with Snowflake may reach its broker, STUN and volunteers' {
    Assert-Equal 'OK' (Verdict (Context -Transport snowflake) (New-WfpXml -Application $LyrebirdPath -Dest '203.0.113.99' -Port 3478 -Protocol 17)).Verdict
}

Test 'lyrebird with WebTunnel may reach the domain it looked up' {
    $dns = @(ConvertFrom-DnsEventXml (New-DnsXml -ProcessId 4200 -Name 'wt.example.org' -Results '::ffff:203.0.113.44;'))
    $ctx = Context -Transport webtunnel -Dns $dns
    Assert-Equal 'OK' (Verdict $ctx (New-WfpXml -Application $LyrebirdPath -ProcessId 4200 -Dest '203.0.113.44' -Port 443)).Verdict
    Assert-Equal 'REVIEW' (Verdict $ctx (New-WfpXml -Application $LyrebirdPath -ProcessId 4200 -Dest '203.0.113.45' -Port 443)).Verdict
}

Test 'lyrebird in a run without bridges is a FAIL' {
    Assert-Equal 'FAIL' (Verdict (Context) (New-WfpXml -Application $LyrebirdPath -Dest '192.0.2.10')).Verdict
}

# ---- Verdicts: WebView2 -----------------------------------------------------

Test 'WebView2 to the TURN address the DNS log named is OK' {
    $dns = @(ConvertFrom-DnsEventXml (New-DnsXml))
    $ctx = Context -Dns $dns
    $v = Verdict $ctx (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '203.0.113.20' -Port 3478 -Protocol 17)
    Assert-Equal 'OK' $v.Verdict
    Assert-True ($v.Why -like '*turn.cloudflare.com*') 'it says which name'
}

Test 'WebView2 to a Cloudflare address on a TURN port is OK without the DNS log' {
    Assert-Equal 'OK' (Verdict (Context) (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '162.159.207.1' -Port 3478 -Protocol 17)).Verdict
    Assert-Equal 'FAIL' (Verdict (Context) (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '162.159.207.1' -Port 8080)).Verdict
}

Test 'WebView2 to Microsoft is KNOWN, not OK' {
    $dns = @(
        (ConvertFrom-DnsEventXml (New-DnsXml -Name 'config.edge.skype.com.trafficmanager.net' -Results '::ffff:203.0.113.30;')),
        (ConvertFrom-DnsEventXml (New-DnsXml -Name 'edge.microsoft.com' -Results '::ffff:203.0.113.31;'))
    )
    $ctx = Context -Dns $dns
    Assert-Equal 'KNOWN' (Verdict $ctx (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '203.0.113.31' -Port 443)).Verdict
    Assert-Equal 'KNOWN' (Verdict $ctx (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '203.0.113.30' -Port 443)).Verdict
}

Test 'WebView2 to a name a message could have planted is a FAIL' {
    $dns = @(ConvertFrom-DnsEventXml (New-DnsXml -Name 'tracker.example.net' -Results '::ffff:203.0.113.66;'))
    $v = Verdict (Context -Dns $dns) (New-WfpXml -Application $WebViewPath -ProcessId 5200 -Dest '203.0.113.66' -Port 443)
    Assert-Equal 'FAIL' $v.Verdict
    Assert-True ($v.Why -like '*tracker.example.net*') 'it says which name'
}

Test "another program's WebView2 is left out once Watch knows Trino's" {
    $e = ConvertFrom-AuditEventXml (New-WfpXml -Application $WebViewPath -ProcessId 9999 -Dest '203.0.113.66')
    Assert-True ($null -eq (Get-Role (Context) $e)) 'not looked at'
    Assert-Equal 'webview' (Get-Role (Context -WebViewPids $null) $e) 'without Watch, every WebView2 counts'
}

Test 'programs other than Trino, lyrebird and WebView2 are not reported' {
    $e = ConvertFrom-AuditEventXml (New-WfpXml -Application '\device\harddiskvolume3\windows\system32\svchost.exe')
    Assert-Equal 0 @(Get-ConnectionRows (Context) @($e)).Count
}

# ---- Verdicts: DNS ----------------------------------------------------------

Test 'Trino resolving a name on this machine is a FAIL' {
    $q = ConvertFrom-DnsEventXml (New-DnsXml -ProcessId 4100 -Name 'nos.lol' -Results '::ffff:203.0.113.80;')
    $pids = [pscustomobject]@{ Trino = @(4100); Lyrebird = @(); WebView = @(5200) }
    $rows = @(Get-DnsRows (Context) @($q) $pids)
    Assert-Equal 1 $rows.Count
    Assert-Equal 'FAIL' $rows[0].Verdict
    Assert-Equal 'nos.lol' $rows[0].Name
}

Test "WebView2's DNS: TURN OK, Microsoft KNOWN, anything else FAIL" {
    $pids = [pscustomobject]@{ Trino = @(4100); Lyrebird = @(); WebView = @(5200) }
    $qs = @('turn.cloudflare.com', 'smartscreen.microsoft.com', 'example.org') | ForEach-Object {
        ConvertFrom-DnsEventXml (New-DnsXml -Name $_ -Results '')
    }
    Assert-Equal @('OK', 'KNOWN', 'FAIL') @(Get-DnsRows (Context) $qs $pids | ForEach-Object { $_.Verdict })
}

Test "lyrebird's DNS is OK with Snowflake and left to review with obfs4" {
    $pids = [pscustomobject]@{ Trino = @(); Lyrebird = @(4200); WebView = @() }
    $q = ConvertFrom-DnsEventXml (New-DnsXml -ProcessId 4200 -Name 'snowflake-broker.torproject.net' -Results '')
    Assert-Equal 'OK' @(Get-DnsRows (Context -Transport snowflake) @($q) $pids)[0].Verdict
    Assert-Equal 'REVIEW' @(Get-DnsRows (Context -Transport obfs4) @($q) $pids)[0].Verdict
}

Test 'other processes'' DNS queries are not reported' {
    $pids = [pscustomobject]@{ Trino = @(4100); Lyrebird = @(); WebView = @(5200) }
    $q = ConvertFrom-DnsEventXml (New-DnsXml -ProcessId 1234 -Name 'example.org')
    Assert-Equal 0 @(Get-DnsRows (Context) @($q) $pids).Count
}

# ---- The report -------------------------------------------------------------

Test 'rows with the same destination are counted together, FAILs first' {
    $events = @(
        (ConvertFrom-AuditEventXml (New-WfpXml)),
        (ConvertFrom-AuditEventXml (New-WfpXml -Time '2026-10-15T20:05:00.0000000Z')),
        (ConvertFrom-AuditEventXml (New-WfpXml -Dest '203.0.113.99'))
    )
    $grouped = @(Group-AuditRows (Get-ConnectionRows (Context) $events))
    Assert-Equal 2 $grouped.Count 'groups'
    Assert-Equal 'FAIL' $grouped[0].Verdict 'first'
    Assert-Equal 2 $grouped[1].Count 'the relay twice'
}

Test 'the exit code: 1 with a FAIL, 2 when incomplete, 0 when clean' {
    $ok = @([pscustomobject]@{ Verdict = 'OK' }, [pscustomobject]@{ Verdict = 'KNOWN' })
    $bad = $ok + @([pscustomobject]@{ Verdict = 'FAIL' })
    Assert-Equal 0 (Get-ReportExitCode $ok $false)
    Assert-Equal 2 (Get-ReportExitCode $ok $true)
    Assert-Equal 1 (Get-ReportExitCode $bad $true)
}

# ---- The firewall variant ---------------------------------------------------

Test 'the IPv4 block ranges leave out only loopback and the bridge' {
    Assert-Equal @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255') (Get-Ipv4BlockRanges @())
    Assert-Equal @('0.0.0.0-126.255.255.255', '128.0.0.0-192.0.2.9', '192.0.2.11-255.255.255.255') (Get-Ipv4BlockRanges @('192.0.2.10'))
    Assert-Equal @('0.0.0.1-126.255.255.255', '128.0.0.0-255.255.255.254') (Get-Ipv4BlockRanges @('0.0.0.0', '255.255.255.255'))
}

Test 'the allow-list rules fence Trino to this machine and lyrebird to the bridge' {
    $rules = @(Get-AllowListRules 'C:\T\TrinoChat.exe' 'C:\T\lyrebird.exe' '192.0.2.10')
    Assert-Equal 2 $rules.Count
    Assert-Equal 'C:\T\TrinoChat.exe' $rules[0].Program
    Assert-True ($rules[0].RemoteAddress -contains '0.0.0.0-126.255.255.255') 'Trino blocked everywhere but 127/8'
    Assert-True ($rules[1].RemoteAddress -contains '192.0.2.11-255.255.255.255') 'lyrebird blocked past the bridge'
    Assert-True (-not ($rules[1].RemoteAddress -match '^192\.0\.2\.10-')) 'the bridge is not blocked'
    $none = @(Get-AllowListRules 'C:\T\TrinoChat.exe' 'C:\T\lyrebird.exe' '')
    Assert-Equal ($none[0].RemoteAddress -join ',') ($none[1].RemoteAddress -join ',') 'without a bridge, lyrebird goes nowhere either'
}

# ---- What each action changes, and its undo ---------------------------------

Test 'Start audits connections by GUID, allowed and blocked, and says how to undo it' {
    $plan = @(Get-StartPlan 'C:\state')
    Assert-True ($plan[0].Do -eq 'auditpol /backup /file:"C:\state\auditpol-before.csv"') 'a backup first'
    Assert-True ($plan[1].Do -like '*/subcategory:"{0CCE9226-69AE-11D9-BED3-505054503030}" /success:enable /failure:enable') 'the subcategory'
    Assert-True ($plan[1].Undo -eq 'auditpol /restore /file:"C:\state\auditpol-before.csv"') 'restored from the backup'
    foreach ($p in $plan) { Assert-True ($p.Undo) "an undo for: $($p.What)" }
}

Test 'Stop puts back what Start saved and removes the rules' {
    $state = [pscustomobject]@{ Started = '2026-10-15T20:00:00Z'; SecurityMaxSize = 20971520; DnsEnabled = $false; DnsMaxSize = 1052672 }
    $do = @(Get-StopPlan $state 'C:\state' | ForEach-Object { $_.Do })
    Assert-True ($do -contains 'auditpol /restore /file:"C:\state\auditpol-before.csv"') 'the policy'
    Assert-True ($do -contains 'wevtutil sl Security /ms:20971520') 'the Security log size'
    Assert-True ($do -contains 'wevtutil sl Microsoft-Windows-DNS-Client/Operational /e:false /ms:1052672') 'the DNS log'
    Assert-True ($do -contains "Remove-NetFirewallRule -Group 'Trino audit (TOR-12)'") 'the rules'
}

Test 'Stop without a record turns the auditing off' {
    $do = @(Get-StopPlan $null 'C:\state' | ForEach-Object { $_.Do })
    Assert-True ($do[0] -like '*{0CCE9226-69AE-11D9-BED3-505054503030}" /success:disable /failure:disable') 'off'
}

Test 'nothing is applied without a typed yes' {
    function Read-Host { 'y' }
    Assert-True (-not (Confirm-Changes)) '"y" is not yes'
    function Read-Host { '' }
    Assert-True (-not (Confirm-Changes)) 'Enter is not yes'
    function Read-Host { 'yes' }
    Assert-True (Confirm-Changes) 'yes'
}

Test 'loading the script ran no action' {
    # Dot-sourced above: it only defined functions. Each action that changes
    # anything starts with Assert-Administrator and Show-Plan.
    $source = Get-Content (Join-Path $PSScriptRoot 'audit-tor.ps1') -Raw
    Assert-True ($source -match "if \(\`$MyInvocation.InvocationName -ne '\.'\)") 'the guard'
    foreach ($action in 'Invoke-Start', 'Invoke-Stop', 'Invoke-AllowList') {
        $body = $source.Substring($source.IndexOf("function $action"))
        $body = $body.Substring(0, $body.IndexOf("`n}"))
        Assert-True ($body -match 'Assert-Administrator') "$action needs an administrator"
        Assert-True ($body.IndexOf('Confirm-Changes') -gt $body.IndexOf('Show-Plan')) "$action shows its plan before asking"
        Assert-True ($body.IndexOf('Confirm-Changes') -lt $body.IndexOf('Invoke-Native') -or $body.IndexOf('Invoke-Native') -lt 0) "$action asks before it changes anything"
        Assert-True ($body.IndexOf('Confirm-Changes') -lt $body.IndexOf('New-NetFirewallRule') -or $body.IndexOf('New-NetFirewallRule') -lt 0) "$action asks before a rule"
    }
}

Write-Host ''
Write-Host "$script:Passed passed, $($script:Failed.Count) failed"
if ($script:Failed.Count -gt 0) { exit 1 }
exit 0
