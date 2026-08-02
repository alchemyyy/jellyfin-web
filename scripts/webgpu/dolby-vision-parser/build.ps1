$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactDirectory = Join-Path $scriptDirectory 'artifacts'
$targetArtifact = Join-Path $scriptDirectory 'target\wasm32-unknown-unknown\release\jellyfin_webgpu_dolby_vision_parser.wasm'
$servedArtifact = Join-Path $artifactDirectory 'dovi-rpu-parser.wasm'

Push-Location $scriptDirectory
try {
    cargo build --locked --release --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo failed with exit code $LASTEXITCODE"
    }
    if (!(Test-Path -LiteralPath $targetArtifact -PathType Leaf)) {
        throw "Cargo did not produce $targetArtifact"
    }
    New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
    Copy-Item -LiteralPath $targetArtifact -Destination $servedArtifact -Force
    Get-FileHash -Algorithm SHA256 -LiteralPath $servedArtifact
} finally {
    Pop-Location
}
