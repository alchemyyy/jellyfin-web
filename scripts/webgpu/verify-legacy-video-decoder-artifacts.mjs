#!/usr/bin/env node

/* eslint-disable compat/compat -- This release check targets Node 24 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..');
const LEGACY_DIRECTORY = resolve(
    REPOSITORY_ROOT,
    'scripts/webgpu/legacy-video-decoder'
);
const ARTIFACT_DIRECTORY = resolve(LEGACY_DIRECTORY, 'artifacts');
const FFMPEG_COMMIT = 'a59498db085e3d635532397128550141ab87408a';
const FFMPEG_SOURCE_SHA256 =
    'fff68fd0b5061b1befba1cd9fc95357d9fc85eb3201bfed597c70d5f8033567e';
const EMSCRIPTEN_VERSION = '4.0.13';
const EMSCRIPTEN_REVISION = '2659582941bef14008476903f48941909db1b196';
const EXPECTED_BRIDGE_SHA256 =
    'a9853ba5b679967dd8675cec0e7a2370da2ec972a18d12e084edbb79dcf682da';
const EXPECTED_FILE_HASHES = Object.freeze({
    'legacy-video-decode.js':
        'd43c51795d5d77ae5dd1bd7cda5bb086d90e91638030165645a4295a08ea1563',
    'legacy-video-decode.wasm':
        '322a09a902af2b896958b6685f399fc44c73be3dc2d4c67b66eaf5ee3857149a',
    'manifest.json':
        '3299b701c5c9e95dd798bbb2670ede934837e71f48779bb706f77a99597033d8'
});
const EXPECTED_LICENSE_SHA256 =
    '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30';
const EXPECTED_REVISION_SHA256 =
    '3c5338127bdc80b6e02687f03d2d388b6db744056cb56c7bb557aab94f44d5e2';
const EXPECTED_FIXTURE_SHA256 =
    '86db9dfebafb85c3c6001c762c5a1c91427d2039fcd5fbffba8c8c42efaf43b1';
const REQUIRED_EXPORTS = Object.freeze([
    'legacy_video_decoder_close',
    'legacy_video_decoder_configure_packet',
    'legacy_video_decoder_create',
    'legacy_video_decoder_frame_is_i420',
    'legacy_video_decoder_get_height',
    'legacy_video_decoder_get_interlaced',
    'legacy_video_decoder_get_plane',
    'legacy_video_decoder_get_stride',
    'legacy_video_decoder_get_width',
    'legacy_video_decoder_open',
    'legacy_video_decoder_receive_frame',
    'legacy_video_decoder_send_packet',
    'legacy_video_decoder_start_drain'
]);
const MUTABLE_BUILD_PATH_PATTERN =
    /(?:[a-z]:[\\/](?:users|temp)[\\/]|@workbench|appdata[\\/]|\/tmp\/jellyfin-)/iu;

function getSHA256(data) {
    return createHash('sha256').update(data).digest('hex');
}

async function requireFileHash(path, expectedSHA256, label) {
    const actualSHA256 = getSHA256(await readFile(path));
    if (actualSHA256 !== expectedSHA256) {
        throw new Error(`${label} hash mismatch: ${actualSHA256}`);
    }
}

async function verifyArtifactHashes() {
    for (const [ fileName, expectedSHA256 ] of Object.entries(EXPECTED_FILE_HASHES)) {
        await requireFileHash(
            resolve(ARTIFACT_DIRECTORY, fileName),
            expectedSHA256,
            `Legacy video artifact ${fileName}`
        );
    }
    await requireFileHash(
        resolve(LEGACY_DIRECTORY, 'LICENSE.ffmpeg.txt'),
        EXPECTED_LICENSE_SHA256,
        'Legacy video upstream license'
    );
    await requireFileHash(
        resolve(LEGACY_DIRECTORY, 'REVISION'),
        EXPECTED_REVISION_SHA256,
        'Legacy video revision'
    );
    await requireFileHash(
        resolve(
            REPOSITORY_ROOT,
            'scripts/webgpu/legacy-video-decoder/artifacts/ffmpeg-source.tar.gz'
        ),
        FFMPEG_SOURCE_SHA256,
        'Shared pinned FFmpeg source archive'
    );
    await requireFileHash(
        resolve(
            REPOSITORY_ROOT,
            'scripts/webgpu/legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv'
        ),
        EXPECTED_FIXTURE_SHA256,
        'Legacy video qualification fixture'
    );
}

async function verifyManifest() {
    const manifest = JSON.parse(await readFile(
        resolve(ARTIFACT_DIRECTORY, 'manifest.json'),
        'utf8'
    ));
    if (
        manifest.ffmpegRevision !== FFMPEG_COMMIT
        || manifest.ffmpegSourceSHA256 !== FFMPEG_SOURCE_SHA256
        || manifest.emscripten !== EMSCRIPTEN_VERSION
        || manifest.emscriptenRevision !== EMSCRIPTEN_REVISION
        || manifest.bridgeSHA256 !== EXPECTED_BRIDGE_SHA256
        || manifest.license !== 'LGPL version 2.1 or later'
        || manifest.reproducibleBuild !== true
        || JSON.stringify(manifest.decoders) !== JSON.stringify([ 'mpeg2video' ])
    ) {
        throw new Error('Legacy video artifact manifest provenance is invalid');
    }
    const manifestArtifactNames = Object.keys(manifest.artifacts ?? {}).sort();
    const expectedArtifactNames = [
        'legacy-video-decode.js',
        'legacy-video-decode.wasm'
    ];
    if (JSON.stringify(manifestArtifactNames) !== JSON.stringify(expectedArtifactNames)) {
        throw new Error('Legacy video manifest artifact list is invalid');
    }
    for (const fileName of expectedArtifactNames) {
        if (EXPECTED_FILE_HASHES[fileName] !== manifest.artifacts[fileName]) {
            throw new Error(`Legacy video manifest artifact hash is invalid: ${fileName}`);
        }
    }
    const configuredComponents = manifest.configuredComponents;
    const expectedComponents = [
        '--disable-all',
        '--disable-everything',
        '--disable-gpl',
        '--disable-version3',
        '--disable-nonfree',
        '--enable-avcodec',
        '--enable-decoder=mpeg2video'
    ];
    if (JSON.stringify(configuredComponents) !== JSON.stringify(expectedComponents)) {
        throw new Error('Legacy video manifest contains an unexpected FFmpeg component');
    }
}

async function verifyBuildAndBridge() {
    const [ buildScript, commonBuildScript, bridge, bridgeLicense, revision ] =
        await Promise.all([
            readFile(resolve(LEGACY_DIRECTORY, 'build_legacy_video_decoder.py'), 'utf8'),
            readFile(
                resolve(REPOSITORY_ROOT, 'scripts/webgpu/pinned_ffmpeg_build.py'),
                'utf8'
            ),
            readFile(resolve(LEGACY_DIRECTORY, 'bridge.c')),
            readFile(resolve(REPOSITORY_ROOT, 'LICENSE'), 'utf8'),
            readFile(resolve(LEGACY_DIRECTORY, 'REVISION'), 'utf8')
        ]);
    const buildSources = `${buildScript}\n${commonBuildScript}`;
    for (const requiredMarker of [
        FFMPEG_COMMIT,
        FFMPEG_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        '--enable-decoder=mpeg2video',
        '--disable-gpl',
        '--disable-nonfree',
        '--verify-reproducible',
        'require_emscripten_version',
        'SOURCE_TREE_LAYOUT',
        'standalone_archive',
        '-ffile-prefix-map=',
        'TemporaryDirectory',
        'require_ffmpeg_configuration',
        'SOURCE_DATE_EPOCH',
        'ZERO_AR_DATE',
        'EMCC_CFLAGS',
        'member_destination.is_relative_to',
        'temporary_path.replace'
    ]) {
        if (!buildSources.includes(requiredMarker)) {
            throw new Error(`Legacy video build is missing pin ${requiredMarker}`);
        }
    }
    for (const forbiddenMarker of [
        'DEFAULT_FFMPEG_DIRECTORY',
        '--ffmpeg-directory',
        'if [ ! -f config.h ]'
    ]) {
        if (buildScript.includes(forbiddenMarker)) {
            throw new Error(`Legacy video build retains mutable input ${forbiddenMarker}`);
        }
    }
    if (getSHA256(bridge) !== EXPECTED_BRIDGE_SHA256) {
        throw new Error('Legacy video bridge source hash is invalid');
    }
    if (!bridge.toString('utf8').includes('GPL-2.0-or-later')
        || !bridgeLicense.includes('GNU GENERAL PUBLIC LICENSE')) {
        throw new Error('Legacy video bridge GPL source or license is invalid');
    }
    for (const requiredMarker of [
        FFMPEG_COMMIT,
        FFMPEG_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        EXPECTED_BRIDGE_SHA256,
        'Isolated reproducible rebuild: verified'
    ]) {
        if (!revision.includes(requiredMarker)) {
            throw new Error(`Legacy video revision is missing pin ${requiredMarker}`);
        }
    }
}

async function verifyModuleExports() {
    const moduleSource = await readFile(
        resolve(ARTIFACT_DIRECTORY, 'legacy-video-decode.js'),
        'utf8'
    );
    for (const exportName of REQUIRED_EXPORTS) {
        if (!moduleSource.includes(exportName)) {
            throw new Error(`Legacy video artifact is missing export ${exportName}`);
        }
    }
    const wasmSource = (await readFile(
        resolve(ARTIFACT_DIRECTORY, 'legacy-video-decode.wasm')
    )).toString('latin1');
    if (MUTABLE_BUILD_PATH_PATTERN.test(moduleSource)
        || MUTABLE_BUILD_PATH_PATTERN.test(wasmSource)) {
        throw new Error('Legacy video artifact contains a mutable local build path');
    }
}

await verifyArtifactHashes();
await verifyManifest();
await verifyBuildAndBridge();
await verifyModuleExports();
console.log('Verified pinned MPEG-2-only FFmpeg WebAssembly, source, licenses, fixture, and reproducibility.');

/* eslint-enable compat/compat */
