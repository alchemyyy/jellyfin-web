import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { verifyCustomCodecArtifacts } from './verify-custom-codec-artifacts.mjs';

const temporaryDirectories = [];
const AC3_IMPLEMENTATION_SENTINEL = 'jellyfin-webgpu-bundled-ac3-v1';
const HEVC_FILES = Object.freeze([
    [ 'dist/wasm/hevc-decode.js', 'libraries/hevcjs/hevc-decode.js' ],
    [ 'dist/wasm/hevc-decode.wasm', 'libraries/hevcjs/hevc-decode.wasm' ],
    [ 'LICENSE', 'libraries/hevcjs/LICENSE.txt' ]
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

async function createArtifactFixture(ac3Enabled) {
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
    if (ac3Enabled) {
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
    }
    return { distDirectory, repositoryRoot };
}

test('accepts an ordinary build without opt-in AC-3 artifacts', async () => {
    const fixture = await createArtifactFixture(false);

    const result = await verifyCustomCodecArtifacts({
        ac3Mode: 'disabled',
        ...fixture
    });

    assert.equal(result.ac3.licensePresent, false);
    assert.equal(result.hevc.length, HEVC_FILES.length);
});

test('accepts an enabled build with implementation markers and matching licenses', async () => {
    const fixture = await createArtifactFixture(true);

    const result = await verifyCustomCodecArtifacts({
        ac3Mode: 'enabled',
        ...fixture
    });

    assert.equal(result.ac3.licensePresent, true);
    assert.equal(result.ac3.implementationMatches.length, 1);
});

test('rejects AC-3 implementation leakage from an ordinary build', async () => {
    const fixture = await createArtifactFixture(true);

    await assert.rejects(
        verifyCustomCodecArtifacts({ ac3Mode: 'disabled', ...fixture }),
        /ordinary build contains opt-in AC-3/
    );
});

test('requires the stable AC-3 sentinel in executable JavaScript', async () => {
    const fixture = await createArtifactFixture(true);
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
        verifyCustomCodecArtifacts({ ac3Mode: 'enabled', ...fixture }),
        /enabled build is missing the AC-3 implementation/
    );
});

test('rejects a copied HEVC artifact that differs from its pinned package', async () => {
    const fixture = await createArtifactFixture(false);
    await writeFixtureFile(
        fixture.repositoryRoot,
        'dist/libraries/hevcjs/hevc-decode.wasm',
        'corrupt'
    );

    await assert.rejects(
        verifyCustomCodecArtifacts({ ac3Mode: 'disabled', ...fixture }),
        /HEVC artifact hash mismatch/
    );
});
