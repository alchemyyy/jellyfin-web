#!/usr/bin/env node

/* eslint-disable compat/compat -- This release check targets Node 24 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..');
const DTS_RUNTIME_DIRECTORY = resolve(REPOSITORY_ROOT, 'src/lib/libdcadec');
const DTS_ARTIFACT_DIRECTORY = resolve(REPOSITORY_ROOT, 'scripts/webgpu/dts/artifacts');
const DTS_FIXTURE_DIRECTORY = resolve(REPOSITORY_ROOT, 'scripts/webgpu/dts/fixtures');
const LIBDCADEC_COMMIT = 'b93deed1a231dd6dd7e39b9fe7d2abe05aa00158';
const LIBDCADEC_SOURCE_SHA256 =
    'a33105039c74f913264ba4cca5d40e23d25b11f4149c9411fe4aad4d1c6a3a41';
const EMSCRIPTEN_VERSION = '4.0.13';
const EMSCRIPTEN_REVISION = '2659582941bef14008476903f48941909db1b196';
const EXPECTED_ARTIFACT_HASHES = Object.freeze({
    'COPYING.LGPLv2.1': 'dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551',
    'REVISION': '66518d949828ef054b6cb042f3fe185032af802b5c56398b4b3d2b1702bf68c4',
    'libdcadec-source.tar.gz': LIBDCADEC_SOURCE_SHA256
});
const EXPECTED_BRIDGE_SHA256 =
    'c559bfbe26cdda5d1a865df3124df788d6c9387d1edd46163ee2083e450d78d8';
const EXPECTED_RUNTIME_SHA256 =
    'baffcd99728856cd7f8300e92425b0c59d444988e7d3370aa5dc9de72b446073';
const EXPECTED_FIXTURE_HASHES = Object.freeze({
    'core_51_24_48_768_0.mka': '8a82706387b2609b1d6fce40fc65dea860cfd4e5a6f7f7021bb4480af09e8c6d',
    'xll_51_16_192_768_0.dtshd': '34441a4f2df89e086f67a7b0f72aa871e1cbb3b04b301470a7727038bb91b618'
});
const REQUIRED_EXPORTS = Object.freeze([
    'jellyfin_dts_clear',
    'jellyfin_dts_configure_packet',
    'jellyfin_dts_create',
    'jellyfin_dts_decode_packet',
    'jellyfin_dts_destroy',
    'jellyfin_dts_get_bits_per_sample',
    'jellyfin_dts_get_channel_mask',
    'jellyfin_dts_get_filter_status',
    'jellyfin_dts_get_parse_status',
    'jellyfin_dts_get_plane',
    'jellyfin_dts_get_profile',
    'jellyfin_dts_get_sample_count',
    'jellyfin_dts_get_sample_rate',
    'jellyfin_dts_library_version'
]);
const MUTABLE_BUILD_PATH_PATTERN =
    /(?:[a-z]:[\\/](?:users|temp)[\\/]|@workbench|appdata[\\/]|\/tmp\/jellyfin-)/iu;

function getSHA256(data) {
    return createHash('sha256').update(data).digest('hex');
}

async function verifyFileHashes() {
    for (const [ fileName, expectedHash ] of Object.entries(EXPECTED_ARTIFACT_HASHES)) {
        const data = await readFile(resolve(DTS_ARTIFACT_DIRECTORY, fileName));
        const actualHash = getSHA256(data);
        if (actualHash !== expectedHash) {
            throw new Error(
                `DTS artifact ${fileName} hash mismatch: ${actualHash}`
            );
        }
    }
    for (const [ fileName, expectedHash ] of Object.entries(EXPECTED_FIXTURE_HASHES)) {
        const data = await readFile(resolve(DTS_FIXTURE_DIRECTORY, fileName));
        const actualHash = getSHA256(data);
        if (actualHash !== expectedHash) {
            throw new Error(
                `DTS fixture ${fileName} hash mismatch: ${actualHash}`
            );
        }
    }
    const moduleData = await readFile(resolve(DTS_RUNTIME_DIRECTORY, 'libdcadec.mjs'));
    const moduleHash = getSHA256(moduleData);
    if (moduleHash !== EXPECTED_RUNTIME_SHA256) {
        throw new Error(`DTS artifact libdcadec.mjs hash mismatch: ${moduleHash}`);
    }
}

async function verifyModuleExports() {
    const moduleSource = await readFile(
        resolve(DTS_RUNTIME_DIRECTORY, 'libdcadec.mjs'),
        'utf8'
    );
    for (const exportName of REQUIRED_EXPORTS) {
        if (!moduleSource.includes(exportName)) {
            throw new Error(`DTS artifact is missing export ${exportName}`);
        }
    }
    if (!moduleSource.includes('base64Decode("AGFzb')) {
        throw new Error('DTS artifact does not contain its bounded WebAssembly payload');
    }
    if (MUTABLE_BUILD_PATH_PATTERN.test(moduleSource)) {
        throw new Error('DTS artifact contains a mutable local build path');
    }
}

async function verifyBuildPins() {
    const [ buildScript, bridge, bridgeLicense ] = await Promise.all([
        readFile(
            resolve(REPOSITORY_ROOT, 'scripts/webgpu/build_dts_decoder.py'),
            'utf8'
        ),
        readFile(resolve(REPOSITORY_ROOT, 'scripts/webgpu/dts/libdcadec_bridge.c')),
        readFile(resolve(REPOSITORY_ROOT, 'LICENSE'), 'utf8')
    ]);
    for (const requiredPin of [
        LIBDCADEC_COMMIT,
        LIBDCADEC_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        '--verify-reproducible',
        'require_emscripten_version',
        'resolve_build_layout',
        'select_source_archive',
        'standalone_archive',
        'packaged_archive',
        'SOURCE_DATE_EPOCH',
        'ZERO_AR_DATE',
        'EMCC_CFLAGS',
        'member_destination.is_relative_to',
        'temporary_path.replace',
        '-ffile-prefix-map=',
        'TemporaryDirectory'
    ]) {
        if (!buildScript.includes(requiredPin)) {
            throw new Error(`DTS build script is missing pin ${requiredPin}`);
        }
    }
    if (getSHA256(bridge) !== EXPECTED_BRIDGE_SHA256) {
        throw new Error('DTS bridge source hash does not match the release record');
    }
    const bridgeSource = bridge.toString('utf8');
    if (!bridgeSource.includes('GPL-2.0-or-later')
        || !bridgeLicense.includes('GNU GENERAL PUBLIC LICENSE')) {
        throw new Error('DTS bridge GPL source or license is invalid');
    }
    const license = await readFile(
        resolve(DTS_ARTIFACT_DIRECTORY, 'COPYING.LGPLv2.1'),
        'utf8'
    );
    if (!license.includes('GNU LESSER GENERAL PUBLIC LICENSE')
        || !license.includes('Version 2.1')) {
        throw new Error('DTS artifact LGPL-2.1 license text is invalid');
    }
    const revision = await readFile(
        resolve(DTS_ARTIFACT_DIRECTORY, 'REVISION'),
        'utf8'
    );
    for (const requiredPin of [
        LIBDCADEC_COMMIT,
        LIBDCADEC_SOURCE_SHA256,
        EMSCRIPTEN_VERSION,
        EMSCRIPTEN_REVISION,
        EXPECTED_BRIDGE_SHA256,
        EXPECTED_RUNTIME_SHA256,
        'Isolated reproducible rebuild: verified'
    ]) {
        if (!revision.includes(requiredPin)) {
            throw new Error(`DTS artifact revision is missing pin ${requiredPin}`);
        }
    }
}

await verifyFileHashes();
await verifyModuleExports();
await verifyBuildPins();
console.log('Verified pinned libdcadec WebAssembly, source, license, and exports.');

/* eslint-enable compat/compat */
