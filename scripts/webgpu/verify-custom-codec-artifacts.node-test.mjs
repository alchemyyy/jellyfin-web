import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { verifyCustomCodecArtifacts } from './verify-custom-codec-artifacts.mjs';

const temporaryDirectories = [];
const AC3_IMPLEMENTATION_SENTINEL = 'jellyfin-webgpu-mediabunny-ac3-v2';
const HEVC_FILES = Object.freeze([
    [ 'dist/wasm/hevc-decode.js', 'libraries/hevcjs/hevc-decode.js' ],
    [ 'dist/wasm/hevc-decode.wasm', 'libraries/hevcjs/hevc-decode.wasm' ],
    [ 'LICENSE', 'libraries/hevcjs/LICENSE.txt' ]
]);
const HEVC_QUALIFICATION_SOURCE =
    'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc';
const HEVC_QUALIFICATION_SERVED =
    'libraries/hevcjs/main10-4k-qualification.bin';
const DOLBY_VISION_FILES = Object.freeze([
    [
        'scripts/webgpu/dolby-vision-parser/artifacts/dovi-rpu-parser.wasm',
        'libraries/libdovi/dovi-rpu-parser.wasm'
    ],
    [
        'scripts/webgpu/dolby-vision-parser/LICENSE.libdovi.txt',
        'libraries/libdovi/LICENSE.txt'
    ],
    [
        'scripts/webgpu/dolby-vision-parser/REVISION',
        'libraries/libdovi/REVISION'
    ]
]);
const DTS_IMPLEMENTATION_SENTINEL = 'jellyfin_dts_decode_packet';
const PINNED_EMSCRIPTEN_VERSION = '4.0.13';
const PINNED_EMSCRIPTEN_REVISION = '2659582941bef14008476903f48941909db1b196';
const PINNED_FFMPEG_COMMIT = 'a59498db085e3d635532397128550141ab87408a';
const PINNED_FFMPEG_SOURCE_SHA256 =
    'fff68fd0b5061b1befba1cd9fc95357d9fc85eb3201bfed597c70d5f8033567e';
const PINNED_LIBDCADEC_COMMIT = 'b93deed1a231dd6dd7e39b9fe7d2abe05aa00158';
const PINNED_LIBDCADEC_SOURCE_SHA256 =
    'a33105039c74f913264ba4cca5d40e23d25b11f4149c9411fe4aad4d1c6a3a41';
const PINNED_DTS_BRIDGE_SHA256 =
    'c559bfbe26cdda5d1a865df3124df788d6c9387d1edd46163ee2083e450d78d8';
const PINNED_DTS_RUNTIME_SHA256 =
    'baffcd99728856cd7f8300e92425b0c59d444988e7d3370aa5dc9de72b446073';
const PINNED_TRUEHD_BRIDGE_SHA256 =
    'afc1314afac62f3985a814706ef2ec471d2015b61816cb5df751e9dae4711bf2';
const PINNED_TRUEHD_RUNTIME_SHA256 =
    'e69f9e1e7fbfdd2b7c8c750de59ccfb887c88c633e407c4b46a8ce875d13c630';
const PINNED_MPEG2_BRIDGE_SHA256 =
    'a9853ba5b679967dd8675cec0e7a2370da2ec972a18d12e084edbb79dcf682da';
const DTS_FILES = Object.freeze([
    [
        'scripts/webgpu/dts/artifacts/COPYING.LGPLv2.1',
        'libraries/libdcadec/COPYING.LGPLv2.1'
    ],
    [
        'scripts/webgpu/dts/artifacts/REVISION',
        'libraries/libdcadec/REVISION'
    ],
    [
        'scripts/webgpu/dts/artifacts/libdcadec-source.tar.gz',
        'libraries/libdcadec/libdcadec-source.tar.gz'
    ],
    [ 'LICENSE', 'libraries/libdcadec/LICENSE.bridge.GPL-2.0.txt' ],
    [
        'scripts/webgpu/dts/libdcadec_bridge.c',
        'libraries/libdcadec/libdcadec_bridge.c'
    ],
    [
        'scripts/webgpu/build_dts_decoder.py',
        'libraries/libdcadec/build_dts_decoder.py'
    ]
]);
const TRUEHD_IMPLEMENTATION_SENTINEL = 'jellyfin_truehd_send_packet';
const TRUEHD_FILES = Object.freeze([
    [
        'scripts/webgpu/truehd/artifacts/COPYING.LGPLv2.1',
        'libraries/ffmpeg-truehd/COPYING.LGPLv2.1'
    ],
    [
        'scripts/webgpu/truehd/artifacts/REVISION',
        'libraries/ffmpeg-truehd/REVISION'
    ],
    [
        'scripts/webgpu/truehd/artifacts/ffmpeg-source.tar.gz',
        'libraries/ffmpeg-truehd/ffmpeg-source.tar.gz'
    ],
    [ 'LICENSE', 'libraries/ffmpeg-truehd/LICENSE.bridge.GPL-2.0.txt' ],
    [
        'scripts/webgpu/truehd/ffmpeg_truehd_bridge.c',
        'libraries/ffmpeg-truehd/ffmpeg_truehd_bridge.c'
    ],
    [
        'scripts/webgpu/build_truehd_decoder.py',
        'libraries/ffmpeg-truehd/build_truehd_decoder.py'
    ],
    [
        'scripts/webgpu/pinned_ffmpeg_build.py',
        'libraries/ffmpeg-truehd/pinned_ffmpeg_build.py'
    ]
]);
const LEGACY_VIDEO_FILES = Object.freeze([
    [
        'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.js',
        'libraries/legacy-video/legacy-video-decode.js'
    ],
    [
        'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.wasm',
        'libraries/legacy-video/legacy-video-decode.wasm'
    ],
    [
        'scripts/webgpu/legacy-video-decoder/LICENSE.ffmpeg.txt',
        'libraries/legacy-video/LICENSE.ffmpeg.txt'
    ],
    [
        'scripts/webgpu/legacy-video-decoder/REVISION',
        'libraries/legacy-video/REVISION'
    ],
    [
        'scripts/webgpu/legacy-video-decoder/artifacts/ffmpeg-source.tar.gz',
        'libraries/legacy-video/ffmpeg-source.tar.gz'
    ],
    [ 'LICENSE', 'libraries/legacy-video/LICENSE.bridge.GPL-2.0.txt' ],
    [
        'scripts/webgpu/legacy-video-decoder/bridge.c',
        'libraries/legacy-video/bridge.c'
    ],
    [
        'scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py',
        'libraries/legacy-video/build_legacy_video_decoder.py'
    ],
    [
        'scripts/webgpu/pinned_ffmpeg_build.py',
        'libraries/legacy-video/pinned_ffmpeg_build.py'
    ],
    [
        'scripts/webgpu/legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv',
        'libraries/legacy-video/mpeg2-progressive-1920x1080-qualification.bin'
    ]
]);
const OPENJPEG_FILES = Object.freeze([
    [
        'node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.js',
        'libraries/openjpeg/openjpeg-decode.js'
    ],
    [
        'node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm',
        'libraries/openjpeg/openjpeg-decode.wasm'
    ],
    [
        'node_modules/@cornerstonejs/codec-openjpeg/LICENSE',
        'libraries/openjpeg/LICENSE.wrapper.txt'
    ],
    [
        'scripts/webgpu/openjpeg/LICENSE.openjpeg.txt',
        'libraries/openjpeg/LICENSE.openjpeg.txt'
    ],
    [
        'scripts/webgpu/openjpeg/REVISION',
        'libraries/openjpeg/REVISION'
    ],
    [
        'scripts/webgpu/jpeg2000-capability-fixtures/srgb-960x540.jp2',
        'libraries/openjpeg/jpeg2000-960x540-qualification.bin'
    ]
]);

afterEach(async () => {
    while (temporaryDirectories.length > 0) {
        await rm(temporaryDirectories.pop(), { force: true, recursive: true });
    }
});

async function writeFixtureFile(root, path, contents) {
    const filePath = join(root, path);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, contents);
}

function hashFixtureContents(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

async function createArtifactFixture() {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'webgpu-codec-artifacts-'));
    temporaryDirectories.push(repositoryRoot);
    const distDirectory = join(repositoryRoot, 'dist');
    await writeFixtureFile(repositoryRoot, 'dist/config.json', '{}');
    for (const [ packagePath, servedPath ] of HEVC_FILES) {
        const contents = `hevc:${packagePath}`;
        await writeFixtureFile(
            repositoryRoot,
            join('node_modules/@hevcjs/core', packagePath),
            contents
        );
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    await writeFixtureFile(
        repositoryRoot,
        HEVC_QUALIFICATION_SOURCE,
        'complex HEVC qualification fixture'
    );
    await writeFixtureFile(
        repositoryRoot,
        join('dist', HEVC_QUALIFICATION_SERVED),
        'complex HEVC qualification fixture'
    );
    for (const [ sourcePath, servedPath ] of DOLBY_VISION_FILES) {
        const contents = `dovi:${sourcePath}`;
        await writeFixtureFile(repositoryRoot, sourcePath, contents);
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    for (const [ sourcePath, servedPath ] of DTS_FILES) {
        const contents = `artifact:${sourcePath}`;
        await writeFixtureFile(repositoryRoot, sourcePath, contents);
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    const dtsRevision = [
        `libdcadec commit: ${PINNED_LIBDCADEC_COMMIT}`,
        `libdcadec source SHA-256: ${PINNED_LIBDCADEC_SOURCE_SHA256}`,
        `Emscripten: ${PINNED_EMSCRIPTEN_VERSION}`,
        `Emscripten revision: ${PINNED_EMSCRIPTEN_REVISION}`,
        `Bridge SHA-256: ${PINNED_DTS_BRIDGE_SHA256}`,
        `Runtime module SHA-256: ${PINNED_DTS_RUNTIME_SHA256}`,
        'Isolated reproducible rebuild: verified'
    ].join('\n');
    await writeFixtureFile(
        repositoryRoot,
        'scripts/webgpu/dts/artifacts/REVISION',
        dtsRevision
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/libraries/libdcadec/REVISION',
        dtsRevision
    );
    for (const [ sourcePath, servedPath ] of TRUEHD_FILES) {
        const contents = `artifact:${sourcePath}`;
        await writeFixtureFile(repositoryRoot, sourcePath, contents);
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    const trueHDRevision = [
        `FFmpeg commit: ${PINNED_FFMPEG_COMMIT}`,
        `FFmpeg source SHA-256: ${PINNED_FFMPEG_SOURCE_SHA256}`,
        `Emscripten: ${PINNED_EMSCRIPTEN_VERSION}`,
        `Emscripten revision: ${PINNED_EMSCRIPTEN_REVISION}`,
        'Configured license: LGPL version 2.1 or later',
        `Bridge SHA-256: ${PINNED_TRUEHD_BRIDGE_SHA256}`,
        `Runtime module SHA-256: ${PINNED_TRUEHD_RUNTIME_SHA256}`,
        'Isolated reproducible rebuild: verified'
    ].join('\n');
    await writeFixtureFile(
        repositoryRoot,
        'scripts/webgpu/truehd/artifacts/REVISION',
        trueHDRevision
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/libraries/ffmpeg-truehd/REVISION',
        trueHDRevision
    );
    for (const [ sourcePath, servedPath ] of LEGACY_VIDEO_FILES) {
        const contents = `artifact:${sourcePath}`;
        await writeFixtureFile(repositoryRoot, sourcePath, contents);
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    const legacyRevision = [
        `FFmpeg commit: ${PINNED_FFMPEG_COMMIT}`,
        `FFmpeg source SHA-256: ${PINNED_FFMPEG_SOURCE_SHA256}`,
        `Emscripten: ${PINNED_EMSCRIPTEN_VERSION}`,
        `Emscripten revision: ${PINNED_EMSCRIPTEN_REVISION}`,
        'Configured license: LGPL version 2.1 or later',
        `Bridge SHA-256: ${PINNED_MPEG2_BRIDGE_SHA256}`,
        'Isolated reproducible rebuild: verified'
    ].join('\n');
    await writeFixtureFile(
        repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/REVISION',
        legacyRevision
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/libraries/legacy-video/REVISION',
        legacyRevision
    );
    const legacyGlueContents =
        'artifact:scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.js';
    const legacyWASMContents =
        'artifact:scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.wasm';
    const legacyBridgeContents =
        'artifact:scripts/webgpu/legacy-video-decoder/bridge.c';
    const legacyManifest = JSON.stringify({
        artifacts: {
            'legacy-video-decode.js': hashFixtureContents(legacyGlueContents),
            'legacy-video-decode.wasm': hashFixtureContents(legacyWASMContents)
        },
        bridgeSHA256: hashFixtureContents(legacyBridgeContents),
        configuredComponents: [
            '--disable-all',
            '--disable-everything',
            '--disable-gpl',
            '--disable-version3',
            '--disable-nonfree',
            '--enable-avcodec',
            '--enable-decoder=mpeg2video'
        ],
        decoders: [ 'mpeg2video' ],
        emscripten: PINNED_EMSCRIPTEN_VERSION,
        emscriptenRevision: PINNED_EMSCRIPTEN_REVISION,
        ffmpegRevision: PINNED_FFMPEG_COMMIT,
        ffmpegSourceSHA256: PINNED_FFMPEG_SOURCE_SHA256,
        license: 'LGPL version 2.1 or later',
        reproducibleBuild: true
    });
    await writeFixtureFile(
        repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        legacyManifest
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        legacyManifest
    );
    for (const [ sourcePath, servedPath ] of OPENJPEG_FILES) {
        const contents = `openjpeg:${sourcePath}`;
        await writeFixtureFile(repositoryRoot, sourcePath, contents);
        await writeFixtureFile(repositoryRoot, join('dist', servedPath), contents);
    }
    await writeFixtureFile(
        repositoryRoot,
        'node_modules/@mediabunny/ac3/LICENSE',
        'MPL license'
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/libraries/mediabunny-ac3/LICENSE.txt',
        'MPL license'
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/ac3.chunk.js',
        `throw new Error("${AC3_IMPLEMENTATION_SENTINEL}");`
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/node_modules.@mediabunny.ac3.0123456789abcdef.chunk.js',
        'Mediabunny AC-3 package implementation'
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/dts.chunk.js',
        `const decoderExport = "${DTS_IMPLEMENTATION_SENTINEL}";`
    );
    await writeFixtureFile(
        repositoryRoot,
        'dist/truehd.chunk.js',
        `const decoderExport = "${TRUEHD_IMPLEMENTATION_SENTINEL}";`
    );
    return { distDirectory, repositoryRoot };
}

test('accepts an ordinary build with Mediabunny AC-3 and its license', async () => {
    const fixture = await createArtifactFixture();

    const result = await verifyCustomCodecArtifacts(fixture);

    assert.equal(result.ac3.distribution, 'standard');
    assert.equal(result.ac3.implementationAssets.length, 1);
    assert.equal(result.ac3.licensePresent, true);
    assert.equal(result.ac3.implementationMatches.length, 1);
    assert.equal(result.dolbyVision.length, DOLBY_VISION_FILES.length);
    assert.equal(result.dts.implementationAssets.length, 1);
    assert.equal(result.dts.verifiedArtifacts.length, DTS_FILES.length);
    assert.equal(result.hevc.length, HEVC_FILES.length + 1);
    assert.equal(result.legacyVideo.length, LEGACY_VIDEO_FILES.length + 1);
    assert.equal(result.openjpeg.length, OPENJPEG_FILES.length);
    assert.equal(result.truehd.implementationAssets.length, 1);
    assert.equal(result.truehd.verifiedArtifacts.length, TRUEHD_FILES.length);
});

test('requires the stable AC-3 sentinel in executable JavaScript', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/ac3.chunk.js',
        'const source = "../node_modules/@mediabunny/ac3"; registerAc3Decoder();'
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/ac3.chunk.js.map',
        AC3_IMPLEMENTATION_SENTINEL
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /ordinary build is missing the Mediabunny AC-3 package, implementation, or license/
    );
});

test('requires the content-addressed Mediabunny AC-3 package asset', async () => {
    const fixture = await createArtifactFixture();
    await rm(
        join(
            fixture.distDirectory,
            'node_modules.@mediabunny.ac3.0123456789abcdef.chunk.js'
        ),
        { force: true }
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /ordinary build is missing the Mediabunny AC-3 package, implementation, or license/
    );
});

test('requires the copied Mediabunny AC-3 license', async () => {
    const fixture = await createArtifactFixture();
    await rm(
        join(fixture.distDirectory, 'libraries/mediabunny-ac3/LICENSE.txt'),
        { force: true }
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /ordinary build is missing the Mediabunny AC-3 package, implementation, or license/
    );
});

test('rejects a Mediabunny AC-3 license that differs from the pinned package', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/mediabunny-ac3/LICENSE.txt',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /served AC-3 license does not match the pinned package/
    );
});

test('rejects a copied HEVC artifact that differs from its pinned package', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/hevcjs/hevc-decode.wasm',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /HEVC artifact hash mismatch/
    );
});

test('rejects a copied Dolby Vision parser that differs from its source artifact', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/libdovi/dovi-rpu-parser.wasm',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Dolby Vision artifact hash mismatch/
    );
});

test('rejects a copied OpenJPEG decoder that differs from its pinned package', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/openjpeg/openjpeg-decode.wasm',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /OpenJPEG artifact hash mismatch/
    );
});

test('rejects a copied legacy video decoder that differs from its pinned artifact', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/legacy-video-decode.wasm',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video artifact hash mismatch/
    );
});

test('requires self-contained FFmpeg relink source for legacy video', async () => {
    const fixture = await createArtifactFixture();
    await rm(
        join(
            fixture.distDirectory,
            'libraries/legacy-video/ffmpeg-source.tar.gz'
        ),
        { force: true }
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Required artifact is missing/
    );
});

test('rejects a legacy video decoder that differs from its manifest', async () => {
    const fixture = await createArtifactFixture();
    const manifestPath = join(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts['legacy-video-decode.js'] = '0'.repeat(64);
    manifest.artifacts['legacy-video-decode.wasm'] = '0'.repeat(64);
    const corruptManifest = JSON.stringify(manifest);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        corruptManifest
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        corruptManifest
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video manifest hash mismatch/
    );
});

test('rejects incomplete legacy video provenance', async () => {
    const fixture = await createArtifactFixture();
    const manifestPath = join(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.reproducibleBuild = false;
    const manifestContents = JSON.stringify(manifest);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        manifestContents
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        manifestContents
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video manifest provenance is incomplete or unpinned/
    );
});

test('rejects a legacy video manifest with an extra FFmpeg component', async () => {
    const fixture = await createArtifactFixture();
    const manifestPath = join(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.configuredComponents.push('--enable-decoder=vc1');
    const manifestContents = JSON.stringify(manifest);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        manifestContents
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        manifestContents
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video manifest provenance is incomplete or unpinned/
    );
});

test('rejects matching legacy video revisions without exact release pins', async () => {
    const fixture = await createArtifactFixture();
    const incompleteRevision = 'Isolated reproducible rebuild: verified';
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/REVISION',
        incompleteRevision
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/REVISION',
        incompleteRevision
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video revision is missing pin/
    );
});

test('rejects a legacy video bridge that differs from its manifest', async () => {
    const fixture = await createArtifactFixture();
    const manifestPath = join(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bridgeSHA256 = '0'.repeat(64);
    const manifestContents = JSON.stringify(manifest);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        manifestContents
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        manifestContents
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video manifest bridge hash mismatch/
    );
});

test('rejects a legacy video manifest that advertises another decoder', async () => {
    const fixture = await createArtifactFixture();
    const manifestPath = join(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.decoders.push('another-decoder');
    const manifestContents = JSON.stringify(manifest);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json',
        manifestContents
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/legacy-video/manifest.json',
        manifestContents
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Legacy video manifest decoder list is not MPEG-2-only/
    );
});

test('rejects a copied DTS artifact that differs from its pinned source', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/libdcadec/REVISION',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /DTS artifact hash mismatch/
    );
});

test('rejects matching DTS revisions without exact release pins', async () => {
    const fixture = await createArtifactFixture();
    const incompleteRevision = 'Isolated reproducible rebuild: verified';
    await writeFixtureFile(
        fixture.repositoryRoot,
        'scripts/webgpu/dts/artifacts/REVISION',
        incompleteRevision
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/libdcadec/REVISION',
        incompleteRevision
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /DTS revision is missing pin/
    );
});

test('requires the DTS decoder in executable JavaScript', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/dts.chunk.js',
        'const decoderExport = "missing";'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /ordinary build is missing the bundled DTS decoder/
    );
});

test('rejects a copied TrueHD artifact that differs from its pinned source', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/ffmpeg-truehd/REVISION',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /TrueHD artifact hash mismatch/
    );
});

test('rejects matching TrueHD revisions without the exact toolchain revision', async () => {
    const fixture = await createArtifactFixture();
    const revisionPath = 'scripts/webgpu/truehd/artifacts/REVISION';
    const revision = await readFile(
        join(fixture.repositoryRoot, revisionPath),
        'utf8'
    );
    const alteredRevision = revision.replace(
        PINNED_EMSCRIPTEN_REVISION,
        '0'.repeat(PINNED_EMSCRIPTEN_REVISION.length)
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        revisionPath,
        alteredRevision
    );
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/ffmpeg-truehd/REVISION',
        alteredRevision
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /TrueHD revision is missing pin/
    );
});

test('requires the TrueHD decoder in executable JavaScript', async () => {
    const fixture = await createArtifactFixture();
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/truehd.chunk.js',
        'const decoderExport = "missing";'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /ordinary build is missing the bundled TrueHD decoder/
    );
});

test('requires the separate upstream OpenJPEG license', async () => {
    const fixture = await createArtifactFixture();
    await rm(
        join(fixture.distDirectory, 'libraries/openjpeg/LICENSE.openjpeg.txt'),
        { force: true }
    );

    await assert.rejects(
        verifyCustomCodecArtifacts(fixture),
        /Required artifact is missing/
    );
});
