import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(result.hevc.length, HEVC_FILES.length + 1);
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
