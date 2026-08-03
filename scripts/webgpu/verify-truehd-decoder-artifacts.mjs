#!/usr/bin/env node

/* eslint-disable compat/compat -- This release check targets Node 24 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..');
const TRUEHD_RUNTIME_DIRECTORY = resolve(REPOSITORY_ROOT, 'src/lib/ffmpeg-truehd');
const TRUEHD_ARTIFACT_DIRECTORY = resolve(
    REPOSITORY_ROOT,
    'scripts/webgpu/truehd/artifacts'
);
const TRUEHD_FIXTURE_DIRECTORY = resolve(
    REPOSITORY_ROOT,
    'scripts/webgpu/truehd/fixtures'
);
const FFMPEG_COMMIT = 'a59498db085e3d635532397128550141ab87408a';
const FFMPEG_SOURCE_SHA256 =
    'fff68fd0b5061b1befba1cd9fc95357d9fc85eb3201bfed597c70d5f8033567e';
const EMSCRIPTEN_VERSION = '4.0.13';
const EMSCRIPTEN_REVISION = '2659582941bef14008476903f48941909db1b196';
const EXPECTED_RUNTIME_HASHES = Object.freeze({
    'ffmpeg-truehd.d.mts': '8f4b6275ad3ad3c5ffa57dd9e9c729406426cc23be0cad7af5a5a41f8eb871b4',
    'ffmpeg-truehd.mjs': 'e69f9e1e7fbfdd2b7c8c750de59ccfb887c88c633e407c4b46a8ce875d13c630'
});
const EXPECTED_ARTIFACT_HASHES = Object.freeze({
    'COPYING.LGPLv2.1': '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30',
    'REVISION': '560a0867d5844aa17aace689fe7170b369a4ed86fe3267cdd4de50ee170a57b1',
    'ffmpeg-source.tar.gz': FFMPEG_SOURCE_SHA256
});
const EXPECTED_BRIDGE_SHA256 =
    'afc1314afac62f3985a814706ef2ec471d2015b61816cb5df751e9dae4711bf2';
const EXPECTED_FIXTURE_HASHES = Object.freeze({
    'mlp_stereo_24_48000.mlp': '0a8ecef742d164ad74d99576b22e4688ef76e899ca36ce601666b2c8c71d1d72',
    'truehd_51_side_24_96000.mka': 'ddeafef97bd560b548ae93af4cc02f7aa43c7a69b231471d93922e7e36fbbf9e',
    'truehd_51_side_24_96000.truehd': '0bbfcaa1910a92ef9a1434ec8ba3bc99f8f5e7309bde2305282d4d3c19d5953e',
    'truehd_51_side_24_192000.truehd': 'b6d447fd0d80c8fe1b624742cb64cd2161569eca3c1f0e32c292cc6404e369ce',
    'truehd_stereo_24_48000.truehd': '4ae1dd30bae837f377e094fbc180c9c642a6b874331220d0bb42a6afecd1fb32'
});
const REQUIRED_EXPORTS = Object.freeze([
    'jellyfin_truehd_clear',
    'jellyfin_truehd_configure_packet',
    'jellyfin_truehd_create',
    'jellyfin_truehd_destroy',
    'jellyfin_truehd_get_bits_per_raw_sample',
    'jellyfin_truehd_get_bytes_per_sample',
    'jellyfin_truehd_get_channel_count',
    'jellyfin_truehd_get_channel_mask',
    'jellyfin_truehd_get_interleaved_data',
    'jellyfin_truehd_get_profile',
    'jellyfin_truehd_get_pts',
    'jellyfin_truehd_get_sample_count',
    'jellyfin_truehd_get_sample_format',
    'jellyfin_truehd_get_sample_rate',
    'jellyfin_truehd_library_version',
    'jellyfin_truehd_receive_frame',
    'jellyfin_truehd_send_packet'
]);
const MUTABLE_BUILD_PATH_PATTERN =
    /(?:[a-z]:[\\/](?:users|temp)[\\/]|@workbench|appdata[\\/]|\/tmp\/jellyfin-)/iu;

function getSHA256(data) {
    return createHash('sha256').update(data).digest('hex');
}

async function verifyHashTable(directory, expectedHashes, kind) {
    for (const [ fileName, expectedHash ] of Object.entries(expectedHashes)) {
        const data = await readFile(resolve(directory, fileName));
        const actualHash = getSHA256(data);
        if (actualHash !== expectedHash) {
            throw new Error(`TrueHD ${kind} ${fileName} hash mismatch: ${actualHash}`);
        }
    }
}

async function verifyModuleExports() {
    const moduleSource = await readFile(
        resolve(TRUEHD_RUNTIME_DIRECTORY, 'ffmpeg-truehd.mjs'),
        'utf8'
    );
    for (const exportName of REQUIRED_EXPORTS) {
        if (!moduleSource.includes(exportName)) {
            throw new Error(`TrueHD artifact is missing export ${exportName}`);
        }
    }
    if (!moduleSource.includes('base64Decode("AGFzb')) {
        throw new Error('TrueHD artifact does not contain its bounded WebAssembly payload');
    }
    if (MUTABLE_BUILD_PATH_PATTERN.test(moduleSource)) {
        throw new Error('TrueHD artifact contains a mutable local build path');
    }
}

async function verifyBuildPins() {
    const [ buildScript, commonBuildScript, bridge, bridgeLicense ] = await Promise.all([
        readFile(
            resolve(REPOSITORY_ROOT, 'scripts/webgpu/build_truehd_decoder.py'),
            'utf8'
        ),
        readFile(
            resolve(REPOSITORY_ROOT, 'scripts/webgpu/pinned_ffmpeg_build.py'),
            'utf8'
        ),
        readFile(
            resolve(REPOSITORY_ROOT, 'scripts/webgpu/truehd/ffmpeg_truehd_bridge.c')
        ),
        readFile(resolve(REPOSITORY_ROOT, 'LICENSE'), 'utf8')
    ]);
    const buildSources = `${buildScript}\n${commonBuildScript}`;
    for (const requiredPin of [
        FFMPEG_COMMIT,
        FFMPEG_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        '--enable-decoder=mlp',
        '--enable-decoder=truehd',
        '--disable-gpl',
        '--disable-iconv',
        '--disable-nonfree',
        '--verify-reproducible',
        'require_emscripten_version',
        'resolve_build_layout',
        'standalone_archive',
        '-ffile-prefix-map=',
        'TemporaryDirectory',
        'copy_if_different',
        'require_ffmpeg_configuration',
        'SOURCE_DATE_EPOCH',
        'ZERO_AR_DATE',
        'EMCC_CFLAGS',
        'member_destination.is_relative_to',
        'temporary_path.replace'
    ]) {
        if (!buildSources.includes(requiredPin)) {
            throw new Error(`TrueHD build script is missing pin ${requiredPin}`);
        }
    }
    for (const forbiddenMarker of [
        'DEFAULT_FFMPEG_DIRECTORY',
        '--ffmpeg-directory',
        'repository_root.parent / "ffmpeg"'
    ]) {
        if (buildSources.includes(forbiddenMarker)) {
            throw new Error(`TrueHD build retains mutable input ${forbiddenMarker}`);
        }
    }
    if (getSHA256(bridge) !== EXPECTED_BRIDGE_SHA256) {
        throw new Error('TrueHD bridge source hash does not match the release record');
    }
    const bridgeSource = bridge.toString('utf8');
    if (!bridgeSource.includes('GPL-2.0-or-later')
        || !bridgeLicense.includes('GNU GENERAL PUBLIC LICENSE')) {
        throw new Error('TrueHD bridge GPL source or license is invalid');
    }
    const license = await readFile(
        resolve(TRUEHD_ARTIFACT_DIRECTORY, 'COPYING.LGPLv2.1'),
        'utf8'
    );
    if (!license.includes('GNU LESSER GENERAL PUBLIC LICENSE')
        || !license.includes('Version 2.1')) {
        throw new Error('TrueHD artifact LGPL-2.1 license text is invalid');
    }
    const revision = await readFile(
        resolve(TRUEHD_ARTIFACT_DIRECTORY, 'REVISION'),
        'utf8'
    );
    for (const requiredPin of [
        FFMPEG_COMMIT,
        FFMPEG_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        EXPECTED_BRIDGE_SHA256,
        EXPECTED_RUNTIME_HASHES['ffmpeg-truehd.mjs'],
        'LGPL version 2.1 or later',
        'Isolated reproducible rebuild: verified'
    ]) {
        if (!revision.includes(requiredPin)) {
            throw new Error(`TrueHD artifact revision is missing pin ${requiredPin}`);
        }
    }
}

await verifyHashTable(TRUEHD_RUNTIME_DIRECTORY, EXPECTED_RUNTIME_HASHES, 'runtime');
await verifyHashTable(TRUEHD_ARTIFACT_DIRECTORY, EXPECTED_ARTIFACT_HASHES, 'artifact');
await verifyHashTable(TRUEHD_FIXTURE_DIRECTORY, EXPECTED_FIXTURE_HASHES, 'fixture');
await verifyModuleExports();
await verifyBuildPins();
console.log('Verified pinned FFmpeg TrueHD/MLP WebAssembly, source, license, fixtures, and exports.');

/* eslint-enable compat/compat */
