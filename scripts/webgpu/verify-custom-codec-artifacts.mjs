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
    const [ hevc, ac3, dolbyVision ] = await Promise.all([
        verifyHEVCArtifacts(repositoryRoot, distDirectory),
        verifyAC3Artifacts(repositoryRoot, distDirectory),
        verifyDolbyVisionArtifacts(repositoryRoot, distDirectory)
    ]);
    return { ac3, dolbyVision, hevc };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    requireNoArguments(process.argv.slice(2));
    const result = await verifyCustomCodecArtifacts();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/* eslint-enable compat/compat */
