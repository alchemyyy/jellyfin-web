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
        include: [ 'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}' ],
        restoreMocks: true
    }
});
