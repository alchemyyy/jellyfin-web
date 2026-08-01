[CmdletBinding()]
param(
    [Parameter()]
    [string] $FfmpegPath = 'ffmpeg',

    [Parameter()]
    [string] $FfprobePath = 'ffprobe',

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

[int] $FixtureSchemaVersion = 1
[string] $FixtureSetId = 'jellyfin-webgpu-color-validation-v1'

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

function Assert-VideoStreamMetadata {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $CodecName,

        [Parameter(Mandatory)]
        [string] $PixelFormat,

        [Parameter(Mandatory)]
        [string] $Transfer,

        [Parameter(Mandatory)]
        [string] $Primaries,

        [Parameter(Mandatory)]
        [string] $Matrix,

        [Parameter(Mandatory)]
        [int] $FrameCount
    )

    [string[]] $probeOutput = & $FfprobePath @(
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries',
        'stream=codec_name,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,nb_frames',
        '-of', 'json',
        $Path
    )
    if ($LASTEXITCODE -ne 0) {
        throw "FFprobe failed while verifying $Path"
    }

    [pscustomobject] $probe = [string]::Join([Environment]::NewLine, $probeOutput) |
        ConvertFrom-Json
    [object[]] $streams = @($probe.streams)
    if ($streams.Count -ne 1) {
        throw "Expected exactly one probed video stream in $Path"
    }
    [pscustomobject] $stream = $streams[0]
    [System.Collections.Specialized.OrderedDictionary] $expectedValues = [ordered] @{
        codec_name = $CodecName
        pix_fmt = $PixelFormat
        width = $Width
        height = $Height
        color_range = 'tv'
        color_space = $Matrix
        color_transfer = $Transfer
        color_primaries = $Primaries
        nb_frames = [string] $FrameCount
    }
    foreach ($propertyName in $expectedValues.Keys) {
        [string] $actualValue = [string] $stream.$propertyName
        [string] $expectedValue = [string] $expectedValues[$propertyName]
        if ($actualValue -ne $expectedValue) {
            throw "Unexpected $propertyName in ${Path}: expected $expectedValue, got $actualValue"
        }
    }
}

function Invoke-RawDecode {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $PixelFormat,

        [Parameter(Mandatory)]
        [string] $Name
    )

    [string] $rawPath = Join-Path $OutputDirectory ".$Name.verify.raw"
    & $FfmpegPath @(
        '-hide_banner',
        '-loglevel', 'warning',
        '-y',
        '-i', $Path,
        '-map', '0:v:0',
        '-an',
        '-fps_mode', 'passthrough',
        '-pix_fmt', $PixelFormat,
        '-f', 'rawvideo',
        $rawPath
    )
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg failed while decoding $Name for raw-plane verification"
    }
    return $rawPath
}

function Read-RawSample {
    param(
        [Parameter(Mandatory)]
        [System.IO.FileStream] $Stream,

        [Parameter(Mandatory)]
        [long] $ByteOffset,

        [Parameter(Mandatory)]
        [ValidateSet(1, 2)]
        [int] $BytesPerSample
    )

    [void] $Stream.Seek($ByteOffset, [System.IO.SeekOrigin]::Begin)
    [int] $lowByte = $Stream.ReadByte()
    if ($lowByte -lt 0) {
        throw 'Raw-plane verification reached an unexpected end of file'
    }
    if ($BytesPerSample -eq 1) {
        return $lowByte
    }

    [int] $highByte = $Stream.ReadByte()
    if ($highByte -lt 0) {
        throw 'Raw-plane verification reached an incomplete 16-bit sample'
    }
    return $lowByte -bor ($highByte -shl 8)
}

function Get-TextSHA256 {
    param(
        [Parameter(Mandatory)]
        [string] $Text
    )

    [System.Security.Cryptography.SHA256] $algorithm =
        [System.Security.Cryptography.SHA256]::Create()
    try {
        [byte[]] $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        [byte[]] $hash = $algorithm.ComputeHash($bytes)
        return [Convert]::ToHexString($hash).ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-FileSHA256 {
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-UniformRawPlanes {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter(Mandatory)]
        [string] $PixelFormat,

        [Parameter(Mandatory)]
        [int] $BitDepth,

        [Parameter(Mandatory)]
        [int[]] $YLevels,

        [Parameter(Mandatory)]
        [int[]] $CbLevels,

        [Parameter(Mandatory)]
        [int[]] $CrLevels
    )

    [string] $rawPath = Invoke-RawDecode -Path $Path -PixelFormat $PixelFormat -Name $Name
    try {
        [int] $bytesPerSample = if ($BitDepth -gt 8) { 2 } else { 1 }
        [long] $lumaSampleCount = [long] $Width * $Height
        [long] $chromaSampleCount = [long] ($Width / 2) * ($Height / 2)
        [long] $frameSampleCount = $lumaSampleCount + (2 * $chromaSampleCount)
        [long] $frameByteLength = $frameSampleCount * $bytesPerSample
        [long] $expectedByteLength = $frameByteLength * $YLevels.Count
        [System.IO.FileStream] $stream = [System.IO.File]::OpenRead($rawPath)
        try {
            if ($stream.Length -ne $expectedByteLength) {
                throw "Unexpected decoded byte length for $Name"
            }
            [long[]] $probeSampleIndexes = @(
                0,
                [long] ($lumaSampleCount / 2),
                ($lumaSampleCount - 1)
            )
            for ([int] $frameIndex = 0; $frameIndex -lt $YLevels.Count; $frameIndex += 1) {
                [long] $frameOffset = $frameIndex * $frameByteLength
                foreach ($sampleIndex in $probeSampleIndexes) {
                    [int] $actualY = Read-RawSample -Stream $stream `
                        -ByteOffset ($frameOffset + ($sampleIndex * $bytesPerSample)) `
                        -BytesPerSample $bytesPerSample
                    if ($actualY -ne $YLevels[$frameIndex]) {
                        throw "Decoded Y plane mismatch in $Name frame $frameIndex"
                    }
                }
                [long] $cbOffset = $frameOffset + ($lumaSampleCount * $bytesPerSample)
                [long] $crOffset = $cbOffset + ($chromaSampleCount * $bytesPerSample)
                foreach ($chromaOffset in @($cbOffset, $crOffset)) {
                    [int] $expectedChroma = if ($chromaOffset -eq $cbOffset) {
                        $CbLevels[$frameIndex]
                    } else {
                        $CrLevels[$frameIndex]
                    }
                    [int] $actualChroma = Read-RawSample -Stream $stream `
                        -ByteOffset $chromaOffset `
                        -BytesPerSample $bytesPerSample
                    if ($actualChroma -ne $expectedChroma) {
                        throw "Decoded chroma plane mismatch in $Name frame $frameIndex"
                    }
                }
            }
        } finally {
            $stream.Dispose()
        }
    } finally {
        Remove-Item -LiteralPath $rawPath -Force -ErrorAction SilentlyContinue
    }
}

function New-QuadrantExpression {
    param(
        [Parameter(Mandatory)]
        [int[]] $Levels
    )

    if ($Levels.Count -ne 4) {
        throw 'A spatial validation fixture requires four quadrant levels'
    }
    return "if(lt(Y,H/2),if(lt(X,W/2),$($Levels[0]),$($Levels[1]))," +
        "if(lt(X,W/2),$($Levels[2]),$($Levels[3])))"
}

function Assert-SpatialRawPlanes {
    param(
        [Parameter(Mandatory)]
        [string] $Path,

        [Parameter(Mandatory)]
        [string] $Name,

        [Parameter(Mandatory)]
        [string] $PixelFormat,

        [Parameter(Mandatory)]
        [int] $BitDepth,

        [Parameter(Mandatory)]
        [int[]] $YLevels,

        [Parameter(Mandatory)]
        [int[]] $CbLevels,

        [Parameter(Mandatory)]
        [int[]] $CrLevels
    )

    [string] $rawPath = Invoke-RawDecode -Path $Path -PixelFormat $PixelFormat -Name $Name
    try {
        [int] $bytesPerSample = if ($BitDepth -gt 8) { 2 } else { 1 }
        [int] $chromaWidth = $Width / 2
        [int] $chromaHeight = $Height / 2
        [long] $lumaSampleCount = [long] $Width * $Height
        [long] $chromaSampleCount = [long] $chromaWidth * $chromaHeight
        [long] $expectedByteLength = ($lumaSampleCount + (2 * $chromaSampleCount)) *
            $bytesPerSample
        [double[]] $sampleXFractions = @(0.25, 0.75, 0.25, 0.75)
        [double[]] $sampleYFractions = @(0.25, 0.25, 0.75, 0.75)
        [System.IO.FileStream] $stream = [System.IO.File]::OpenRead($rawPath)
        try {
            if ($stream.Length -ne $expectedByteLength) {
                throw "Unexpected decoded byte length for $Name"
            }
            for ([int] $quadrantIndex = 0; $quadrantIndex -lt 4; $quadrantIndex += 1) {
                [int] $lumaX = [Math]::Floor($Width * $sampleXFractions[$quadrantIndex])
                [int] $lumaY = [Math]::Floor($Height * $sampleYFractions[$quadrantIndex])
                [int] $chromaX = [Math]::Floor($chromaWidth * $sampleXFractions[$quadrantIndex])
                [int] $chromaY = [Math]::Floor($chromaHeight * $sampleYFractions[$quadrantIndex])
                [long] $lumaOffset = (($lumaY * $Width) + $lumaX) * $bytesPerSample
                [long] $cbOffset = ($lumaSampleCount +
                    ($chromaY * $chromaWidth) + $chromaX) * $bytesPerSample
                [long] $crOffset = ($lumaSampleCount + $chromaSampleCount +
                    ($chromaY * $chromaWidth) + $chromaX) * $bytesPerSample
                [int[]] $actualCodes = @(
                    (Read-RawSample -Stream $stream -ByteOffset $lumaOffset `
                        -BytesPerSample $bytesPerSample),
                    (Read-RawSample -Stream $stream -ByteOffset $cbOffset `
                        -BytesPerSample $bytesPerSample),
                    (Read-RawSample -Stream $stream -ByteOffset $crOffset `
                        -BytesPerSample $bytesPerSample)
                )
                [int[]] $expectedCodes = @(
                    $YLevels[$quadrantIndex],
                    $CbLevels[$quadrantIndex],
                    $CrLevels[$quadrantIndex]
                )
                if ([string]::Join(',', $actualCodes) -ne [string]::Join(',', $expectedCodes)) {
                    throw "Decoded quadrant $quadrantIndex mismatch in $Name"
                }
            }
        } finally {
            $stream.Dispose()
        }
    } finally {
        Remove-Item -LiteralPath $rawPath -Force -ErrorAction SilentlyContinue
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
        [string] $CodecName,

        [Parameter(Mandatory)]
        [int] $BitDepth,

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
        "geq=lum='$yExpression':cb='$cbExpression':cr='$crExpression'," +
        "setparams=range=limited:color_primaries=${Primaries}:" +
        "color_trc=${Transfer}:colorspace=$Matrix"
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
    Assert-VideoStreamMetadata `
        -Path $outputPath `
        -CodecName $CodecName `
        -PixelFormat $PixelFormat `
        -Transfer $Transfer `
        -Primaries $Primaries `
        -Matrix $Matrix `
        -FrameCount $frameCount
    Assert-UniformRawPlanes `
        -Path $outputPath `
        -Name $Name `
        -PixelFormat $PixelFormat `
        -BitDepth $BitDepth `
        -YLevels $YLevels `
        -CbLevels $CbLevels `
        -CrLevels $CrLevels
}

function Invoke-SpatialValidationEncode {
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
        [string] $CodecName,

        [Parameter(Mandatory)]
        [int] $BitDepth,

        [Parameter(Mandatory)]
        [string[]] $EncoderArguments
    )

    [string] $yExpression = New-QuadrantExpression -Levels $YLevels
    [string] $cbExpression = New-QuadrantExpression -Levels $CbLevels
    [string] $crExpression = New-QuadrantExpression -Levels $CrLevels
    [string] $filter = "nullsrc=size=$($Width)x$($Height):rate=1:duration=1," +
        "format=$PixelFormat," +
        "geq=lum='$yExpression':cb='$cbExpression':cr='$crExpression'," +
        "setparams=range=limited:color_primaries=${Primaries}:" +
        "color_trc=${Transfer}:colorspace=$Matrix"
    [string] $outputPath = Join-Path $OutputDirectory "$Name.mp4"
    [string] $overwriteArgument = if ($Overwrite) { '-y' } else { '-n' }
    [string[]] $arguments = @(
        '-hide_banner',
        '-loglevel', 'warning',
        $overwriteArgument,
        '-f', 'lavfi',
        '-i', $filter,
        '-frames:v', '1',
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
    Assert-VideoStreamMetadata `
        -Path $outputPath `
        -CodecName $CodecName `
        -PixelFormat $PixelFormat `
        -Transfer $Transfer `
        -Primaries $Primaries `
        -Matrix $Matrix `
        -FrameCount 1
    Assert-SpatialRawPlanes `
        -Path $outputPath `
        -Name $Name `
        -PixelFormat $PixelFormat `
        -BitDepth $BitDepth `
        -YLevels $YLevels `
        -CbLevels $CbLevels `
        -CrLevels $CrLevels
}

if (-not (Get-Command $FfmpegPath -ErrorAction SilentlyContinue)) {
    throw "FFmpeg was not found at '$FfmpegPath'"
}
if (-not (Get-Command $FfprobePath -ErrorAction SilentlyContinue)) {
    throw "FFprobe was not found at '$FfprobePath'"
}
if (($Width % 2) -ne 0 -or ($Height % 2) -ne 0) {
    throw 'Validation media dimensions must be even for YUV 4:2:0'
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
    -CodecName 'h264' `
    -BitDepth 8 `
    -EncoderArguments @(
        '-preset', 'slow',
        '-crf', '0',
        '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'
    )

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
    -CodecName 'hevc' `
    -BitDepth 10 `
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
    -CodecName 'hevc' `
    -BitDepth 10 `
    -EncoderArguments @('-tag:v', 'hvc1', '-preset', 'slow', '-x265-params', 'lossless=1:repeat-headers=1')

[int[]] $spatialSampleIndexes = @(5, 6, 7, 2)
[int[]] $spatialYLevels = @()
[int[]] $spatialCbLevels = @()
[int[]] $spatialCrLevels = @()
foreach ($spatialSampleIndex in $spatialSampleIndexes) {
    $spatialYLevels += $hdrCodes.YLevels[$spatialSampleIndex]
    $spatialCbLevels += $hdrCodes.CbLevels[$spatialSampleIndex]
    $spatialCrLevels += $hdrCodes.CrLevels[$spatialSampleIndex]
}
Invoke-SpatialValidationEncode `
    -Name 'pq-bt2020-spatial' `
    -YLevels $spatialYLevels `
    -CbLevels $spatialCbLevels `
    -CrLevels $spatialCrLevels `
    -PixelFormat 'yuv420p10le' `
    -Transfer 'smpte2084' `
    -Primaries 'bt2020' `
    -Matrix 'bt2020nc' `
    -Encoder 'libx265' `
    -CodecName 'hevc' `
    -BitDepth 10 `
    -EncoderArguments @('-tag:v', 'hvc1', '-preset', 'slow', '-x265-params', 'lossless=1:repeat-headers=1')

[long[]] $timestampsMicroseconds = @()
for ([int] $frameIndex = 0; $frameIndex -lt $desiredRGBTriplets.Count; $frameIndex += 1) {
    $timestampsMicroseconds += [long] $frameIndex * 1000000
}

[string] $canonicalRampDefinitionJSON = [ordered] @{
    encodedRGBTriplets = [ordered] @{
        sdr = $sdrCodes.ExactRGBTriplets
        pq = $hdrCodes.ExactRGBTriplets
        hlg = $hdrCodes.ExactRGBTriplets
    }
    frameIntervalMicroseconds = 1000000
    timestampsMicroseconds = $timestampsMicroseconds
} | ConvertTo-Json -Compress -Depth 6

$manifest = [ordered] @{
    fixtureIdentity = [ordered] @{
        id = $FixtureSetId
        schemaVersion = $FixtureSchemaVersion
        canonicalRampSHA256 = Get-TextSHA256 -Text $canonicalRampDefinitionJSON
    }
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
        spatialPQ = 'pq-bt2020-spatial.mp4'
    }
    fileSHA256 = [ordered] @{
        sdr = Get-FileSHA256 -Path (Join-Path $OutputDirectory 'sdr-bt709-ramp.mp4')
        pq = Get-FileSHA256 -Path (Join-Path $OutputDirectory 'pq-bt2020-ramp.mp4')
        hlg = Get-FileSHA256 -Path (Join-Path $OutputDirectory 'hlg-bt2020-ramp.mp4')
        spatialPQ = Get-FileSHA256 -Path (Join-Path $OutputDirectory 'pq-bt2020-spatial.mp4')
    }
    spatialFixture = [ordered] @{
        quadrantOrder = @('top-left', 'top-right', 'bottom-left', 'bottom-right')
        encodedRGBTriplets = @(
            $hdrCodes.ExactRGBTriplets[5],
            $hdrCodes.ExactRGBTriplets[6],
            $hdrCodes.ExactRGBTriplets[7],
            $hdrCodes.ExactRGBTriplets[2]
        )
        encodedYUVCodeTriplets = @(
            $hdrCodes.YUVCodeTriplets[5],
            $hdrCodes.YUVCodeTriplets[6],
            $hdrCodes.YUVCodeTriplets[7],
            $hdrCodes.YUVCodeTriplets[2]
        )
    }
    verification = [ordered] @{
        ffprobeStreamMetadata = $true
        decodedRawPlanes = $true
    }
}
[string] $manifestJSON = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'manifest.json'),
    $manifestJSON + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Generated deterministic validation media in $OutputDirectory"
