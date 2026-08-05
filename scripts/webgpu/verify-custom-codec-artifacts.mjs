/* eslint-disable compat/compat -- This release check targets Node 24 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC3_IMPLEMENTATION_SENTINEL = 'jellyfin-webgpu-mediabunny-ac3-v2';
const AC3_LICENSE_PATH = 'libraries/mediabunny-ac3/LICENSE.txt';
const AC3_PACKAGE_ASSET_PATTERN =
    /(?:^|\/)node_modules\.@mediabunny\.ac3\.[a-f0-9]{8,}\.chunk\.js$/iu;
const DOLBY_VISION_ARTIFACTS = Object.freeze([
    {
        servedPath: 'libraries/libdovi/dovi-rpu-parser.wasm',
        sourcePath: 'scripts/webgpu/dolby-vision-parser/artifacts/dovi-rpu-parser.wasm'
    },
    {
        servedPath: 'libraries/libdovi/LICENSE.txt',
        sourcePath: 'scripts/webgpu/dolby-vision-parser/LICENSE.libdovi.txt'
    },
    {
        servedPath: 'libraries/libdovi/REVISION',
        sourcePath: 'scripts/webgpu/dolby-vision-parser/REVISION'
    }
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
const PINNED_LEGACY_VIDEO_BRIDGE_SHA256 =
    '832b62326346f5049f89a2d6a8f97f73df8b5b26c5a1d9114573fa1015be2ee8';
const PINNED_LEGACY_VIDEO_COMPONENTS = Object.freeze([
    '--disable-all',
    '--disable-everything',
    '--disable-gpl',
    '--disable-version3',
    '--disable-nonfree',
    '--enable-avcodec',
    '--enable-decoder=mpeg2video',
    '--enable-decoder=vc1'
]);
const DTS_ARTIFACTS = Object.freeze([
    {
        servedPath: 'libraries/libdcadec/COPYING.LGPLv2.1',
        sourcePath: 'scripts/webgpu/dts/artifacts/COPYING.LGPLv2.1'
    },
    {
        servedPath: 'libraries/libdcadec/REVISION',
        sourcePath: 'scripts/webgpu/dts/artifacts/REVISION'
    },
    {
        servedPath: 'libraries/libdcadec/libdcadec-source.tar.gz',
        sourcePath: 'scripts/webgpu/dts/artifacts/libdcadec-source.tar.gz'
    },
    {
        servedPath: 'libraries/libdcadec/LICENSE.bridge.GPL-2.0.txt',
        sourcePath: 'LICENSE'
    },
    {
        servedPath: 'libraries/libdcadec/libdcadec_bridge.c',
        sourcePath: 'scripts/webgpu/dts/libdcadec_bridge.c'
    },
    {
        servedPath: 'libraries/libdcadec/build_dts_decoder.py',
        sourcePath: 'scripts/webgpu/build_dts_decoder.py'
    }
]);
const TRUEHD_IMPLEMENTATION_SENTINEL = 'jellyfin_truehd_send_packet';
const TRUEHD_ARTIFACTS = Object.freeze([
    {
        servedPath: 'libraries/ffmpeg-truehd/COPYING.LGPLv2.1',
        sourcePath: 'scripts/webgpu/truehd/artifacts/COPYING.LGPLv2.1'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/REVISION',
        sourcePath: 'scripts/webgpu/truehd/artifacts/REVISION'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/ffmpeg-source.tar.gz',
        sourcePath: 'scripts/webgpu/truehd/artifacts/ffmpeg-source.tar.gz'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/LICENSE.bridge.GPL-2.0.txt',
        sourcePath: 'LICENSE'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/ffmpeg_truehd_bridge.c',
        sourcePath: 'scripts/webgpu/truehd/ffmpeg_truehd_bridge.c'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/build_truehd_decoder.py',
        sourcePath: 'scripts/webgpu/build_truehd_decoder.py'
    },
    {
        servedPath: 'libraries/ffmpeg-truehd/pinned_ffmpeg_build.py',
        sourcePath: 'scripts/webgpu/pinned_ffmpeg_build.py'
    }
]);
const HEVC_ARTIFACTS = Object.freeze([
    {
        packagePath: 'dist/wasm/hevc-decode.js',
        servedPath: 'libraries/hevcjs/hevc-decode.js'
    },
    {
        packagePath: 'dist/wasm/hevc-decode.wasm',
        servedPath: 'libraries/hevcjs/hevc-decode.wasm'
    },
    {
        packagePath: 'LICENSE',
        servedPath: 'libraries/hevcjs/LICENSE.txt'
    },
    {
        servedPath: 'libraries/hevcjs/main10-4k-qualification.bin',
        sourcePath: 'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc'
    }
]);
const PGS_WORKER_ARTIFACT = Object.freeze({
    packagePath: 'dist/libpgs.worker.js',
    servedPath: 'libraries/libpgs.worker.js'
});
const LEGACY_VIDEO_ARTIFACTS = Object.freeze([
    {
        servedPath: 'libraries/legacy-video/legacy-video-decode.js',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.js'
    },
    {
        servedPath: 'libraries/legacy-video/legacy-video-decode.wasm',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.wasm'
    },
    {
        servedPath: 'libraries/legacy-video/manifest.json',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    },
    {
        servedPath: 'libraries/legacy-video/LICENSE.ffmpeg.txt',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/LICENSE.ffmpeg.txt'
    },
    {
        servedPath: 'libraries/legacy-video/REVISION',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/REVISION'
    },
    {
        servedPath: 'libraries/legacy-video/ffmpeg-source.tar.gz',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/artifacts/ffmpeg-source.tar.gz'
    },
    {
        servedPath: 'libraries/legacy-video/LICENSE.bridge.GPL-2.0.txt',
        sourcePath: 'LICENSE'
    },
    {
        servedPath: 'libraries/legacy-video/bridge.c',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/bridge.c'
    },
    {
        servedPath: 'libraries/legacy-video/build_legacy_video_decoder.py',
        sourcePath: 'scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py'
    },
    {
        servedPath: 'libraries/legacy-video/pinned_ffmpeg_build.py',
        sourcePath: 'scripts/webgpu/pinned_ffmpeg_build.py'
    },
    {
        servedPath: 'libraries/legacy-video/mpeg2-progressive-1920x1080-qualification.bin',
        sourcePath: 'scripts/webgpu/legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv'
    },
    {
        servedPath: 'libraries/legacy-video/vc1-advanced-progressive-1920x1080-qualification.bin',
        sourcePath: 'scripts/webgpu/legacy-video-capability-fixtures/vc1-advanced-progressive-1920x1080.mkv'
    }
]);
const OPENJPEG_ARTIFACTS = Object.freeze([
    {
        packagePath: 'dist/openjpegwasm_decode.js',
        servedPath: 'libraries/openjpeg/openjpeg-decode.js'
    },
    {
        packagePath: 'dist/openjpegwasm_decode.wasm',
        servedPath: 'libraries/openjpeg/openjpeg-decode.wasm'
    },
    {
        packagePath: 'LICENSE',
        servedPath: 'libraries/openjpeg/LICENSE.wrapper.txt'
    },
    {
        servedPath: 'libraries/openjpeg/LICENSE.openjpeg.txt',
        sourcePath: 'scripts/webgpu/openjpeg/LICENSE.openjpeg.txt'
    },
    {
        servedPath: 'libraries/openjpeg/REVISION',
        sourcePath: 'scripts/webgpu/openjpeg/REVISION'
    },
    {
        servedPath: 'libraries/openjpeg/jpeg2000-960x540-qualification.bin',
        sourcePath: 'scripts/webgpu/jpeg2000-capability-fixtures/srgb-960x540.jp2'
    }
]);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..');

function requireNoArguments(argumentsList) {
    if (argumentsList.length > 0) {
        throw new TypeError('The codec artifact verifier no longer accepts build modes');
    }
}

async function requireFile(path) {
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat?.isFile()) {
        throw new Error(`Required artifact is missing: ${path}`);
    }
}

async function hashFile(path) {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
}

function requireRevisionMarkers(revision, requiredMarkers, label) {
    for (const requiredMarker of requiredMarkers) {
        if (!revision.includes(requiredMarker)) {
            throw new Error(`${label} revision is missing pin ${requiredMarker}`);
        }
    }
}

async function listFiles(directory) {
    const files = [];
    const pendingDirectories = [ directory ];
    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop();
        const entries = await readdir(currentDirectory, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
            } else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }
    return files;
}

async function verifyHEVCArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of HEVC_ARTIFACTS) {
        const sourceArtifact = artifact.packagePath ?
            join(
                repositoryRoot,
                'node_modules',
                '@hevcjs',
                'core',
                artifact.packagePath
            ) :
            join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`HEVC artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }
    return verifiedArtifacts;
}

async function verifyPGSWorkerArtifact(repositoryRoot, distDirectory) {
    const sourceArtifact = join(
        repositoryRoot,
        'node_modules',
        'libpgs',
        PGS_WORKER_ARTIFACT.packagePath
    );
    const servedArtifact = join(distDirectory, PGS_WORKER_ARTIFACT.servedPath);
    await requireFile(sourceArtifact);
    await requireFile(servedArtifact);
    const [ sourceSHA256, servedSHA256 ] = await Promise.all([
        hashFile(sourceArtifact),
        hashFile(servedArtifact)
    ]);
    if (sourceSHA256 !== servedSHA256) {
        throw new Error('libpgs worker artifact hash mismatch');
    }
    return {
        path: PGS_WORKER_ARTIFACT.servedPath,
        sha256: servedSHA256
    };
}

async function verifyDolbyVisionArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of DOLBY_VISION_ARTIFACTS) {
        const sourceArtifact = join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`Dolby Vision artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }
    return verifiedArtifacts;
}

async function verifyLegacyVideoArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of LEGACY_VIDEO_ARTIFACTS) {
        const sourceArtifact = join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`Legacy video artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }

    const manifestPath = join(
        repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
        !Array.isArray(manifest?.decoders)
        || JSON.stringify(manifest.decoders) !== JSON.stringify([ 'mpeg2video', 'vc1' ])
    ) {
        throw new Error('Legacy video manifest decoder list is invalid');
    }
    if (
        manifest.ffmpegRevision !== PINNED_FFMPEG_COMMIT
        || manifest.ffmpegSourceSHA256 !== PINNED_FFMPEG_SOURCE_SHA256
        || manifest.emscripten !== PINNED_EMSCRIPTEN_VERSION
        || manifest.emscriptenRevision !== PINNED_EMSCRIPTEN_REVISION
        || manifest.license !== 'LGPL version 2.1 or later'
        || manifest.reproducibleBuild !== true
        || JSON.stringify(manifest.configuredComponents)
            !== JSON.stringify(PINNED_LEGACY_VIDEO_COMPONENTS)
    ) {
        throw new Error('Legacy video manifest provenance is incomplete or unpinned');
    }
    const legacyBridgeSHA256 = await hashFile(join(
        repositoryRoot,
        'scripts/webgpu/legacy-video-decoder/bridge.c'
    ));
    if (manifest.bridgeSHA256 !== legacyBridgeSHA256) {
        throw new Error('Legacy video manifest bridge hash mismatch');
    }
    const expectedArtifactNames = [
        'legacy-video-decode.js',
        'legacy-video-decode.wasm'
    ];
    if (JSON.stringify(Object.keys(manifest.artifacts ?? {}).sort())
        !== JSON.stringify(expectedArtifactNames)) {
        throw new Error('Legacy video manifest artifact list is invalid');
    }
    for (const fileName of expectedArtifactNames) {
        const expectedSHA256 = manifest?.artifacts?.[fileName];
        const actualSHA256 = await hashFile(join(
            repositoryRoot,
            'scripts/webgpu/legacy-video-decoder/artifacts',
            fileName
        ));
        if (expectedSHA256 !== actualSHA256) {
            throw new Error(`Legacy video manifest hash mismatch: ${fileName}`);
        }
    }
    const revision = await readFile(
        join(repositoryRoot, 'scripts/webgpu/legacy-video-decoder/REVISION'),
        'utf8'
    );
    requireRevisionMarkers(revision, [
        PINNED_FFMPEG_COMMIT,
        PINNED_FFMPEG_SOURCE_SHA256,
        PINNED_EMSCRIPTEN_VERSION,
        PINNED_EMSCRIPTEN_REVISION,
        PINNED_LEGACY_VIDEO_BRIDGE_SHA256,
        'LGPL version 2.1 or later',
        'Isolated reproducible rebuild: verified'
    ], 'Legacy video');
    return verifiedArtifacts;
}

async function verifyOpenJPEGArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of OPENJPEG_ARTIFACTS) {
        const sourceArtifact = artifact.packagePath ?
            join(
                repositoryRoot,
                'node_modules',
                '@cornerstonejs',
                'codec-openjpeg',
                artifact.packagePath
            ) :
            join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`OpenJPEG artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }
    return verifiedArtifacts;
}

async function verifyDTSArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of DTS_ARTIFACTS) {
        const sourceArtifact = join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`DTS artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }

    const revision = await readFile(
        join(repositoryRoot, 'scripts/webgpu/dts/artifacts/REVISION'),
        'utf8'
    );
    requireRevisionMarkers(revision, [
        PINNED_LIBDCADEC_COMMIT,
        PINNED_LIBDCADEC_SOURCE_SHA256,
        PINNED_EMSCRIPTEN_VERSION,
        PINNED_EMSCRIPTEN_REVISION,
        PINNED_DTS_BRIDGE_SHA256,
        PINNED_DTS_RUNTIME_SHA256,
        'Isolated reproducible rebuild: verified'
    ], 'DTS');

    const implementationAssets = [];
    const files = await listFiles(distDirectory);
    for (const filePath of files) {
        if (!/\.js$/i.test(filePath)) {
            continue;
        }
        const contents = await readFile(filePath, 'utf8');
        if (contents.includes(DTS_IMPLEMENTATION_SENTINEL)) {
            implementationAssets.push(
                relative(distDirectory, filePath).replaceAll('\\', '/')
            );
        }
    }
    if (implementationAssets.length === 0) {
        throw new Error('The ordinary build is missing the bundled DTS decoder');
    }
    return { implementationAssets, verifiedArtifacts };
}

async function verifyTrueHDArtifacts(repositoryRoot, distDirectory) {
    const verifiedArtifacts = [];
    for (const artifact of TRUEHD_ARTIFACTS) {
        const sourceArtifact = join(repositoryRoot, artifact.sourcePath);
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(sourceArtifact);
        await requireFile(servedArtifact);
        const [ sourceSHA256, servedSHA256 ] = await Promise.all([
            hashFile(sourceArtifact),
            hashFile(servedArtifact)
        ]);
        if (sourceSHA256 !== servedSHA256) {
            throw new Error(`TrueHD artifact hash mismatch: ${artifact.servedPath}`);
        }
        verifiedArtifacts.push({
            path: artifact.servedPath.replaceAll('\\', '/'),
            sha256: servedSHA256
        });
    }

    const revision = await readFile(
        join(repositoryRoot, 'scripts/webgpu/truehd/artifacts/REVISION'),
        'utf8'
    );
    requireRevisionMarkers(revision, [
        PINNED_FFMPEG_COMMIT,
        PINNED_FFMPEG_SOURCE_SHA256,
        PINNED_EMSCRIPTEN_VERSION,
        PINNED_EMSCRIPTEN_REVISION,
        PINNED_TRUEHD_BRIDGE_SHA256,
        PINNED_TRUEHD_RUNTIME_SHA256,
        'LGPL version 2.1 or later',
        'Isolated reproducible rebuild: verified'
    ], 'TrueHD');

    const implementationAssets = [];
    const files = await listFiles(distDirectory);
    for (const filePath of files) {
        if (!/\.js$/i.test(filePath)) {
            continue;
        }
        const contents = await readFile(filePath, 'utf8');
        if (contents.includes(TRUEHD_IMPLEMENTATION_SENTINEL)) {
            implementationAssets.push(
                relative(distDirectory, filePath).replaceAll('\\', '/')
            );
        }
    }
    if (implementationAssets.length === 0) {
        throw new Error('The ordinary build is missing the bundled TrueHD decoder');
    }
    return { implementationAssets, verifiedArtifacts };
}

async function findAC3ImplementationMarkers(distDirectory) {
    const files = await listFiles(distDirectory);
    const matches = [];
    for (const filePath of files) {
        if (!/\.js$/i.test(filePath)) {
            continue;
        }
        const contents = await readFile(filePath, 'utf8');
        if (contents.includes(AC3_IMPLEMENTATION_SENTINEL)) {
            matches.push({
                markers: [ AC3_IMPLEMENTATION_SENTINEL ],
                path: relative(distDirectory, filePath).replaceAll('\\', '/')
            });
        }
    }
    return matches;
}

async function findAC3PackageAssets(distDirectory) {
    const files = await listFiles(distDirectory);
    const assets = [];
    for (const filePath of files) {
        const servedPath = relative(distDirectory, filePath).replaceAll('\\', '/');
        if (!AC3_PACKAGE_ASSET_PATTERN.test(servedPath)) {
            continue;
        }
        assets.push({
            path: servedPath,
            sha256: await hashFile(filePath)
        });
    }
    return assets;
}

async function verifyAC3Artifacts(repositoryRoot, distDirectory) {
    const licensePath = join(distDirectory, AC3_LICENSE_PATH);
    const licensePresent = (await stat(licensePath).catch(() => null))?.isFile() === true;
    const [ implementationAssets, implementationMatches ] = await Promise.all([
        findAC3PackageAssets(distDirectory),
        findAC3ImplementationMarkers(distDirectory)
    ]);
    if (
        !licensePresent
        || implementationAssets.length === 0
        || implementationMatches.length === 0
    ) {
        throw new Error(
            'The ordinary build is missing the Mediabunny AC-3 package, implementation, or license'
        );
    }
    const packageLicense = join(
        repositoryRoot,
        'node_modules',
        '@mediabunny',
        'ac3',
        'LICENSE'
    );
    await requireFile(packageLicense);
    const [ packageLicenseSHA256, servedLicenseSHA256 ] = await Promise.all([
        hashFile(packageLicense),
        hashFile(licensePath)
    ]);
    if (packageLicenseSHA256 !== servedLicenseSHA256) {
        throw new Error('The served AC-3 license does not match the pinned package');
    }
    return {
        distribution: 'standard',
        implementationAssets,
        implementationMatches,
        licensePresent: true,
        licenseSHA256: servedLicenseSHA256
    };
}

/** Verifies copied codec files and every decoder required by an ordinary build. */
export async function verifyCustomCodecArtifacts(options = {}) {
    const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
    const distDirectory = resolve(options.distDirectory ?? join(repositoryRoot, 'dist'));
    await requireFile(join(distDirectory, 'config.json'));
    const [
        hevc,
        ac3,
        dolbyVision,
        dts,
        legacyVideo,
        pgsWorker,
        openjpeg,
        truehd
    ] = await Promise.all([
        verifyHEVCArtifacts(repositoryRoot, distDirectory),
        verifyAC3Artifacts(repositoryRoot, distDirectory),
        verifyDolbyVisionArtifacts(repositoryRoot, distDirectory),
        verifyDTSArtifacts(repositoryRoot, distDirectory),
        verifyLegacyVideoArtifacts(repositoryRoot, distDirectory),
        verifyPGSWorkerArtifact(repositoryRoot, distDirectory),
        verifyOpenJPEGArtifacts(repositoryRoot, distDirectory),
        verifyTrueHDArtifacts(repositoryRoot, distDirectory)
    ]);
    return {
        ac3,
        dolbyVision,
        dts,
        hevc,
        legacyVideo,
        openjpeg,
        pgsWorker,
        truehd
    };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    requireNoArguments(process.argv.slice(2));
    const result = await verifyCustomCodecArtifacts();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/* eslint-enable compat/compat */
