import { getWebGPUHDRToneMappingEnabled } from 'scripts/settings/webSettings';
import { configureEngineAssets } from 'webgpu-player/EngineAssets';
import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';

import WebGPUPlayer from './WebGPUPlayer';
import 'webgpu-player/style.scss';

// Webpack serves the engine assets at libraries/ beside the page, under stable URLs keyed per build
configureEngineAssets({ cacheKey: __WEBGPU_PLAYER_ASSET_KEY__ });
configureEngineFeatureFlags({
    isHDRToneMappingEnabled: getWebGPUHDRToneMappingEnabled
});

export default WebGPUPlayer;
