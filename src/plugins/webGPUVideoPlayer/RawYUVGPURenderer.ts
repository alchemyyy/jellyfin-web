import {
    createRenderSettingsUniformData,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
    type HDR10PlusFrameRenderSettings,
    type HDRToSDRRenderSettings
} from './RenderSettings';
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './custom/RawVideoFrameCopy';

const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const WORDS_PER_ENHANCEMENT_UNIFORM = 4;
const RAW_YUV_VERTEX_COUNT = 6;

export const RAW_YUV_ENHANCEMENT_UNIFORM_BYTE_LENGTH =
    WORDS_PER_ENHANCEMENT_UNIFORM * Uint32Array.BYTES_PER_ELEMENT;

export type RawYUVTexturePresentation = {
    textureOffsetX: number
    textureOffsetY: number
    textureScaleX: number
    textureScaleY: number
    viewportHeight: number
    viewportWidth: number
    viewportX: number
    viewportY: number
};

type RawPlaneTexture = {
    kind: RawVideoPlaneDescriptor['kind']
    texture: GPUTexture
    view: GPUTextureView
};

export type RawPlaneTextureSet = {
    codedHeight: number
    codedWidth: number
    device: GPUDevice
    format: SupportedRawVideoFrameFormat
    planes: readonly RawPlaneTexture[]
};

export type RawYUVRenderResources = {
    pipeline: GPURenderPipeline
    presentationUniformBuffer: GPUBuffer
    renderSettingsUniformBuffer: GPUBuffer
};

export type RawYUVRenderRequest = RawYUVRenderResources & {
    device: GPUDevice
    dolbyVisionEnhancementUniformBuffer?: GPUBuffer
    dolbyVisionRPUStorageBuffer?: GPUBuffer
    enhancementFrame?: TransferableRawVideoFrame | null
    enhancementTextureSet?: RawPlaneTextureSet | null
    frame: TransferableRawVideoFrame
    presentation: RawYUVTexturePresentation
    targetView: GPUTextureView
    textureSet: RawPlaneTextureSet | null
};

export type RawYUVRenderResult = {
    enhancementTextureSet: RawPlaneTextureSet | null
    presentationUniformValues: Float32Array
    textureSet: RawPlaneTextureSet
};

type ExpectedRawPlane = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    height: number
    kind: RawVideoPlaneDescriptor['kind']
    width: number
};

function createExpectedRawPlanes(
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number
): readonly ExpectedRawPlane[] {
    const chromaWidth = Math.ceil(codedWidth / 2);
    const chromaHeight = Math.ceil(codedHeight / 2);
    const expectedPlanes: ExpectedRawPlane[] = [];
    switch (format) {
        case 'I420':
            expectedPlanes.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, height: codedHeight, kind: 'y', width: codedWidth },
                { bytesPerComponent: 1, componentsPerTexel: 1, height: chromaHeight, kind: 'u', width: chromaWidth },
                { bytesPerComponent: 1, componentsPerTexel: 1, height: chromaHeight, kind: 'v', width: chromaWidth }
            );
            break;
        case 'I420P10':
        case 'I420P12':
            expectedPlanes.push(
                { bytesPerComponent: 2, componentsPerTexel: 1, height: codedHeight, kind: 'y', width: codedWidth },
                { bytesPerComponent: 2, componentsPerTexel: 1, height: chromaHeight, kind: 'u', width: chromaWidth },
                { bytesPerComponent: 2, componentsPerTexel: 1, height: chromaHeight, kind: 'v', width: chromaWidth }
            );
            break;
        case 'NV12':
            expectedPlanes.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, height: codedHeight, kind: 'y', width: codedWidth },
                { bytesPerComponent: 1, componentsPerTexel: 2, height: chromaHeight, kind: 'uv', width: chromaWidth }
            );
            break;
    }
    return expectedPlanes;
}

function alignRawPlaneBytesPerRow(rowByteLength: number): number {
    return Math.ceil(rowByteLength / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT)
        * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
}

function hasValidRawFrameGeometry(frame: TransferableRawVideoFrame): boolean {
    const rectangle = frame.visibleRectangle;
    const integerValues = [
        frame.codedHeight,
        frame.codedWidth,
        frame.displayHeight,
        frame.displayWidth,
        rectangle.height,
        rectangle.width,
        rectangle.x,
        rectangle.y
    ];
    return integerValues.every((value: number): boolean => Number.isSafeInteger(value))
        && frame.codedHeight > 0
        && frame.codedWidth > 0
        && frame.displayHeight > 0
        && frame.displayWidth > 0
        && rectangle.height > 0
        && rectangle.width > 0
        && rectangle.x >= 0
        && rectangle.y >= 0
        && rectangle.x % 2 === 0
        && rectangle.y % 2 === 0
        && rectangle.x + rectangle.width <= frame.codedWidth
        && rectangle.y + rectangle.height <= frame.codedHeight;
}

/** Validates the exact padded raw-plane descriptor consumed by WebGPU uploads. */
export function hasValidRawVideoFrameLayout(frame: TransferableRawVideoFrame): boolean {
    if (!hasValidRawFrameGeometry(frame)) {
        return false;
    }

    const expectedPlanes = createExpectedRawPlanes(
        frame.format,
        frame.codedWidth,
        frame.codedHeight
    );
    if (frame.planes.length !== expectedPlanes.length) {
        return false;
    }

    const firstPlane = frame.planes[0];
    if (
        !firstPlane
        || !Number.isSafeInteger(firstPlane.byteOffset)
        || firstPlane.byteOffset < 0
        || firstPlane.byteOffset % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT !== 0
    ) {
        return false;
    }
    const frameByteOffset = firstPlane.byteOffset;
    let expectedByteOffset = frameByteOffset;
    for (let planeIndex = 0; planeIndex < expectedPlanes.length; planeIndex += 1) {
        const expectedPlane = expectedPlanes[planeIndex];
        const plane = frame.planes[planeIndex];
        const rowByteLength = expectedPlane.width
            * expectedPlane.componentsPerTexel
            * expectedPlane.bytesPerComponent;
        const bytesPerRow = alignRawPlaneBytesPerRow(rowByteLength);
        const byteLength = bytesPerRow * expectedPlane.height;
        if (
            plane.byteLength !== byteLength
            || plane.byteOffset !== expectedByteOffset
            || plane.bytesPerComponent !== expectedPlane.bytesPerComponent
            || plane.bytesPerRow !== bytesPerRow
            || plane.componentsPerTexel !== expectedPlane.componentsPerTexel
            || plane.height !== expectedPlane.height
            || plane.kind !== expectedPlane.kind
            || plane.rowByteLength !== rowByteLength
            || plane.width !== expectedPlane.width
        ) {
            return false;
        }
        expectedByteOffset += byteLength;
    }

    return Number.isSafeInteger(expectedByteOffset)
        && expectedByteOffset > frameByteOffset
        && expectedByteOffset <= frame.data.byteLength;
}

/** Creates the exact render pipeline shared by production and authorization probes. */
export function createRawYUVRenderPipeline(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    shaderCode: string
): Promise<GPURenderPipeline> {
    const shaderModule = device.createShaderModule({ code: shaderCode });
    return device.createRenderPipelineAsync({
        fragment: {
            entryPoint: 'fragmentMain',
            module: shaderModule,
            targets: [{ format: targetFormat }]
        },
        layout: 'auto',
        primitive: { topology: 'triangle-list' },
        vertex: {
            entryPoint: 'vertexMain',
            module: shaderModule
        }
    });
}

/** Creates and initializes the exact uniform buffers used by raw presentation. */
export function createRawYUVRenderResources(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    settings: HDRToSDRRenderSettings
): RawYUVRenderResources {
    const presentationUniformBuffer = device.createBuffer({
        label: 'WebGPU video presentation uniforms',
        size: FLOATS_PER_PRESENTATION_UNIFORM * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
    const renderSettingsUniformBuffer = createRawYUVRenderSettingsUniformBuffer(device);
    writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, settings);
    return {
        pipeline,
        presentationUniformBuffer,
        renderSettingsUniformBuffer
    };
}

/** Creates the exact raw HDR render-settings uniform buffer. */
export function createRawYUVRenderSettingsUniformBuffer(device: GPUDevice): GPUBuffer {
    return device.createBuffer({
        label: 'WebGPU video render settings uniforms',
        size: RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
}

/** Creates the fixed flag buffer that makes optional EL bindings deterministic. */
export function createRawYUVEnhancementUniformBuffer(device: GPUDevice): GPUBuffer {
    return device.createBuffer({
        label: 'WebGPU Dolby Vision enhancement uniforms',
        size: RAW_YUV_ENHANCEMENT_UNIFORM_BYTE_LENGTH,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
}

/** Writes the versioned raw HDR render-settings uniform payload. */
export function writeRawYUVRenderSettingsUniform(
    device: GPUDevice,
    uniformBuffer: GPUBuffer,
    settings: HDRToSDRRenderSettings,
    dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null
): void {
    device.queue.writeBuffer(
        uniformBuffer,
        0,
        createRenderSettingsUniformData(settings, dynamicFrameSettings)
    );
}

function getRawPlaneTextureFormat(plane: RawVideoPlaneDescriptor): GPUTextureFormat {
    if (plane.bytesPerComponent === 2) {
        return 'r16uint';
    }
    return plane.componentsPerTexel === 2 ? 'rg8uint' : 'r8uint';
}

/** Destroys all plane textures retained by a raw renderer. */
export function destroyRawPlaneTextureSet(textureSet: RawPlaneTextureSet | null): void {
    if (!textureSet) {
        return;
    }
    for (const plane of textureSet.planes) {
        plane.texture.destroy();
    }
}

function getOrCreateRawPlaneTextures(
    device: GPUDevice,
    frame: TransferableRawVideoFrame,
    textureSet: RawPlaneTextureSet | null
): RawPlaneTextureSet {
    if (
        textureSet
        && textureSet.device === device
        && textureSet.format === frame.format
        && textureSet.codedHeight === frame.codedHeight
        && textureSet.codedWidth === frame.codedWidth
    ) {
        return textureSet;
    }

    destroyRawPlaneTextureSet(textureSet);
    const maximumTextureDimension = device.limits.maxTextureDimension2D;
    const planes: RawPlaneTexture[] = [];
    try {
        for (const plane of frame.planes) {
            if (plane.width > maximumTextureDimension || plane.height > maximumTextureDimension) {
                throw new RangeError('Raw video plane exceeds the GPU texture limit');
            }
            const texture = device.createTexture({
                dimension: '2d',
                format: getRawPlaneTextureFormat(plane),
                label: `WebGPU raw video ${plane.kind.toUpperCase()} plane`,
                size: {
                    depthOrArrayLayers: 1,
                    height: plane.height,
                    width: plane.width
                },
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
            });
            planes.push({
                kind: plane.kind,
                texture,
                view: texture.createView()
            });
        }
    } catch (error) {
        for (const plane of planes) {
            plane.texture.destroy();
        }
        throw error;
    }

    return {
        codedHeight: frame.codedHeight,
        codedWidth: frame.codedWidth,
        device,
        format: frame.format,
        planes
    };
}

function uploadRawPlanes(
    device: GPUDevice,
    textureSet: RawPlaneTextureSet,
    frame: TransferableRawVideoFrame
): void {
    for (let planeIndex = 0; planeIndex < frame.planes.length; planeIndex += 1) {
        const plane = frame.planes[planeIndex];
        const planeTexture = textureSet.planes[planeIndex];
        if (planeTexture.kind !== plane.kind) {
            throw new Error('Raw video plane texture order changed unexpectedly');
        }
        device.queue.writeTexture(
            { texture: planeTexture.texture },
            frame.data,
            {
                bytesPerRow: plane.bytesPerRow,
                offset: plane.byteOffset,
                rowsPerImage: plane.height
            },
            {
                depthOrArrayLayers: 1,
                height: plane.height,
                width: plane.width
            }
        );
    }
}

function getUploadedEnhancementTextureSet(
    request: RawYUVRenderRequest,
    textureSet: RawPlaneTextureSet | null
): RawPlaneTextureSet | null {
    const enhancementFrame = request.enhancementFrame ?? null;
    if (!enhancementFrame) {
        destroyRawPlaneTextureSet(textureSet);
        return null;
    }
    if (
        !hasValidRawVideoFrameLayout(enhancementFrame)
        || enhancementFrame.data !== request.frame.data
    ) {
        throw new RangeError('Raw Dolby Vision enhancement frame layout is invalid');
    }

    const uploadedTextureSet = getOrCreateRawPlaneTextures(
        request.device,
        enhancementFrame,
        textureSet
    );
    try {
        uploadRawPlanes(request.device, uploadedTextureSet, enhancementFrame);
        return uploadedTextureSet;
    } catch (error) {
        if (uploadedTextureSet !== textureSet) {
            destroyRawPlaneTextureSet(uploadedTextureSet);
        }
        throw error;
    }
}

function appendDolbyVisionEnhancementBindings(
    request: RawYUVRenderRequest,
    bindGroupEntries: GPUBindGroupEntry[],
    textureSet: RawPlaneTextureSet,
    enhancementTextureSet: RawPlaneTextureSet | null
): void {
    const uniformBuffer = request.dolbyVisionEnhancementUniformBuffer;
    if (!uniformBuffer) {
        return;
    }

    const enhancementUniformValues = new Uint32Array(
        WORDS_PER_ENHANCEMENT_UNIFORM
    );
    enhancementUniformValues[0] = request.enhancementFrame ? 1 : 0;
    request.device.queue.writeBuffer(
        uniformBuffer,
        0,
        enhancementUniformValues
    );
    const enhancementPlanes = enhancementTextureSet?.planes ?? textureSet.planes;
    if (enhancementPlanes.length !== 3) {
        throw new Error('Dolby Vision enhancement binding requires planar YUV');
    }
    for (
        let planeIndex = 0;
        planeIndex < enhancementPlanes.length;
        planeIndex += 1
    ) {
        bindGroupEntries.push({
            binding: planeIndex + 6,
            resource: enhancementPlanes[planeIndex].view
        });
    }
    bindGroupEntries.push({
        binding: 9,
        resource: { buffer: uniformBuffer }
    });
}

function createPresentationUniformValues(
    frame: TransferableRawVideoFrame,
    presentation: RawYUVTexturePresentation
): Float32Array<ArrayBuffer> {
    const visibleRectangle = frame.visibleRectangle;
    const visibleScaleX = visibleRectangle.width / frame.codedWidth;
    const visibleScaleY = visibleRectangle.height / frame.codedHeight;
    const values = new Float32Array(new ArrayBuffer(
        FLOATS_PER_PRESENTATION_UNIFORM * Float32Array.BYTES_PER_ELEMENT
    ));
    values[0] = presentation.textureScaleX * visibleScaleX;
    values[1] = presentation.textureScaleY * visibleScaleY;
    values[2] = (visibleRectangle.x / frame.codedWidth)
        + presentation.textureOffsetX * visibleScaleX;
    values[3] = (visibleRectangle.y / frame.codedHeight)
        + presentation.textureOffsetY * visibleScaleY;
    return values;
}

/** Uploads, binds, draws, and submits one raw frame through the shared route. */
export function renderRawYUVFrame(request: RawYUVRenderRequest): RawYUVRenderResult {
    if (!hasValidRawVideoFrameLayout(request.frame)) {
        throw new RangeError('Raw video frame layout is invalid');
    }
    const textureSet = getOrCreateRawPlaneTextures(
        request.device,
        request.frame,
        request.textureSet
    );
    let enhancementTextureSet = request.enhancementTextureSet ?? null;
    try {
        uploadRawPlanes(request.device, textureSet, request.frame);
        enhancementTextureSet = getUploadedEnhancementTextureSet(
            request,
            enhancementTextureSet
        );

        const presentationUniformValues = createPresentationUniformValues(
            request.frame,
            request.presentation
        );
        request.device.queue.writeBuffer(
            request.presentationUniformBuffer,
            0,
            presentationUniformValues
        );

        const bindGroupEntries: GPUBindGroupEntry[] = [];
        bindGroupEntries.push({
            binding: 0,
            resource: { buffer: request.presentationUniformBuffer }
        });
        for (let planeIndex = 0; planeIndex < textureSet.planes.length; planeIndex += 1) {
            bindGroupEntries.push({
                binding: planeIndex + 1,
                resource: textureSet.planes[planeIndex].view
            });
        }
        bindGroupEntries.push({
            binding: request.frame.format === 'NV12' ? 3 : 4,
            resource: { buffer: request.renderSettingsUniformBuffer }
        });
        if (request.dolbyVisionRPUStorageBuffer) {
            bindGroupEntries.push({
                binding: 5,
                resource: { buffer: request.dolbyVisionRPUStorageBuffer }
            });
        }
        appendDolbyVisionEnhancementBindings(
            request,
            bindGroupEntries,
            textureSet,
            enhancementTextureSet
        );
        const bindGroup = request.device.createBindGroup({
            entries: bindGroupEntries,
            layout: request.pipeline.getBindGroupLayout(0)
        });
        const commandEncoder = request.device.createCommandEncoder();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
                view: request.targetView
            }]
        });
        renderPass.setPipeline(request.pipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setViewport(
            request.presentation.viewportX,
            request.presentation.viewportY,
            request.presentation.viewportWidth,
            request.presentation.viewportHeight,
            0,
            1
        );
        renderPass.draw(RAW_YUV_VERTEX_COUNT);
        renderPass.end();
        request.device.queue.submit([ commandEncoder.finish() ]);

        return {
            enhancementTextureSet,
            presentationUniformValues,
            textureSet
        };
    } catch (error) {
        if (textureSet !== request.textureSet) {
            destroyRawPlaneTextureSet(textureSet);
        }
        if (enhancementTextureSet !== request.enhancementTextureSet) {
            destroyRawPlaneTextureSet(enhancementTextureSet);
        }
        throw error;
    }
}
