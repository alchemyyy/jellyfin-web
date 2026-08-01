export const RENDER_SETTINGS_VERSION = 1;

export type RenderMode = 'identity-sdr';

export type RenderSettings = {
    mode: RenderMode
    version: typeof RENDER_SETTINGS_VERSION
};

/** Returns independent settings for a new presentation session. */
export function createDefaultRenderSettings(): RenderSettings {
    return {
        mode: 'identity-sdr',
        version: RENDER_SETTINGS_VERSION
    };
}
