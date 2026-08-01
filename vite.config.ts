/// <reference types="vitest" />
/// <reference types="vite/client" />
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const ENABLE_BUNDLED_AC3_SOFTWARE_DECODER: boolean = [ '1', 'true' ].includes(
    process.env.ENABLE_BUNDLED_AC3_SOFTWARE_DECODER || ''
);
// eslint-disable-next-line compat/compat -- Vite configuration runs on Node 24
const BUNDLED_AC3_SOFTWARE_DECODER_BUILD_PATH: string = fileURLToPath(new URL(
    ENABLE_BUNDLED_AC3_SOFTWARE_DECODER ?
        './src/plugins/webGPUVideoPlayer/custom/BundledAC3SoftwareDecoderBuildEnabled.ts' :
        './src/plugins/webGPUVideoPlayer/custom/BundledAC3SoftwareDecoderBuild.ts',
    import.meta.url
));

export default defineConfig({
    define: {
        __ENABLE_BUNDLED_AC3_SOFTWARE_DECODER__: JSON.stringify(
            ENABLE_BUNDLED_AC3_SOFTWARE_DECODER
        )
    },
    plugins: [ tsconfigPaths() ],
    resolve: {
        alias: [ {
            find: /^plugins\/webGPUVideoPlayer\/custom\/BundledAC3SoftwareDecoderBuild$/,
            replacement: BUNDLED_AC3_SOFTWARE_DECODER_BUILD_PATH
        } ]
    },
    test: {
        coverage: {
            include: [ 'src' ]
        },
        environment: 'jsdom',
        restoreMocks: true
    }
});
