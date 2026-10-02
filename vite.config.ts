/// <reference types="vitest" />
/// <reference types="vite/client" />
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [ tsconfigPaths() ],
    test: {
        coverage: {
            include: [ 'src' ]
        },
        environment: 'jsdom',
        // The vendored engine and hls.js run their own suites with their own configuration
        exclude: [ '**/node_modules/**', '**/dist/**', 'vendor/webgpu-player/**', 'vendor/webgpu-player-hls/**' ],
        restoreMocks: true
    }
});
