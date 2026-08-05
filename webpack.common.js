const fg = require('fast-glob');
const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { DefinePlugin, IgnorePlugin } = require('webpack');
const packageJson = require('./package.json');
const webGPUHLSPackageJson = require(path.resolve(
    __dirname,
    'node_modules/hls.js-webgpu/package.json'
));

const WEBGPU_HLS_WORKER_FILENAME = `hls.webgpu-${webGPUHLSPackageJson.version}.worker.js`;

const Assets = [
    'native-promise-only/npo.js',
    'libarchive.js/dist/worker-bundle.js',
    'libarchive.js/dist/libarchive.wasm',
    '@jellyfin/libass-wasm/dist/js/default.woff2',
    '@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.js',
    '@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.wasm',
    '@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker-legacy.js',
    'libpgs/dist/libpgs.worker.js',
    'pdfjs-dist/build/pdf.worker.js',
    'hls.js/dist/hls.worker.js'
];

const DEV_MODE = process.env.NODE_ENV !== 'production';
let COMMIT_SHA = '';
try {
    COMMIT_SHA = require('child_process')
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        .execSync('git describe --always --dirty')
        .toString()
        .trim();
} catch (err) {
    console.warn('Failed to get commit sha. Is git installed?', err);
}

const NODE_MODULES_REGEX = /[\\/]node_modules[\\/]/;

const THEMES = fg.globSync('themes/**/*.scss', { cwd: path.resolve(__dirname, 'src') });
const THEMES_BY_ID = THEMES.reduce((acc, theme) => {
    acc[theme.substring(0, theme.lastIndexOf('/'))] = `./${theme}`;
    return acc;
}, {});

const config = {
    context: path.resolve(__dirname, 'src'),
    target: 'browserslist',
    entry: {
        'main.jellyfin': './index.jsx',
        ...THEMES_BY_ID
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        modules: [
            path.resolve(__dirname, 'src'),
            path.resolve(__dirname, 'node_modules')
        ]
    },
    plugins: [
        new DefinePlugin({
            __COMMIT_SHA__: JSON.stringify(COMMIT_SHA),
            __JF_BUILD_VERSION__: JSON.stringify(
                process.env.WEBPACK_SERVE ?
                    'Dev Server' :
                    process.env.JELLYFIN_VERSION || 'Release'),
            __PACKAGE_JSON_NAME__: JSON.stringify(packageJson.name),
            __PACKAGE_JSON_VERSION__: JSON.stringify(packageJson.version),
            __USE_SYSTEM_FONTS__: !!JSON.parse(process.env.USE_SYSTEM_FONTS || '0'),
            __WEBPACK_SERVE__: !!JSON.parse(process.env.WEBPACK_SERVE || '0')
        }),
        new CleanWebpackPlugin(),
        new HtmlWebpackPlugin({
            filename: 'index.html',
            template: 'index.html',
            // Append file hashes to bundle urls for cache busting
            hash: true,
            chunks: [
                'main.jellyfin',
                'serviceworker'
            ]
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: 'assets',
                    to: 'assets'
                },
                'config.json',
                'robots.txt',
                {
                    from: 'touchicon*.png',
                    context: path.resolve(__dirname, 'node_modules/@jellyfin/ux-web/favicons'),
                    to: 'favicons'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@hevcjs/core/dist/wasm/hevc-decode.js'
                    ),
                    // Preserve the exact qualified vendor artifact in production
                    info: { minimized: true },
                    to: 'libraries/hevcjs/hevc-decode.js'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@hevcjs/core/dist/wasm/hevc-decode.wasm'
                    ),
                    to: 'libraries/hevcjs/hevc-decode.wasm'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@hevcjs/core/LICENSE'
                    ),
                    to: 'libraries/hevcjs/LICENSE.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc'
                    ),
                    // Jellyfin's static-file provider serves .bin as octet-stream
                    to: 'libraries/hevcjs/main10-4k-qualification.bin'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dolby-vision-parser/artifacts/dovi-rpu-parser.wasm'
                    ),
                    to: 'libraries/libdovi/dovi-rpu-parser.wasm'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dolby-vision-parser/LICENSE.libdovi.txt'
                    ),
                    to: 'libraries/libdovi/LICENSE.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dolby-vision-parser/REVISION'
                    ),
                    to: 'libraries/libdovi/REVISION',
                    toType: 'file'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@mediabunny/ac3/LICENSE'
                    ),
                    to: 'libraries/mediabunny-ac3/LICENSE.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dts/artifacts/COPYING.LGPLv2.1'
                    ),
                    to: 'libraries/libdcadec/COPYING.LGPLv2.1'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dts/artifacts/REVISION'
                    ),
                    to: 'libraries/libdcadec/REVISION',
                    toType: 'file'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dts/artifacts/libdcadec-source.tar.gz'
                    ),
                    to: 'libraries/libdcadec/libdcadec-source.tar.gz'
                },
                {
                    from: path.resolve(__dirname, 'LICENSE'),
                    to: 'libraries/libdcadec/LICENSE.bridge.GPL-2.0.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/dts/libdcadec_bridge.c'
                    ),
                    to: 'libraries/libdcadec/libdcadec_bridge.c'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/build_dts_decoder.py'
                    ),
                    to: 'libraries/libdcadec/build_dts_decoder.py'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/truehd/artifacts/COPYING.LGPLv2.1'
                    ),
                    to: 'libraries/ffmpeg-truehd/COPYING.LGPLv2.1'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/truehd/artifacts/REVISION'
                    ),
                    to: 'libraries/ffmpeg-truehd/REVISION',
                    toType: 'file'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/truehd/artifacts/ffmpeg-source.tar.gz'
                    ),
                    to: 'libraries/ffmpeg-truehd/ffmpeg-source.tar.gz'
                },
                {
                    from: path.resolve(__dirname, 'LICENSE'),
                    to: 'libraries/ffmpeg-truehd/LICENSE.bridge.GPL-2.0.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/truehd/ffmpeg_truehd_bridge.c'
                    ),
                    to: 'libraries/ffmpeg-truehd/ffmpeg_truehd_bridge.c'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/build_truehd_decoder.py'
                    ),
                    to: 'libraries/ffmpeg-truehd/build_truehd_decoder.py'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/pinned_ffmpeg_build.py'
                    ),
                    to: 'libraries/ffmpeg-truehd/pinned_ffmpeg_build.py'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.js'
                    ),
                    // Preserve the exact qualified Emscripten glue artifact
                    info: { minimized: true },
                    to: 'libraries/legacy-video/legacy-video-decode.js'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/artifacts/legacy-video-decode.wasm'
                    ),
                    to: 'libraries/legacy-video/legacy-video-decode.wasm'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/artifacts/manifest.json'
                    ),
                    to: 'libraries/legacy-video/manifest.json'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/LICENSE.ffmpeg.txt'
                    ),
                    to: 'libraries/legacy-video/LICENSE.ffmpeg.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/REVISION'
                    ),
                    to: 'libraries/legacy-video/REVISION',
                    toType: 'file'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/artifacts/ffmpeg-source.tar.gz'
                    ),
                    to: 'libraries/legacy-video/ffmpeg-source.tar.gz'
                },
                {
                    from: path.resolve(__dirname, 'LICENSE'),
                    to: 'libraries/legacy-video/LICENSE.bridge.GPL-2.0.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/bridge.c'
                    ),
                    to: 'libraries/legacy-video/bridge.c'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-decoder/build_legacy_video_decoder.py'
                    ),
                    to: 'libraries/legacy-video/build_legacy_video_decoder.py'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/pinned_ffmpeg_build.py'
                    ),
                    to: 'libraries/legacy-video/pinned_ffmpeg_build.py'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv'
                    ),
                    // Jellyfin serves the capability artifact under a generic media type
                    to: 'libraries/legacy-video/mpeg2-progressive-1920x1080-qualification.bin'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/legacy-video-capability-fixtures/vc1-advanced-progressive-1920x1080.mkv'
                    ),
                    // Jellyfin serves the capability artifact under a generic media type
                    to: 'libraries/legacy-video/vc1-advanced-progressive-1920x1080-qualification.bin'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.js'
                    ),
                    // Preserve the exact reviewed Emscripten glue artifact
                    info: { minimized: true },
                    to: 'libraries/openjpeg/openjpeg-decode.js'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm'
                    ),
                    to: 'libraries/openjpeg/openjpeg-decode.wasm'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/@cornerstonejs/codec-openjpeg/LICENSE'
                    ),
                    to: 'libraries/openjpeg/LICENSE.wrapper.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/openjpeg/LICENSE.openjpeg.txt'
                    ),
                    to: 'libraries/openjpeg/LICENSE.openjpeg.txt'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/openjpeg/REVISION'
                    ),
                    to: 'libraries/openjpeg/REVISION',
                    toType: 'file'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'scripts/webgpu/jpeg2000-capability-fixtures/srgb-960x540.jp2'
                    ),
                    // Jellyfin serves the capability artifact under a generic media type
                    to: 'libraries/openjpeg/jpeg2000-960x540-qualification.bin'
                },
                {
                    from: path.resolve(
                        __dirname,
                        'node_modules/hls.js-webgpu/dist/hls.worker.js'
                    ),
                    // Keep the modern WebGPU-owned worker isolated from the legacy player cache
                    to: `libraries/${WEBGPU_HLS_WORKER_FILENAME}`
                },
                ...Assets.map(asset => {
                    return {
                        from: path.resolve(__dirname, `node_modules/${asset}`),
                        to: 'libraries'
                    };
                })
            ]
        }),
        // The libarchive.js worker-bundle is copied manually.
        // If it is automatically bundled, escheck will fail since it uses import.meta.url.
        new IgnorePlugin({
            resourceRegExp: /worker-bundle\.js$/,
            contextRegExp: /libarchive.js/
        }),
        new ForkTsCheckerWebpackPlugin({
            typescript: {
                configFile: path.resolve(__dirname, 'tsconfig.json')
            }
        }),
        new MiniCssExtractPlugin({
            filename: pathData => {
                if (pathData.chunk?.name?.startsWith('themes/')) {
                    return '[name]/theme.css';
                }
                return '[name].[contenthash].css';
            },
            chunkFilename: '[name].[contenthash].css'
        })
    ],
    output: {
        filename: pathData => (
            pathData.chunk.name === 'serviceworker' ? '[name].js' : '[name].bundle.js'
        ),
        chunkFilename: '[name].[contenthash].chunk.js',
        assetModuleFilename: pathData => {
            if (pathData.filename === 'manifest.json') {
                return '[base]';
            }
            if (pathData.filename.startsWith('assets/') || pathData.filename.startsWith('themes/')) {
                return '[path][base][query]';
            }
            return '[name].[hash][ext][query]';
        },
        path: path.resolve(__dirname, 'dist'),
        publicPath: ''
    },
    optimization: {
        runtimeChunk: 'single',
        removeAvailableModules: false,
        removeEmptyChunks: false,
        splitChunks: {
            chunks: 'all',
            maxInitialRequests: Infinity,
            cacheGroups: {
                node_modules: {
                    test(module) {
                        return NODE_MODULES_REGEX.test(module.context);
                    },
                    name(module) {
                        // get the name. E.g. node_modules/packageName/not/this/part.js
                        // or node_modules/packageName
                        const packageName = module.context.match(/[\\/]node_modules[\\/](.*?)([\\/]|$)/)[1];
                        // if "packageName" is a namespace (i.e. @jellyfin) get the namespace + packageName
                        if (packageName.startsWith('@')) {
                            const parts = module.context
                                .substring(module.context.lastIndexOf(packageName))
                                .split(/[\\/]/);
                            return `node_modules.${parts[0]}.${parts[1]}`;
                        }

                        if (packageName === 'date-fns') {
                            const parts = module.context
                                .substring(module.context.lastIndexOf(packageName))
                                .split(/[\\/]/);

                            let name = `node_modules.${parts[0]}`;
                            if (parts[1]) {
                                name += `.${parts[1]}`;

                                if (parts[1] === 'locale' && parts[2]) {
                                    name += `.${parts[2]}`;
                                }
                            }

                            return name;
                        }

                        return `node_modules.${packageName}`;
                    }
                }
            }
        }
    },
    module: {
        rules: [
            {
                test: /\.(html)$/,
                use: {
                    loader: 'html-loader'
                }
            },
            {
                test: /\.(js|jsx|mjs)$/,
                include: [
                    path.resolve(__dirname, 'node_modules/@jellyfin/libass-wasm'),
                    path.resolve(__dirname, 'node_modules/@jellyfin/sdk'),
                    path.resolve(__dirname, 'node_modules/@mui/base'),
                    path.resolve(__dirname, 'node_modules/@mui/lab'),
                    path.resolve(__dirname, 'node_modules/@mui/material'),
                    path.resolve(__dirname, 'node_modules/@mui/private-theming'),
                    path.resolve(__dirname, 'node_modules/@mui/styled-engine'),
                    path.resolve(__dirname, 'node_modules/@mui/system'),
                    path.resolve(__dirname, 'node_modules/@mui/utils'),
                    path.resolve(__dirname, 'node_modules/@mui/x-date-pickers'),
                    path.resolve(__dirname, 'node_modules/@react-hook/latest'),
                    path.resolve(__dirname, 'node_modules/@react-hook/passive-layout-effect'),
                    path.resolve(__dirname, 'node_modules/@react-hook/resize-observer'),
                    path.resolve(__dirname, 'node_modules/@remix-run/router'),
                    path.resolve(__dirname, 'node_modules/@tanstack/match-sorter-utils'),
                    path.resolve(__dirname, 'node_modules/@tanstack/query-core'),
                    path.resolve(__dirname, 'node_modules/@tanstack/query-persist-client-core'),
                    path.resolve(__dirname, 'node_modules/@tanstack/react-query'),
                    path.resolve(__dirname, 'node_modules/@tanstack/react-table'),
                    path.resolve(__dirname, 'node_modules/@tanstack/react-virtual'),
                    path.resolve(__dirname, 'node_modules/@tanstack/table-core'),
                    path.resolve(__dirname, 'node_modules/@tanstack/virtual-core'),
                    path.resolve(__dirname, 'node_modules/@uupaa/dynamic-import-polyfill'),
                    path.resolve(__dirname, 'node_modules/axios'),
                    path.resolve(__dirname, 'node_modules/blurhash'),
                    path.resolve(__dirname, 'node_modules/compare-versions'),
                    path.resolve(__dirname, 'node_modules/date-fns'),
                    path.resolve(__dirname, 'node_modules/dom7'),
                    path.resolve(__dirname, 'node_modules/epubjs'),
                    path.resolve(__dirname, 'node_modules/flv.js'),
                    path.resolve(__dirname, 'node_modules/highlight-words'),
                    path.resolve(__dirname, 'node_modules/idb-keyval'),
                    path.resolve(__dirname, 'node_modules/libarchive.js'),
                    path.resolve(__dirname, 'node_modules/linkify-it'),
                    path.resolve(__dirname, 'node_modules/markdown-it'),
                    path.resolve(__dirname, 'node_modules/material-react-table'),
                    path.resolve(__dirname, 'node_modules/mdurl'),
                    path.resolve(__dirname, 'node_modules/proxy-polyfill'),
                    path.resolve(__dirname, 'node_modules/punycode'),
                    path.resolve(__dirname, 'node_modules/react-blurhash'),
                    path.resolve(__dirname, 'node_modules/react-lazy-load-image-component'),
                    path.resolve(__dirname, 'node_modules/react-router'),
                    path.resolve(__dirname, 'node_modules/remove-accents'),
                    path.resolve(__dirname, 'node_modules/screenfull'),
                    path.resolve(__dirname, 'node_modules/ssr-window'),
                    path.resolve(__dirname, 'node_modules/swiper'),
                    path.resolve(__dirname, 'node_modules/usehooks-ts'),
                    path.resolve(__dirname, 'src')
                ],
                use: [{
                    loader: 'babel-loader',
                    options: {
                        cacheCompression: false,
                        cacheDirectory: true
                    }
                }]
            },
            // Strict EcmaScript modules require additional flags
            {
                test: /\.(js|jsx|mjs)$/,
                include: [
                    path.resolve(__dirname, 'node_modules/@tanstack/query-devtools')
                ],
                resolve: {
                    fullySpecified: false
                },
                use: [{
                    loader: 'babel-loader',
                    options: {
                        cacheCompression: false,
                        cacheDirectory: true
                    }
                }]
            },
            {
                test: /\.worker\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'worker-loader',
                        options: {
                            chunkFilename: '[name].[contenthash].worker.chunk.js',
                            filename: '[name].[contenthash].bundle.js'
                        }
                    },
                    {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true
                        }
                    }
                ]
            },
            {
                test: /\.(ts|tsx)$/,
                exclude: /node_modules/,
                use: [{
                    loader: 'ts-loader',
                    options: {
                        transpileOnly: true
                    }
                }]
            },
            /* modules that Babel breaks when transforming to ESM */
            {
                test: /\.js$/,
                include: [
                    path.resolve(__dirname, 'node_modules/pdfjs-dist'),
                    path.resolve(__dirname, 'node_modules/xmldom')
                ],
                use: [{
                    loader: 'babel-loader',
                    options: {
                        cacheCompression: false,
                        cacheDirectory: true,
                        plugins: [
                            '@babel/transform-modules-umd'
                        ]
                    }
                }]
            },
            {
                test: /\.(sa|sc|c)ss$/i,
                oneOf: [
                    {
                        // Themes always need to use the MiniCssExtractPlugin since they are loaded directly
                        include: [
                            path.resolve(__dirname, 'src/themes/')
                        ],
                        use: [
                            {
                                loader: MiniCssExtractPlugin.loader,
                                options: {
                                    publicPath: '../../'
                                }
                            },
                            'css-loader',
                            {
                                loader: 'postcss-loader',
                                options: {
                                    postcssOptions: {
                                        config: path.resolve(__dirname, 'postcss.config.js')
                                    }
                                }
                            },
                            'sass-loader'
                        ]
                    },
                    {
                        use: [
                            DEV_MODE ? 'style-loader' : MiniCssExtractPlugin.loader,
                            'css-loader',
                            {
                                loader: 'postcss-loader',
                                options: {
                                    postcssOptions: {
                                        config: path.resolve(__dirname, 'postcss.config.js')
                                    }
                                }
                            },
                            'sass-loader'
                        ]
                    }
                ]
            },
            {
                test: /\.(ico|png|jpg|gif|svg)$/i,
                type: 'asset/resource'
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/,
                type: 'asset/resource'
            },
            {
                test: /\.(mp3)$/i,
                type: 'asset/resource'
            },
            {
                test: require.resolve('jquery'),
                loader: 'expose-loader',
                options: {
                    exposes: ['$', 'jQuery']
                }
            }
        ]
    }
};

module.exports = config;
