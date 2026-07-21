# Sincroniza a cópia vendorizada do motor de PDF (js/shared-pdf/) a partir de uma TAG
# do repo tsrv-pdf-engine, e grava ENGINE_MANIFEST.json (versão + SHA-256 dos arquivos).
# A cópia vendorizada NUNCA é editada à mão — toda mudança nasce no repo do motor.
# Uso:  pwsh scripts/sync-pdf-engine.ps1 -Tag v1.0.0
#       pwsh scripts/sync-pdf-engine.ps1 -Tag v1.0.0 -LocalSource ..\tsrv-pdf-engine
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Repo = 'https://github.com/emanoelaklock/tsrv-pdf-engine.git',
  [string]$LocalSource = ''
)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $app 'js\shared-pdf'
New-Item -ItemType Directory -Force $destDir | Out-Null

# 1) obtém a árvore da tag (clone raso em temp, ou repo local para dev)
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pdf-engine-sync-" + [Guid]::NewGuid().ToString('n'))
try {
  if ($LocalSource) {
    git clone --quiet --depth 1 --branch $Tag $LocalSource $tmp
  } else {
    git clone --quiet --depth 1 --branch $Tag $Repo $tmp
  }

  # 2) copia o motor
  Copy-Item (Join-Path $tmp 'pdf-engine.js') (Join-Path $destDir 'pdf-engine.js') -Force

  # 3) o vendor (pdfmake/vfs) fica em js/vendor/ — precisa ser IDÊNTICO ao do motor.
  #    Divergência é erro (não sobrescrevemos em silêncio: o vendor está no SW/offline).
  $hash = { param($p) (Get-FileHash -Algorithm SHA256 -Path $p).Hash.ToLower() }
  foreach ($v in 'pdfmake.min.js', 'vfs_fonts.js') {
    $doMotor = & $hash (Join-Path $tmp "vendor\$v")
    $doApp   = & $hash (Join-Path $app "js\vendor\$v")
    if ($doMotor -ne $doApp) {
      throw "vendor divergente: js/vendor/$v difere do vendor da tag $Tag do motor. Alinhe os dois (decisão explícita, com bump do CACHE do SW)."
    }
  }

  # 4) manifest com versão + hashes (contrato verificado por check-pdf-engine.ps1)
  $manifest = [ordered]@{
    version = $Tag
    source  = ($LocalSource ? $LocalSource : $Repo)
    syncedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    files = [ordered]@{
      'js/shared-pdf/pdf-engine.js' = & $hash (Join-Path $destDir 'pdf-engine.js')
      'js/vendor/pdfmake.min.js'    = & $hash (Join-Path $app 'js\vendor\pdfmake.min.js')
      'js/vendor/vfs_fonts.js'      = & $hash (Join-Path $app 'js\vendor\vfs_fonts.js')
    }
  }
  $manifest | ConvertTo-Json | Set-Content (Join-Path $destDir 'ENGINE_MANIFEST.json') -Encoding utf8NoBOM
  Write-Host "sync ok: motor $Tag -> js/shared-pdf/ (manifest atualizado)"
  Write-Host "lembrete: bump do CACHE em service-worker.js + gate golden antes de commitar."
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
