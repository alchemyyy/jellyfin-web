import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createDualTrackDolbyVisionMP4Fixture } from './create-dual-track-dolby-vision-mp4-fixture.mjs';

const execFile = promisify(execFileCallback);
const MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH = 128 * 1_024 * 1_024;
const MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH = 16 * 1_024 * 1_024;
const OUTPUT_FRAME_RATE = '6000/1001';
const SOURCE_LOOP_COUNT = 9;
const TIMESTAMP_FILTER = 'setts=pts=N*1001:dts=N*1001:duration=1001:time_base=1/6000';
const X265_PARAMETERS = 'repeat-headers=1:aud=1:bframes=0:keyint=24:min-keyint=24:scenecut=0';

const USAGE = `Usage:
  node scripts/webgpu/create-profile7-playback-fixture.mjs \\
      <separate-profile7.mkv> <output.mp4> \\
      [--ffmpeg <path>] [--mkvtoolnix-directory <path>]

Creates a validation-only 1080p Profile 7 dual-track MP4 for complete Jellyfin
playback smoke tests. The BL is re-encoded and therefore is not a color-fidelity
reference. The input should be produced by
create-separate-track-dolby-vision-fixture.mjs.`;

export class PlaybackFixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PlaybackFixtureError';
    }
}

export function createStructuralFFmpegArguments(inputPath, outputPath) {
    return [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-stream_loop', String(SOURCE_LOOP_COUNT),
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:v:1',
        '-filter:v:0', 'scale=1920:1080:flags=lanczos',
        '-c:v:0', 'libx265',
        '-preset:v:0', 'ultrafast',
        '-crf:v:0', '30',
        '-pix_fmt:v:0', 'yuv420p10le',
        '-x265-params:v:0', X265_PARAMETERS,
        '-fps_mode:v:0', 'passthrough',
        '-c:v:1', 'copy',
        '-fps_mode:v:1', 'passthrough',
        '-bsf:v:0', TIMESTAMP_FILTER,
        '-bsf:v:1', TIMESTAMP_FILTER,
        '-color_primaries:v:0', 'bt2020',
        '-color_trc:v:0', 'smpte2084',
        '-colorspace:v:0', 'bt2020nc',
        '-color_range:v:0', 'tv',
        '-disposition:v:0', 'default',
        '-disposition:v:1', '0',
        '-map_metadata', '-1',
        outputPath
    ];
}

export function createStructuralMKVMergeArguments(inputPath, outputPath) {
    return [
        '--quiet',
        '--output', outputPath,
        '--deterministic', 'webgpu-profile7-playback',
        '--no-date',
        '--disable-track-statistics-tags',
        '--default-duration', `0:${OUTPUT_FRAME_RATE}p`,
        '--default-duration', `1:${OUTPUT_FRAME_RATE}p`,
        inputPath
    ];
}

function parseArguments(argumentsList) {
    if (argumentsList.includes('--help')) {
        return { help: true };
    }
    let configuredFFmpegPath = null;
    let mkvToolNixDirectory = null;
    const positionalArguments = [];
    for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
        const argument = argumentsList[argumentIndex];
        switch (argument) {
            case '--ffmpeg': {
                const value = argumentsList[argumentIndex + 1];
                if (!value) {
                    throw new PlaybackFixtureError('--ffmpeg requires a path');
                }
                configuredFFmpegPath = resolve(value);
                argumentIndex += 1;
                break;
            }
            case '--mkvtoolnix-directory': {
                const value = argumentsList[argumentIndex + 1];
                if (!value) {
                    throw new PlaybackFixtureError(
                        '--mkvtoolnix-directory requires a path'
                    );
                }
                mkvToolNixDirectory = resolve(value);
                argumentIndex += 1;
                break;
            }
            default:
                positionalArguments.push(argument);
                break;
        }
    }
    if (positionalArguments.length !== 2) {
        throw new PlaybackFixtureError('Expected an input and output path');
    }
    const inputPath = resolve(positionalArguments[0]);
    const outputPath = resolve(positionalArguments[1]);
    if (inputPath === outputPath) {
        throw new PlaybackFixtureError('The output path must differ from the input path');
    }
    return {
        configuredFFmpegPath,
        help: false,
        inputPath,
        mkvToolNixDirectory,
        outputPath
    };
}

async function resolveFFmpeg(configuredPath) {
    if (!configuredPath) {
        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }
    await access(configuredPath);
    return configuredPath;
}

async function resolveMKVMerge(configuredDirectory) {
    const executableName = process.platform === 'win32' ? 'mkvmerge.exe' : 'mkvmerge';
    const candidateDirectories = [];
    if (configuredDirectory) {
        candidateDirectories.push(configuredDirectory);
    }
    if (process.platform === 'win32' && process.env.ProgramFiles) {
        candidateDirectories.push(join(process.env.ProgramFiles, 'MKVToolNix'));
    }
    for (const candidateDirectory of candidateDirectories) {
        const candidatePath = join(candidateDirectory, executableName);
        try {
            await access(candidatePath);
            return candidatePath;
        } catch {
            continue;
        }
    }
    return executableName;
}

function executeTool(executable, argumentsList) {
    return execFile(executable, argumentsList, {
        encoding: 'utf8',
        maxBuffer: MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH,
        windowsHide: true
    });
}

async function createPlaybackFixture(configuration) {
    const sourceFile = await stat(configuration.inputPath);
    if (!sourceFile.isFile() || sourceFile.size > MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH) {
        throw new PlaybackFixtureError('The source fixture size is unsupported');
    }
    const ffmpegPath = await resolveFFmpeg(configuration.configuredFFmpegPath);
    const mkvmergePath = await resolveMKVMerge(configuration.mkvToolNixDirectory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'webgpu-dovi-playback-'));
    const resolvedTemporaryDirectory = resolve(temporaryDirectory);
    if (dirname(resolvedTemporaryDirectory) !== resolve(tmpdir())) {
        throw new PlaybackFixtureError('Refusing to use an unexpected temporary directory');
    }
    try {
        const encodedPath = join(temporaryDirectory, 'encoded.mkv');
        const normalizedPath = join(temporaryDirectory, 'normalized.mkv');
        await executeTool(
            ffmpegPath,
            createStructuralFFmpegArguments(configuration.inputPath, encodedPath)
        );
        await executeTool(
            mkvmergePath,
            createStructuralMKVMergeArguments(encodedPath, normalizedPath)
        );
        const result = await createDualTrackDolbyVisionMP4Fixture({
            configuredFFmpegPath: configuration.configuredFFmpegPath,
            inputPath: normalizedPath,
            outputPath: configuration.outputPath
        });
        return {
            ...result,
            colorFidelityReference: false,
            expectedBaseHeight: 1_080,
            expectedBaseWidth: 1_920,
            expectedEnhancementHeight: 1_080,
            expectedEnhancementWidth: 1_920
        };
    } finally {
        await rm(resolvedTemporaryDirectory, { force: true, recursive: true });
    }
}

async function main() {
    const configuration = parseArguments(process.argv.slice(2));
    if (configuration.help) {
        console.log(USAGE);
        return;
    }
    console.log(JSON.stringify(await createPlaybackFixture(configuration), null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 1;
    });
}
