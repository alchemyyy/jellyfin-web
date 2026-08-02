[CmdletBinding()]
param(
    [Parameter()]
    [string] $FfmpegPath = 'ffmpeg',

    [Parameter()]
    [string] $FfprobePath = 'ffprobe',

    [Parameter()]
    [string] $OutputDirectory = (Join-Path $PSScriptRoot 'playback-smoke-media'),

    [Parameter()]
    [ValidateSet(24, 30, 60)]
    [int[]] $FrameRates = @(24),

    [Parameter()]
    [ValidateSet('720p', '1080p')]
    [string] $Resolution = '1080p',

    [Parameter()]
    [switch] $IncludeAC3,

    [Parameter()]
    [switch] $Overwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[int] $Width = if ($Resolution -eq '720p') { 1280 } else { 1920 }
[int] $Height = if ($Resolution -eq '720p') { 720 } else { 1080 }
[int] $DurationSeconds = 6
[int] $TargetVideoBitRateKilobits = 6000
[int] $MaximumVideoBitRateKilobits = 8000
[int] $AudioSampleRate = 48000
[int] $AudioChannelCount = 2

function Assert-PlaybackSmokeFixture {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Transfer,

        [Parameter(Mandatory)]
        [string] $AudioCodec,

        [Parameter(Mandatory)]
        [ValidateSet(24, 30, 60)]
        [int] $FrameRate
    )

    [string[]] $probeOutput = & $FfprobePath @(
        '-v', 'error',
        '-show_entries',
        'stream=index,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,color_range,color_space,color_transfer,color_primaries,channels,sample_rate',
        '-of', 'json',
        $Path
    )
    if ($LASTEXITCODE -ne 0) {
        throw "FFprobe failed while verifying $Path"
    }

    [pscustomobject] $probe = [string]::Join([Environment]::NewLine, $probeOutput) |
        ConvertFrom-Json
    [object[]] $streams = @($probe.streams)
    [pscustomobject] $videoStream = $streams |
        Where-Object { $_.codec_name -eq 'hevc' } |
        Select-Object -First 1
    [pscustomobject] $audioStream = $streams |
        Where-Object { $_.codec_name -eq $AudioCodec } |
        Select-Object -First 1
    if ($null -eq $videoStream -or $null -eq $audioStream) {
        throw "The expected HEVC/$AudioCodec streams are missing from $Path"
    }

    [int] $expectedHEVCLevel = if ($Resolution -eq '1080p' -and $FrameRate -eq 60) {
        123
    } else {
        120
    }

    [System.Collections.Specialized.OrderedDictionary] $expectedVideo = [ordered] @{
        profile = 'Main 10'
        level = $expectedHEVCLevel
        width = $Width
        height = $Height
        pix_fmt = 'yuv420p10le'
        r_frame_rate = "$FrameRate/1"
        color_range = 'tv'
        color_space = 'bt2020nc'
        color_transfer = $Transfer
        color_primaries = 'bt2020'
    }
    foreach ($propertyName in $expectedVideo.Keys) {
        [string] $actualValue = [string] $videoStream.$propertyName
        [string] $expectedValue = [string] $expectedVideo[$propertyName]
        if ($actualValue -ne $expectedValue) {
            throw "Unexpected $propertyName in ${Path}: expected $expectedValue, got $actualValue"
        }
    }
    if (
        ([int] $audioStream.sample_rate -ne $AudioSampleRate) -or
        ([int] $audioStream.channels -ne $AudioChannelCount)
    ) {
        throw "The audio stream in $Path must be stereo 48 kHz"
    }
}

function New-PlaybackSmokeFixture {
    param(
        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter(Mandatory)]
        [ValidateSet('16', '18')]
        [string] $TransferCode,

        [Parameter(Mandatory)]
        [ValidateSet('smpte2084', 'arib-std-b67')]
        [string] $Transfer,

        [Parameter(Mandatory)]
        [ValidateSet('aac', 'ac3')]
        [string] $AudioCodec,

        [Parameter(Mandatory)]
        [int] $AudioBitRate,

        [Parameter(Mandatory)]
        [int] $AudioFrequency,

        [Parameter(Mandatory)]
        [ValidateSet(24, 30, 60)]
        [int] $FrameRate
    )

    [string] $outputPath = Join-Path $OutputDirectory "$Name.mkv"
    if ((Test-Path -LiteralPath $outputPath) -and !$Overwrite) {
        throw "$outputPath already exists; pass -Overwrite to replace it"
    }

    [string] $videoInput = "testsrc2=size=${Width}x${Height}:rate=${FrameRate}:duration=${DurationSeconds},format=yuv420p10le"
    [string] $audioInput = "sine=frequency=${AudioFrequency}:sample_rate=${AudioSampleRate}:duration=${DurationSeconds}"
    [int] $keyFrameInterval = $FrameRate * 2
    [string] $levelIDC = if ($Resolution -eq '1080p' -and $FrameRate -eq 60) {
        '4.1'
    } else {
        '4'
    }
    [string] $x265Parameters = [string]::Join(':', @(
        "level-idc=$levelIDC",
        'high-tier=0',
        "keyint=$keyFrameInterval",
        "min-keyint=$FrameRate",
        'scenecut=0',
        'repeat-headers=1',
        'range=limited',
        'colorprim=9',
        "transfer=$TransferCode",
        'colormatrix=9'
    ))
    if ($TransferCode -eq '16') {
        $x265Parameters += ':hdr10=1'
    }

    & $FfmpegPath @(
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-f', 'lavfi',
        '-i', $videoInput,
        '-f', 'lavfi',
        '-i', $audioInput,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx265',
        '-pix_fmt', 'yuv420p10le',
        '-preset', 'fast',
        '-b:v', "${TargetVideoBitRateKilobits}k",
        '-maxrate', "${MaximumVideoBitRateKilobits}k",
        '-bufsize', "${MaximumVideoBitRateKilobits}k",
        '-x265-params', $x265Parameters,
        '-c:a', $AudioCodec,
        '-b:a', "${AudioBitRate}k",
        '-ar', [string] $AudioSampleRate,
        '-ac', [string] $AudioChannelCount,
        '-shortest',
        $outputPath
    )
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg failed while generating $outputPath"
    }

    Assert-PlaybackSmokeFixture `
        -Path $outputPath `
        -Transfer $Transfer `
        -AudioCodec $AudioCodec `
        -FrameRate $FrameRate

    return Get-Item -LiteralPath $outputPath
}

function New-AC3SwitchFixture {
    param(
        [Parameter(Mandatory)]
        [string] $VideoAndAACInputPath,

        [Parameter(Mandatory)]
        [ValidateSet(24, 30, 60)]
        [int] $FrameRate
    )

    [string] $outputPath = Join-Path $OutputDirectory `
        "pq-main10-${Resolution}${FrameRate}-aac-ac3.mkv"
    if ((Test-Path -LiteralPath $outputPath) -and !$Overwrite) {
        throw "$outputPath already exists; pass -Overwrite to replace it"
    }

    [string] $audioInput = "sine=frequency=880:sample_rate=${AudioSampleRate}:duration=${DurationSeconds}"
    & $FfmpegPath @(
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-i', $VideoAndAACInputPath,
        '-f', 'lavfi',
        '-i', $audioInput,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a:0', 'copy',
        '-c:a:1', 'ac3',
        '-b:a:1', '192k',
        '-ar:a:1', [string] $AudioSampleRate,
        '-ac:a:1', [string] $AudioChannelCount,
        '-metadata:s:a:0', 'title=AAC default',
        '-metadata:s:a:1', 'title=AC-3 switch target',
        '-disposition:a:0', 'default',
        '-disposition:a:1', '0',
        '-shortest',
        $outputPath
    )
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg failed while generating $outputPath"
    }

    Assert-PlaybackSmokeFixture `
        -Path $outputPath `
        -Transfer 'smpte2084' `
        -AudioCodec 'aac' `
        -FrameRate $FrameRate
    Assert-PlaybackSmokeFixture `
        -Path $outputPath `
        -Transfer 'smpte2084' `
        -AudioCodec 'ac3' `
        -FrameRate $FrameRate

    return Get-Item -LiteralPath $outputPath
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
[System.Collections.Generic.List[System.IO.FileInfo]] $generatedFiles = @()
[System.IO.FileInfo] $pqAACFixtureForAC3 = $null
foreach ($fixtureFrameRate in ($FrameRates | Sort-Object -Unique)) {
    [System.IO.FileInfo] $pqAACFixture = New-PlaybackSmokeFixture `
        -Name "pq-main10-${Resolution}${fixtureFrameRate}-aac" `
        -TransferCode '16' `
        -Transfer 'smpte2084' `
        -AudioCodec 'aac' `
        -AudioBitRate 128 `
        -AudioFrequency 440 `
        -FrameRate $fixtureFrameRate
    $generatedFiles.Add($pqAACFixture)
    $generatedFiles.Add((New-PlaybackSmokeFixture `
        -Name "hlg-main10-${Resolution}${fixtureFrameRate}-aac" `
        -TransferCode '18' `
        -Transfer 'arib-std-b67' `
        -AudioCodec 'aac' `
        -AudioBitRate 128 `
        -AudioFrequency 660 `
        -FrameRate $fixtureFrameRate))
    if ($fixtureFrameRate -eq 24) {
        $pqAACFixtureForAC3 = $pqAACFixture
    }
}
if ($IncludeAC3) {
    if ($null -eq $pqAACFixtureForAC3) {
        throw '-IncludeAC3 requires 24 in -FrameRates'
    }
    $generatedFiles.Add((New-AC3SwitchFixture `
        -VideoAndAACInputPath $pqAACFixtureForAC3.FullName `
        -FrameRate 24))
}

$generatedFiles |
    Select-Object Name, Length, FullName
