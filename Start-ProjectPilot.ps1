param(
  [ValidateSet("start", "status", "open", "stop")]
  [string] $Command = "start"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectRoot

switch ($Command) {
  "start" { npm run local; break }
  "status" { npm run local:status; break }
  "open" { npm run local:open; break }
  "stop" { npm run local:stop; break }
}
