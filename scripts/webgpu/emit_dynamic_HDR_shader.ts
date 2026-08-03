import { createPQColorMetadata } from '../../src/plugins/webGPUVideoPlayer/color/ColorMetadata';
import { createRawYUVColorPipelineWGSL } from '../../src/plugins/webGPUVideoPlayer/color/ColorPipelineShader';
import { createHDRToSDRRenderSettings } from '../../src/plugins/webGPUVideoPlayer/RenderSettings';

const shaderCode = createRawYUVColorPipelineWGSL(
    createPQColorMetadata(),
    createHDRToSDRRenderSettings(),
    'I420P10'
);

process.stdout.write(JSON.stringify({
    route: 'I420P10:bt2020-ncl:bt2020:limited:pq:hdr10plus',
    shaderCode
}));
