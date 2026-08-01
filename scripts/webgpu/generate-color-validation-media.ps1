[CmdletBinding()]
param(
    [Parameter()]
    [string] $FfmpegPath = 'ffmpeg',

    [Parameter()]
    [string] $OutputDirectory = (Join-Path $PSScriptRoot 'validation-media'),

    [Parameter()]
    [ValidateRange(16, 8192)]
    [int] $Width = 640,

    [Parameter()]
    [ValidateRange(16, 8192)]
    [int] $Height = 360,

    [Parameter()]
    [switch] $Overwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-LevelExpression {
    param(
        [Parameter(Mandatory)]
        [int[]] $Levels
    )

    [string] $expression = [string] $Levels[$Levels.Count - 1]
    for ([int] $levelIndex = $Levels.Count - 2; $levelIndex -ge 0; $levelIndex -= 1) {
        $expression = "if(eq(N,$levelIndex),$($Levels[$levelIndex]),$expression)"
    }
    return $expression
}

function Convert-RGBTripletsToLimitedYUV {
    param(
        [Parameter(Mandatory)]
        [double[][]] $RGBTriplets,

        [Parameter(Mandatory)]
        [ValidateRange(8, 16)]
        [int] $BitDepth,

        [Parameter(Mandatory)]
        [double] $RedCoefficient,

        [Parameter(Mandatory)]
        [double] $BlueCoefficient
    )

    [double] $greenCoefficient = 1.0 - $RedCoefficient - $BlueCoefficient
    [int] $codeScale = [int] [Math]::Pow(2, $BitDepth - 8)
    [int] $lumaBlackCode = 16 * $codeScale
    [int] $lumaWhiteCode = 235 * $codeScale
    [int] $chromaCenterCode = 128 * $codeScale
    [int] $chromaMinimumCode = 16 * $codeScale
    [int] $chromaMaximumCode = 240 * $codeScale
    [int] $lumaExcursion = $lumaWhiteCode - $lumaBlackCode
    [int] $chromaExcursion = 224 * $codeScale
    [System.Collections.Generic.List[int]] $yLevels = @()
    [System.Collections.Generic.List[int]] $cbLevels = @()
    [System.Collections.Generic.List[int]] $crLevels = @()
    [System.Collections.Generic.List[double[]]] $exactRGBTriplets = @()
    [System.Collections.Generic.List[int[]]] $yuvCodeTriplets = @()

    foreach ($rgbValue in $RGBTriplets) {
        [double[]] $rgb = $rgbValue
        if ($rgb.Count -ne 3) {
            throw 'Every encoded RGB validation sample must contain three components'
        }
        [double] $red = $rgb[0]
        [double] $green = $rgb[1]
        [double] $blue = $rgb[2]
        [double] $luma = ($RedCoefficient * $red) +
            ($greenCoefficient * $green) +
            ($BlueCoefficient * $blue)
        [double] $blueDifference = ($blue - $luma) / (2.0 * (1.0 - $BlueCoefficient))
        [double] $redDifference = ($red - $luma) / (2.0 * (1.0 - $RedCoefficient))
        [int] $yCode = [Math]::Clamp(
            [int] [Math]::Round(
                $lumaBlackCode + ($lumaExcursion * $luma),
                [MidpointRounding]::AwayFromZero
            ),
            $lumaBlackCode,
            $lumaWhiteCode
        )
        [int] $cbCode = [Math]::Clamp(
            [int] [Math]::Round(
                $chromaCenterCode + ($chromaExcursion * $blueDifference),
                [MidpointRounding]::AwayFromZero
            ),
            $chromaMinimumCode,
            $chromaMaximumCode
        )
        [int] $crCode = [Math]::Clamp(
            [int] [Math]::Round(
                $chromaCenterCode + ($chromaExcursion * $redDifference),
                [MidpointRounding]::AwayFromZero
            ),
            $chromaMinimumCode,
            $chromaMaximumCode
        )

        [double] $exactLuma = ($yCode - $lumaBlackCode) / $lumaExcursion
        [double] $exactBlueDifference = ($cbCode - $chromaCenterCode) / $chromaExcursion
        [double] $exactRedDifference = ($crCode - $chromaCenterCode) / $chromaExcursion
        [double] $exactRed = $exactLuma +
            (2.0 * (1.0 - $RedCoefficient) * $exactRedDifference)
        [double] $exactBlue = $exactLuma +
            (2.0 * (1.0 - $BlueCoefficient) * $exactBlueDifference)
        [double] $exactGreen = ($exactLuma -
            ($RedCoefficient * $exactRed) -
            ($BlueCoefficient * $exactBlue)) / $greenCoefficient

        $yLevels.Add($yCode)
        $cbLevels.Add($cbCode)
        $crLevels.Add($crCode)
        $exactRGBTriplets.Add([double[]] @($exactRed, $exactGreen, $exactBlue))
        $yuvCodeTriplets.Add([int[]] @($yCode, $cbCode, $crCode))
    }

    return [pscustomobject] @{
        CbLevels = [int[]] $cbLevels
        CrLevels = [int[]] $crLevels
        ExactRGBTriplets = [double[][]] $exactRGBTriplets
        YLevels = [int[]] $yLevels
        YUVCodeTriplets = [int[][]] $yuvCodeTriplets
    }
}

function Invoke-ValidationEncode {
    param(
        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter(Mandatory)]
        [int[]] $YLevels,

        [Parameter(Mandatory)]
        [int[]] $CbLevels,

        [Parameter(Mandatory)]
        [int[]] $CrLevels,

        [Parameter(Mandatory)]
        [string] $PixelFormat,

        [Parameter(Mandatory)]
        [string] $Transfer,

        [Parameter(Mandatory)]
        [string] $Primaries,

        [Parameter(Mandatory)]
        [string] $Matrix,

        [Parameter(Mandatory)]
        [string] $Encoder,

        [Parameter(Mandatory)]
        [string[]] $EncoderArguments
    )

    if ($YLevels.Count -ne $CbLevels.Count -or $YLevels.Count -ne $CrLevels.Count) {
        throw 'Y, Cb, and Cr validation code arrays must have equal lengths'
    }
    [int] $frameCount = $YLevels.Count
    [string] $yExpression = New-LevelExpression -Levels $YLevels
    [string] $cbExpression = New-LevelExpression -Levels $CbLevels
    [string] $crExpression = New-LevelExpression -Levels $CrLevels
    [string] $filter = "nullsrc=size=$($Width)x$($Height):rate=1:duration=$frameCount," +
        "format=$PixelFormat," +
        "geq=lum='$yExpression':cb='$cbExpression':cr='$crExpression'"
    [string] $outputPath = Join-Path $OutputDirectory "$Name.mp4"
    [string] $overwriteArgument = if ($Overwrite) { '-y' } else { '-n' }
    [string[]] $arguments = @(
        '-hide_banner',
        '-loglevel', 'warning',
        $overwriteArgument,
        '-f', 'lavfi',
        '-i', $filter,
        '-frames:v', [string] $frameCount,
        '-an',
        '-c:v', $Encoder
    )
    $arguments += $EncoderArguments
    $arguments += @(
        '-pix_fmt', $PixelFormat,
        '-color_range', 'tv',
        '-colorspace', $Matrix,
        '-color_trc', $Transfer,
        '-color_primaries', $Primaries,
        '-movflags', '+faststart',
        $outputPath
    )

    & $FfmpegPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg failed while generating $Name"
    }
}

if (-not (Get-Command $FfmpegPath -ErrorAction SilentlyContinue)) {
    throw "FFmpeg was not found at '$FfmpegPath'"
}

[void] (New-Item -ItemType Directory -Force -Path $OutputDirectory)

[double[][]] $desiredRGBTriplets = @(
    ,([double[]] @(0.0, 0.0, 0.0))
    ,([double[]] @(0.25, 0.25, 0.25))
    ,([double[]] @(0.5, 0.5, 0.5))
    ,([double[]] @(0.75, 0.75, 0.75))
    ,([double[]] @(1.0, 1.0, 1.0))
    ,([double[]] @(0.75, 0.25, 0.25))
    ,([double[]] @(0.25, 0.75, 0.25))
    ,([double[]] @(0.25, 0.25, 0.75))
)
$sdrCodes = Convert-RGBTripletsToLimitedYUV `
    -RGBTriplets $desiredRGBTriplets `
    -BitDepth 8 `
    -RedCoefficient 0.2126 `
    -BlueCoefficient 0.0722
$hdrCodes = Convert-RGBTripletsToLimitedYUV `
    -RGBTriplets $desiredRGBTriplets `
    -BitDepth 10 `
    -RedCoefficient 0.2627 `
    -BlueCoefficient 0.0593

# Eight one-second frames include five gray levels and three chromatic probes
Invoke-ValidationEncode `
    -Name 'sdr-bt709-ramp' `
    -YLevels $sdrCodes.YLevels `
    -CbLevels $sdrCodes.CbLevels `
    -CrLevels $sdrCodes.CrLevels `
    -PixelFormat 'yuv420p' `
    -Transfer 'bt709' `
    -Primaries 'bt709' `
    -Matrix 'bt709' `
    -Encoder 'libx264' `
    -EncoderArguments @('-preset', 'slow', '-crf', '0')

Invoke-ValidationEncode `
    -Name 'pq-bt2020-ramp' `
    -YLevels $hdrCodes.YLevels `
    -CbLevels $hdrCodes.CbLevels `
    -CrLevels $hdrCodes.CrLevels `
    -PixelFormat 'yuv420p10le' `
    -Transfer 'smpte2084' `
    -Primaries 'bt2020' `
    -Matrix 'bt2020nc' `
    -Encoder 'libx265' `
    -EncoderArguments @('-tag:v', 'hvc1', '-preset', 'slow', '-x265-params', 'lossless=1:repeat-headers=1')

Invoke-ValidationEncode `
    -Name 'hlg-bt2020-ramp' `
    -YLevels $hdrCodes.YLevels `
    -CbLevels $hdrCodes.CbLevels `
    -CrLevels $hdrCodes.CrLevels `
    -PixelFormat 'yuv420p10le' `
    -Transfer 'arib-std-b67' `
    -Primaries 'bt2020' `
    -Matrix 'bt2020nc' `
    -Encoder 'libx265' `
    -EncoderArguments @('-tag:v', 'hvc1', '-preset', 'slow', '-x265-params', 'lossless=1:repeat-headers=1')

[long[]] $timestampsMicroseconds = @()
for ([int] $frameIndex = 0; $frameIndex -lt $desiredRGBTriplets.Count; $frameIndex += 1) {
    $timestampsMicroseconds += [long] $frameIndex * 1000000
}

$manifest = [ordered] @{
    frameIntervalMicroseconds = 1000000
    frameCount = $desiredRGBTriplets.Count
    desiredEncodedRGBTriplets = $desiredRGBTriplets
    encodedRGBTriplets = [ordered] @{
        sdr = $sdrCodes.ExactRGBTriplets
        pq = $hdrCodes.ExactRGBTriplets
        hlg = $hdrCodes.ExactRGBTriplets
    }
    encodedYUVCodeTriplets = [ordered] @{
        sdr = $sdrCodes.YUVCodeTriplets
        pq = $hdrCodes.YUVCodeTriplets
        hlg = $hdrCodes.YUVCodeTriplets
    }
    signalLevels = @(0, 0.25, 0.5, 0.75, 1)
    timestampsMicroseconds = $timestampsMicroseconds
    files = [ordered] @{
        sdr = 'sdr-bt709-ramp.mp4'
        pq = 'pq-bt2020-ramp.mp4'
        hlg = 'hlg-bt2020-ramp.mp4'
    }
}
[string] $manifestJSON = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'manifest.json'),
    $manifestJSON + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Generated deterministic validation media in $OutputDirectory"
