param([string]$TokenFile = '.wrangler-secret-input')
$ErrorActionPreference = 'Stop'
$token = (Get-Content $TokenFile -Raw).Trim()
if (-not $token) { throw 'TOKEN_INPUT_EMPTY' }
$proxy = 'http://127.0.0.1:10808'
$base = "https://api.telegram.org/bot$token"
$me = Invoke-RestMethod -Uri "$base/getMe" -Proxy $proxy -Method Get
if (-not $me.ok) { throw 'TELEGRAM_GETME_FAILED' }
Write-Output ("BOT_OK username=@{0} id={1}" -f $me.result.username, $me.result.id)
$updates = Invoke-RestMethod -Uri "$base/getUpdates?limit=100&timeout=0" -Proxy $proxy -Method Get
if (-not $updates.ok) { throw 'TELEGRAM_GETUPDATES_FAILED' }
$rows = @()
foreach ($update in $updates.result) {
  if ($update.message -and $update.message.chat) {
    $rows += [pscustomobject]@{
      update_id = $update.update_id
      chat_id = [string]$update.message.chat.id
      chat_type = $update.message.chat.type
      username = $update.message.from.username
      text = $update.message.text
    }
  }
}
Write-Output ("UPDATES=" + $rows.Count)
if ($rows.Count -gt 0) { $rows | Select-Object -Last 10 | Format-Table -AutoSize }
