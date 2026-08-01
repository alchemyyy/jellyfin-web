/* eslint-disable compat/compat -- This release check targets Node 24 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC3_DISABLED = 'disabled';
const AC3_ENABLED = 'enabled';
const AC3_IMPLEMENTATION_SENTINEL = 'jellyfin-webgpu-bundled-ac3-v1';
const AC3_LICENSE_PATH = 'libraries/mediabunny-ac3/LICENSE.txt';
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
    }
]);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..');

function requireAC3Mode(argumentsList) {
    const modeIndex = argumentsList.indexOf('--ac3');
    const mode = modeIndex >= 0 ? argumentsList[modeIndex + 1] : AC3_DISABLED;
    if (mode !== AC3_DISABLED && mode !== AC3_ENABLED) {
        throw new TypeError('Use --ac3 disabled or --ac3 enabled');
    }
    return mode;
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
        const packageArtifact = join(
            repositoryRoot,
            'node_modules',
            '@hevcjs',
            'core',
            artifact.packagePath
        );
        const servedArtifact = join(distDirectory, artifact.servedPath);
        await requireFile(packageArtifact);
        await requireFile(servedArtifact);
        const [ packageSHA256, servedSHA256 ] = await Promise.all([
            hashFile(packageArtifact),
            hashFile(servedArtifact)
        ]);
        if (packageSHA256 !== servedSHA256) {
            throw new Error(`HEVC artifact hash mismatch: ${artifact.servedPath}`);
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

async function verifyAC3Artifacts(repositoryRoot, distDirectory, mode) {
    const licensePath = join(distDirectory, AC3_LICENSE_PATH);
    const licensePresent = (await stat(licensePath).catch(() => null))?.isFile() === true;
    const implementationMatches = await findAC3ImplementationMarkers(distDirectory);
    if (mode === AC3_DISABLED) {
        if (licensePresent || implementationMatches.length > 0) {
            throw new Error('The ordinary build contains opt-in AC-3 implementation artifacts');
        }
        return { implementationMatches: [], licensePresent: false, mode };
    }

    if (!licensePresent || implementationMatches.length === 0) {
        throw new Error('The enabled build is missing the AC-3 implementation or license');
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
        implementationMatches,
        licensePresent: true,
        licenseSHA256: servedLicenseSHA256,
        mode
    };
}

/** Verifies copied HEVC files and the selected AC-3 build boundary. */
export async function verifyCustomCodecArtifacts(options = {}) {
    const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
    const distDirectory = resolve(options.distDirectory ?? join(repositoryRoot, 'dist'));
    const mode = options.ac3Mode ?? AC3_DISABLED;
    if (mode !== AC3_DISABLED && mode !== AC3_ENABLED) {
        throw new TypeError('The AC-3 artifact mode is invalid');
    }
    await requireFile(join(distDirectory, 'config.json'));
    const [ hevc, ac3 ] = await Promise.all([
        verifyHEVCArtifacts(repositoryRoot, distDirectory),
        verifyAC3Artifacts(repositoryRoot, distDirectory, mode)
    ]);
    return { ac3, hevc };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    const result = await verifyCustomCodecArtifacts({
        ac3Mode: requireAC3Mode(process.argv.slice(2))
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/* eslint-enable compat/compat */
