# Totals Claude Code token usage from session transcripts.
# Output: JSON {
#   scannedAt, files,
#   rows: [{ p: project, m: model, d: day, s: session, f: isFast, i: input, o: output, w5: write5m, w1: write1h,
#            r: read, n: calls, ot: output thinking, ox: output reply text, oc: output tool calls }],
#   sessions: [{ id, title, project, start }]
# }
# The split of output between reply text and tool calls is estimated from the characters of each block.
param([string]$Root = (Join-Path $env:USERPROFILE '.claude\projects'))

$ErrorActionPreference = 'SilentlyContinue'
$rxModel = [regex]'"message":\{"model":"([^"]+)"'
$rxModelAny = [regex]'"model":"([^"]+)"'
$rxId = [regex]'"id":"(msg_[^"]+)"'
$rxReq = [regex]'"requestId":"([^"]+)"'
$rxCwd = [regex]'"cwd":"((?:[^"\\]|\\.)*)"'
$rxDay = [regex]'"timestamp":"(\d{4}-\d\d-\d\d)'
$rxStamp = [regex]'"timestamp":"([^"]+)"'
$rxUsage = [regex]'^"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+),"output_tokens":(\d+)'
$rx5m = [regex]'"ephemeral_5m_input_tokens":(\d+)'
$rx1h = [regex]'"ephemeral_1h_input_tokens":(\d+)'
$rxThink = [regex]'"thinking_tokens":(\d+)'
$rxFast = [regex]'"speed":"fast"'
$rxBlock = [regex]'"content":\[\{"type":"([a-z_]+)"'
$rxPrompt = [regex]'"message":\{"role":"user","content":"((?:[^"\\]|\\.){1,120})'

$calls = @{}
$sessions = @{}
$files = 0
if (Test-Path -LiteralPath $Root) {
  # Oldest first, so a call a forked session copied stays with the session that made it.
  $transcripts = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.jsonl' | Sort-Object CreationTimeUtc
  foreach ($file in ($transcripts | ForEach-Object { $_.FullName })) {
    $files++
    $dir = Split-Path $file -Parent
    $isSub = (Split-Path $dir -Leaf) -eq 'subagents'
    $session = if ($isSub) { Split-Path (Split-Path $dir -Parent) -Leaf } else { [System.IO.Path]::GetFileNameWithoutExtension($file) }
    $fallback = if ($isSub) { Split-Path (Split-Path (Split-Path $dir -Parent) -Parent) -Leaf } else { Split-Path $dir -Leaf }
    if (-not $sessions.ContainsKey($session)) { $sessions[$session] = [ordered]@{ id = $session; title = ''; project = ''; start = ''; app = ''; archived = $false; deleted = $false } }
    $meta = $sessions[$session]
    try { $lines = [System.IO.File]::ReadLines($file) } catch { continue }
    foreach ($line in $lines) {
      if (-not $isSub -and $meta.title -eq '' -and $line.IndexOf('"type":"user"') -ge 0) {
        $q = $rxPrompt.Match($line)
        if ($q.Success -and -not $q.Groups[1].Value.StartsWith('<')) {
          $meta.title = $q.Groups[1].Value
          if ($meta.start -eq '') { $meta.start = $rxStamp.Match($line).Groups[1].Value }
        }
      }
      if ($line.IndexOf('"type":"assistant"') -lt 0) { continue }
      $at = $line.LastIndexOf('"usage":{"input_tokens":')
      if ($at -lt 0) { continue }
      $tail = $line.Substring($at)
      $u = $rxUsage.Match($tail)
      if (-not $u.Success) { continue }
      $m = $rxModel.Match($line); if (-not $m.Success) { $m = $rxModelAny.Match($line) }
      $model = if ($m.Success) { $m.Groups[1].Value } else { 'unknown' }
      if ($model -eq '<synthetic>') { continue }
      $id = $rxId.Match($line).Groups[1].Value
      $req = $rxReq.Match($line).Groups[1].Value
      $cwdM = $rxCwd.Match($line)
      $project = if ($cwdM.Success) { $cwdM.Groups[1].Value.Replace('\\', '\') } else { $fallback }
      if ($meta.project -eq '') { $meta.project = $project }
      if ($meta.start -eq '') { $meta.start = $rxStamp.Match($line).Groups[1].Value }
      $key = if ($id) { "$id|$req" } else { "$file|$($calls.Count)" }
      if (-not $calls.ContainsKey($key)) {
        $creation = [int64]$u.Groups[2].Value
        $w1h = 0; $w5m = $creation
        $h = $rx1h.Match($tail); if ($h.Success) { $w1h = [int64]$h.Groups[1].Value }
        $f = $rx5m.Match($tail); if ($f.Success) { $w5m = [int64]$f.Groups[1].Value }
        if (($w5m + $w1h) -ne $creation) { $w5m = $creation - $w1h }
        $calls[$key] = @{
          p = $project; m = $model; d = $rxDay.Match($line).Groups[1].Value; s = $session; f = [bool]$rxFast.IsMatch($tail)
          i = [int64]$u.Groups[1].Value; o = [int64]$u.Groups[4].Value; w5 = $w5m; w1 = $w1h; r = [int64]$u.Groups[3].Value
          think = [int64]0; textChars = [int64]0; toolChars = [int64]0
        }
      }
      $c = $calls[$key]
      $t = $rxThink.Match($tail); if ($t.Success) { $c.think = [Math]::Max($c.think, [int64]$t.Groups[1].Value) }
      $b = $rxBlock.Match($line)
      if ($b.Success) {
        $chars = [int64]($at - $b.Index)
        if ($b.Groups[1].Value -eq 'tool_use') { $c.toolChars += $chars }
        elseif ($b.Groups[1].Value -eq 'text') { $c.textChars += $chars }
      }
    }
  }
}

$agg = @{}
foreach ($c in $calls.Values) {
  $think = [Math]::Min($c.think, $c.o)
  $rest = $c.o - $think
  $shown = $c.textChars + $c.toolChars
  $tool = if ($shown -gt 0) { [int64][Math]::Round($rest * $c.toolChars / $shown) } else { [int64]0 }
  $k = "$($c.p)`t$($c.m)`t$($c.d)`t$($c.s)`t$($c.f)"
  if (-not $agg.ContainsKey($k)) {
    $agg[$k] = [pscustomobject]@{ p = $c.p; m = $c.m; d = $c.d; s = $c.s; f = $c.f; i = [int64]0; o = [int64]0; w5 = [int64]0; w1 = [int64]0; r = [int64]0; n = 0; ot = [int64]0; ox = [int64]0; oc = [int64]0 }
  }
  $r = $agg[$k]
  $r.i += $c.i; $r.o += $c.o; $r.w5 += $c.w5; $r.w1 += $c.w1; $r.r += $c.r; $r.n += 1
  $r.ot += $think; $r.oc += $tool; $r.ox += $rest - $tool
}

# A session renamed in the app keeps its name beside the transcript.
if (Test-Path -LiteralPath $Root) {
  foreach ($titleFile in [System.IO.Directory]::EnumerateFiles($Root, 'custom-title.json', 'AllDirectories')) {
    $owner = Split-Path (Split-Path $titleFile -Parent) -Leaf
    if (-not $sessions.ContainsKey($owner)) { continue }
    $custom = (Get-Content -LiteralPath $titleFile -Raw | ConvertFrom-Json).customTitle
    if ($custom) { $sessions[$owner].title = $custom }
  }
}

# The desktop app names each sidebar session; its record maps that name to the transcript.
$appStore = Join-Path $env:APPDATA 'Claude\claude-code-sessions'
if (Test-Path -LiteralPath $appStore) {
  foreach ($record in Get-ChildItem -LiteralPath $appStore -Recurse -File -Filter 'local_*.json') {
    $app = Get-Content -LiteralPath $record.FullName -Raw | ConvertFrom-Json
    if (-not $app.cliSessionId -or -not $sessions.ContainsKey($app.cliSessionId)) { continue }
    $meta = $sessions[$app.cliSessionId]
    if ($app.title) { $meta.title = $app.title }
    $meta.app = $app.sessionId
    $meta.archived = [bool]$app.isArchived
  }
  foreach ($gone in Get-ChildItem -LiteralPath $appStore -Recurse -File -Filter 'deleted_*') {
    $id = $gone.Name.Substring(8) -replace '\.json$', ''
    if ($sessions.ContainsKey($id) -and $sessions[$id].app -eq '') { $sessions[$id].deleted = $true }
  }
}

$out = [pscustomobject]@{
  scannedAt = (Get-Date).ToUniversalTime().ToString('o')
  files = $files
  rows = @($agg.Values)
  sessions = @($sessions.Values | Where-Object { $_.project -ne '' } | ForEach-Object { [pscustomobject]$_ })
}
[Console]::Out.Write(($out | ConvertTo-Json -Depth 4 -Compress))
