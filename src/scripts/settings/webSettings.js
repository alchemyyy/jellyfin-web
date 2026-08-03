import DefaultConfig from '../../config.json';
import fetchLocal from '../../utils/fetchLocal.ts';

const HTML_VIDEO_PLAYER_PLUGIN = 'htmlVideoPlayer/plugin';
const WEBGPU_VIDEO_PLAYER_PLUGIN = 'webGPUVideoPlayer/plugin';

let data;

function ensureVideoPlayerPlugins(configuredPlugins) {
    const plugins = configuredPlugins.filter(plugin => plugin !== WEBGPU_VIDEO_PLAYER_PLUGIN);
    const htmlPlayerIndex = plugins.indexOf(HTML_VIDEO_PLAYER_PLUGIN);
    const insertionIndex = htmlPlayerIndex < 0 ? plugins.length : htmlPlayerIndex;
    plugins.splice(insertionIndex, 0, WEBGPU_VIDEO_PLAYER_PLUGIN);
    return plugins;
}

async function getConfig() {
    if (data) return Promise.resolve(data);
    try {
        const response = await fetchLocal('config.json', {
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error('network response was not ok');
        }

        data = await response.json();

        return data;
    } catch (error) {
        console.warn('failed to fetch the web config file:', error);
        data = DefaultConfig;
        return data;
    }
}

export function getIncludeCorsCredentials() {
    return getConfig()
        .then(config => !!config.includeCorsCredentials)
        .catch(error => {
            console.log('cannot get web config:', error);
            return false;
        });
}

export function getMultiServer() {
    // Enable multi-server support when served by webpack
    if (__WEBPACK_SERVE__) {
        return Promise.resolve(true);
    }

    return getConfig().then(config => {
        return !!config.multiserver;
    }).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}

export function getServers() {
    return getConfig().then(config => {
        return config.servers || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

const baseDefaultTheme = {
    'name': 'Dark',
    'id': 'dark',
    'default': true
};

let internalDefaultTheme = baseDefaultTheme;

const checkDefaultTheme = (themes) => {
    if (themes) {
        const defaultTheme = themes.find((theme) => theme.default);

        if (defaultTheme) {
            internalDefaultTheme = defaultTheme;
            return;
        }
    }

    internalDefaultTheme = baseDefaultTheme;
};

export function getThemes() {
    return getConfig().then(config => {
        if (!Array.isArray(config.themes)) {
            console.error('web config is invalid, missing themes:', config);
        }
        const themes = Array.isArray(config.themes) ? config.themes : DefaultConfig.themes;
        checkDefaultTheme(themes);
        return themes;
    }).catch(error => {
        console.log('cannot get web config:', error);
        checkDefaultTheme();
        return DefaultConfig.themes;
    });
}

export const getDefaultTheme = () => internalDefaultTheme;

export function getMenuLinks() {
    return getConfig().then(config => {
        if (!config.menuLinks) {
            console.error('web config is invalid, missing menuLinks:', config);
        }
        return config.menuLinks || [];
    }).catch(error => {
        console.log('cannot get web config:', error);
        return [];
    });
}

export function getPlugins() {
    return getConfig().then(config => {
        if (!config.plugins) {
            console.error('web config is invalid, missing plugins:', config);
        }
        return ensureVideoPlayerPlugins(config.plugins || DefaultConfig.plugins);
    }).catch(error => {
        console.log('cannot get web config:', error);
        return ensureVideoPlayerPlugins(DefaultConfig.plugins);
    });
}

export function getWebGPUCustomDecodeEnabled() {
    return getConfig().then(config => !!config.enableWebGPUCustomDecode).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}

/** Returns the already-loaded custom decode flag without delaying playback. */
export function isWebGPUCustomDecodeEnabled() {
    return !!(data || DefaultConfig).enableWebGPUCustomDecode;
}

export function getWebGPUHDRToneMappingEnabled() {
    return getConfig().then(config => !!config.enableWebGPUHDRToneMapping).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}

export function getWebGPUValidationHarnessEnabled() {
    return getConfig().then(config => !!config.enableWebGPUValidationHarness).catch(error => {
        console.log('cannot get web config:', error);
        return false;
    });
}
