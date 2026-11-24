[CmdletBinding()]
param([string]$Marketplace = $PSScriptRoot)
$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 22 or newer, restart Claude Desktop, and run the installer again.' }
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) { throw 'FileShelf requires Node.js 22 or newer.' }

$claudeCommand = Get-Command claude.exe,claude.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($claudeCommand) {
    & $claudeCommand.Source plugin install fileshelf --marketplace $Marketplace --scope user
} else {
    $npmRunner = Get-Command npx.cmd -CommandType Application -ErrorAction Stop
    & $npmRunner.Source --yes '@anthropic-ai/claude-code@2.1.331' plugin install fileshelf --marketplace $Marketplace --scope user
}
if ($LASTEXITCODE -ne 0) { throw 'The Claude plugin installer returned an error. Review its message above.' }
Write-Output 'FileShelf installed. Reopen your original local Code session and enter /fileshelf.'
