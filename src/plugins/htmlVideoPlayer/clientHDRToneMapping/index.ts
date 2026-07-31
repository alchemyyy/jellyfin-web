import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';
import type { HlsConfig } from 'hls.js';

import {
    CLIENT_HDR_TONE_MAPPING_PRESETS,
    createAGTMPayload,
    type ClientHDRToneMappingPreset
} from './agtm';
import { isClientHDRToneMappingMediaSource } from './compatibility';
import {
    createClientHDRToneMappingFragmentLoader,
    type HlsConstructorWithDefaultConfig
} from './hlsFragmentLoader';

const DEFAULT_CLIENT_HDR_TONE_MAPPING_PRESET: ClientHDRToneMappingPreset = 'bt2390';

/**
 * Resolves browser-local setting data to a supported preset.
 */
export function resolveClientHDRToneMappingPreset(
    preset: unknown
): ClientHDRToneMappingPreset {
    return typeof preset === 'string'
        && CLIENT_HDR_TONE_MAPPING_PRESETS.some(candidate => candidate === preset) ?
        preset as ClientHDRToneMappingPreset :
        DEFAULT_CLIENT_HDR_TONE_MAPPING_PRESET;
}

/**
 * Creates the hls.js overrides needed for client-side HDR tone mapping.
 * Returns an empty object when playback does not pass every feature gate.
 */
export function createClientHDRToneMappingHlsConfig(
    hlsConstructor: HlsConstructorWithDefaultConfig,
    mediaSource: MediaSourceInfo | null | undefined,
    enabled: boolean,
    preset: unknown,
    bt2390Parameters?: unknown
): Partial<HlsConfig> {
    if (!enabled || !isClientHDRToneMappingMediaSource(mediaSource)) {
        return {};
    }

    const resolvedPreset = resolveClientHDRToneMappingPreset(preset);
    const agtmPayload = createAGTMPayload(
        resolvedPreset,
        bt2390Parameters
    );

    return {
        fLoader: createClientHDRToneMappingFragmentLoader(
            hlsConstructor,
            agtmPayload
        ),
        progressive: false
    };
}

export {
    hasClientHDRToneMappingVideoStream,
    isClientHDRToneMappingMediaSource,
    isClientHDRToneMappingRuntimeSupported,
    isClientHDRToneMappingVideoRangeType
} from './compatibility';
export type {
    ClientHDRToneMappingRuntimeCapabilities
} from './compatibility';
export {
    isClientHDRToneMappingRuntimeAvailable
} from './runtime';
export {
    configureClientHDRToneMappingPlaybackOptions
} from './playbackOptions';
export {
    calculateClientHDRToneMappingSaturation
} from './postProcessing';

export {
    CLIENT_HDR_TONE_MAPPING_PRESETS,
    DEFAULT_BT2390_TONE_MAPPING_PARAMETERS
} from './agtm';
export type {
    BT2390ToneMappingParameters,
    ClientHDRToneMappingPreset
} from './agtm';
