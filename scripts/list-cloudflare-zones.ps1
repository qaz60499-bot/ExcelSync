$ErrorActionPreference = 'Stop'
$configPath = Join-Path $env:APPDATA 'xdg.config\.wrangler\config\default.toml'
$raw = Get-Content $configPath -Raw
$match = [regex]::Match($raw, 'oauth_token\s*=\s*"([^"]+)"')
if (-not $match.Success) { throw 'OAUTH_TOKEN_NOT_FOUND' }
$headers = @{ Authorization = 'Bearer ' + $match.Groups[1].Value }
$url = 'https://api.cloudflare.com/client/v4/zones?account.id=401ad6b2ed84076030b3d980a78a696c&per_page=50'
$response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
if (-not $response.success) { throw 'CLOUDFLARE_API_FAILED' }
$response.result | Select-Object name, status, id | Format-Table -AutoSize
