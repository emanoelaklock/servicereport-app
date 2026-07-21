# Verifica a integridade da cópia vendorizada do motor de PDF: recomputa o SHA-256
# de cada arquivo listado em js/shared-pdf/ENGINE_MANIFEST.json e acusa divergência
# (edição manual da cópia é proibida — docs/pdf-engine-f1.md). Sai com código 1 se falhar.
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $app 'js\shared-pdf\ENGINE_MANIFEST.json'
if (-not (Test-Path $manifestPath)) { Write-Error "manifest ausente: $manifestPath"; exit 1 }
$man = Get-Content $manifestPath -Raw | ConvertFrom-Json
$falhas = 0
foreach ($rel in $man.files.PSObject.Properties.Name) {
  $p = Join-Path $app ($rel -replace '/', '\')
  if (-not (Test-Path $p)) { Write-Host "FALTA   $rel"; $falhas++; continue }
  # hash com CRLF→LF (mesma regra do sync): estável entre checkout Windows e deploy
  $s = [System.IO.File]::ReadAllText($p) -replace "`r`n", "`n"
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $h = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))).Replace('-', '').ToLower()
  if ($h -ne $man.files.$rel) { Write-Host "DIVERGE $rel"; $falhas++ } else { Write-Host "ok      $rel" }
}
if ($falhas) { Write-Error "check-pdf-engine: $falhas arquivo(s) divergente(s) da tag $($man.version). Rode scripts/sync-pdf-engine.ps1 — não edite a cópia à mão."; exit 1 }
Write-Host "check-pdf-engine: íntegro (tag $($man.version))"
