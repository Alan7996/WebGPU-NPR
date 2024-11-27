import * as renderer from "../renderer";
import * as shaders from "../shaders/shaders";
import { Stage } from "../stage/stage";

export class Pathtracer extends renderer.Renderer {
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;
    SCAN_BLOCK_SIZE = 128;
    depthTexture: GPUTexture;
    depthTextureView: GPUTextureView;

    emptyBuffer: GPUBuffer;

    pathSegmentsStorageBuffer: GPUBuffer;
    intersectionsStorageBuffer: GPUBuffer;

    pathtracerTempRenderTexture1: GPUTexture;
    pathtracerTempRenderTexture2: GPUTexture;
    pathtracerTempRenderTexture1View: GPUTextureView;
    pathtracerTempRenderTexture2View: GPUTextureView;

    pathtracerGeometryBindGroup: GPUBindGroup;
    pathtracerGeometryBindGroupLayout: GPUBindGroupLayout;
    pathtracerTextureBindGroup: GPUBindGroup;
    pathtracerTextureBindGroupLayout: GPUBindGroupLayout;

    pathtracerComputeBindGroupLayout: GPUBindGroupLayout;
    pathtracerComputeBindGroupTemp1: GPUBindGroup;
    pathtracerComputeBindGroupTemp2: GPUBindGroup;
    pathtracerComputePipelineGenerateRay: GPUComputePipeline;
    pathtracerComputePipelineComputeIntersections: GPUComputePipeline;
    pathtracerComputePipelineIntegrate: GPUComputePipeline;
    pathtracerComputePipelineFinalGather: GPUComputePipeline;
    pathtracerComputePipelineClearTexture: GPUComputePipeline;

    renderTextureBindGroupLayout: GPUBindGroupLayout;
    renderTextureBindGroupTemp1: GPUBindGroup;
    renderTextureBindGroupTemp2: GPUBindGroup;

    pipeline: GPURenderPipeline;

    numFramesAveraged: number;

    // AHHH

    // BUFFERS
    activePathsBuffer: GPUBuffer;        // Marks which paths are active (1) or inactive (0)
    compactedPathsBuffer: GPUBuffer;     // Final compacted indices 
    prefixSumBuffer: GPUBuffer;          // Used during prefix sum computation
    numActivePathsBuffer: GPUBuffer;     // Count of active paths
    debugReadbackBuffers: GPUBuffer[];
    debugBufferIndex: number = 0;

    blockSumsBuffer: GPUBuffer;
    carryBuffer: GPUBuffer;

    // BIND GROUP LAYOUTS
    // For stream compaction operations
    streamCompactionBindGroupLayout: GPUBindGroupLayout;

    // BIND GROUPS
    // For stream compaction operations
    streamCompactionBindGroup: GPUBindGroup;

    // PIPELINES
    // Initial marking of active paths
    pathtracerComputePipelineMarkActive: GPUComputePipeline;

    // Prefix sum computation
    pathtracerComputePipelinePrefixSum: GPUComputePipeline;
    pathtracerComputePipelinePrefixSumBlocks: GPUComputePipeline;
    pathtracerComputePipelineAddBlockSums: GPUComputePipeline;

    // Final compaction
    pathtracerComputePipelineCompact: GPUComputePipeline;

    

    // end AHHH

    constructor(stage: Stage) {
        super(stage);

        this.numFramesAveraged = 0;

        this.sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "scene uniforms bind group layout",
            entries: [
                {
                    // cameraSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" },
                },
                {
                    // lightSet
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });

        this.sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: "scene uniforms bind group",
            layout: this.sceneUniformsBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.camera.uniformsBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: this.lights.lightSetStorageBuffer },
                },
            ],
        });

        this.depthTexture = renderer.device.createTexture({
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthTextureView = this.depthTexture.createView();

        this.emptyBuffer = renderer.device.createBuffer({
            label: "empty buffer",
            size: 192,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // Pathtracer compute pipeline
        this.pathSegmentsStorageBuffer = renderer.device.createBuffer({
            label: "path segments",
            size: 64 * shaders.constants.maxResolutionWidth * shaders.constants.maxResolutionHeight,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.intersectionsStorageBuffer = renderer.device.createBuffer({
            label: "intersections",
            size: 32 * shaders.constants.maxResolutionWidth * shaders.constants.maxResolutionHeight,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.pathtracerTempRenderTexture1 = renderer.device.createTexture({
            label: "render texture temp 1",
            size: {
                width: renderer.canvas.width,
                height: renderer.canvas.height,
            },
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        this.pathtracerTempRenderTexture2 = renderer.device.createTexture({
            label: "render texture temp 2",
            size: {
                width: renderer.canvas.width,
                height: renderer.canvas.height,
            },
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        this.scene.addCustomObjects();
        const { geometryBindGroup, geometryBindGroupLayout, textureBindGroup, textureBindGroupLayout } =
            this.scene.createBuffersAndBindGroup();
        this.pathtracerGeometryBindGroup = geometryBindGroup;
        this.pathtracerGeometryBindGroupLayout = geometryBindGroupLayout;
        this.pathtracerTextureBindGroup = textureBindGroup;
        this.pathtracerTextureBindGroupLayout = textureBindGroupLayout;

        this.pathtracerTempRenderTexture1View = this.pathtracerTempRenderTexture1.createView();
        this.pathtracerTempRenderTexture2View = this.pathtracerTempRenderTexture2.createView();

        this.pathtracerComputeBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "pathtracer temp compute bind group layout",
            entries: [
                {
                    // render texture write
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { format: "rgba8unorm" },
                },
                {
                    // render texture read
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: {},
                },
                {
                    // path segments
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
                {
                    // intersections
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.pathtracerComputeBindGroupTemp1 = renderer.device.createBindGroup({
            label: "pathtracer compute bind group temp 1",
            layout: this.pathtracerComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.pathtracerTempRenderTexture1View,
                },
                {
                    binding: 1,
                    resource: this.pathtracerTempRenderTexture2View,
                },
                {
                    binding: 2,
                    resource: { buffer: this.pathSegmentsStorageBuffer },
                },
                {
                    binding: 3,
                    resource: { buffer: this.intersectionsStorageBuffer },
                },
            ],
        });

        this.pathtracerComputeBindGroupTemp2 = renderer.device.createBindGroup({
            label: "pathtracer temp 2 compute bind group",
            layout: this.pathtracerComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.pathtracerTempRenderTexture2View,
                },
                {
                    binding: 1,
                    resource: this.pathtracerTempRenderTexture1View,
                },
                {
                    binding: 2,
                    resource: { buffer: this.pathSegmentsStorageBuffer },
                },
                {
                    binding: 3,
                    resource: { buffer: this.intersectionsStorageBuffer },
                },
            ],
        });

        this.pathtracerComputePipelineGenerateRay = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline generate ray",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout generate ray",
                bindGroupLayouts: [this.sceneUniformsBindGroupLayout, this.pathtracerComputeBindGroupLayout],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "generateRay",
            },
        });

        this.pathtracerComputePipelineComputeIntersections = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline compute intersections",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout intersections",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    this.pathtracerComputeBindGroupLayout,
                    this.pathtracerGeometryBindGroupLayout,
                ],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "computeIntersections",
            },
        });

        this.pathtracerComputePipelineIntegrate = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline integrate",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout integrate",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    this.pathtracerComputeBindGroupLayout,
                    this.pathtracerTextureBindGroupLayout,
                ],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "integrate",
            },
        });

        this.pathtracerComputePipelineFinalGather = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline final gather",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout final gather",
                bindGroupLayouts: [this.sceneUniformsBindGroupLayout, this.pathtracerComputeBindGroupLayout],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "finalGather",
            },
        });

        this.pathtracerComputePipelineClearTexture = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline clear texture",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout clear texture",
                bindGroupLayouts: [this.sceneUniformsBindGroupLayout, this.pathtracerComputeBindGroupLayout],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "clearTexture",
            },
        });

        // Pathtracer render pipeline
        this.renderTextureBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "render texture bind group layout",
            entries: [
                {
                    // render texture image
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {},
                },
            ],
        });

        this.renderTextureBindGroupTemp1 = renderer.device.createBindGroup({
            label: "render texture bind group temp 1",
            layout: this.renderTextureBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.pathtracerTempRenderTexture1View,
                },
            ],
        });

        this.renderTextureBindGroupTemp2 = renderer.device.createBindGroup({
            label: "render texture bind group temp 2",
            layout: this.renderTextureBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.pathtracerTempRenderTexture2View,
                },
            ],
        });

        this.pipeline = renderer.device.createRenderPipeline({
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer pipeline layout",
                bindGroupLayouts: [this.renderTextureBindGroupLayout],
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus",
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer vert shader",
                    code: shaders.pathtracerVertSrc,
                }),
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer frag shader",
                    code: shaders.pathtracerFragSrc,
                }),
                targets: [
                    {
                        format: renderer.canvasFormat,
                    },
                ],
            },
        });


        // AHHHHH
        // Add after the existing intersection buffer creation:

        // Stream compaction buffers
        this.activePathsBuffer = renderer.device.createBuffer({
            label: "active paths buffer",
            size: 4 * shaders.constants.maxResolutionWidth * shaders.constants.maxResolutionHeight,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.compactedPathsBuffer = renderer.device.createBuffer({
            label: "compacted paths buffer",
            size: 4 * shaders.constants.maxResolutionWidth * shaders.constants.maxResolutionHeight,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 
        });

        this.prefixSumBuffer = renderer.device.createBuffer({
            label: "prefix sum buffer",
            size: 4 * shaders.constants.maxResolutionWidth * shaders.constants.maxResolutionHeight,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.numActivePathsBuffer = renderer.device.createBuffer({
            label: "num active paths buffer",
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.blockSumsBuffer = renderer.device.createBuffer({
            label: "block sums buffer",
            size: (128 * 4), // Using same constant as example
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        
        this.carryBuffer = renderer.device.createBuffer({
            label: "carry buffer",
            size: 8,  // Two u32s: carry.in and carry.out
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        
        // Create bind group layouts
        this.streamCompactionBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "stream compaction bind group layout",
            entries: [
                {
                    // active paths
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                {
                    // compacted paths 
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                {
                    // prefix sum
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                {
                    // block sums 
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                {
                    // carry sums 
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                }

            ]
        });

        // Create the stream compaction bind group
        this.streamCompactionBindGroup = renderer.device.createBindGroup({
            label: "stream compaction bind group",
            layout: this.streamCompactionBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.activePathsBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.compactedPathsBuffer }
                },
                {
                    binding: 2,
                    resource: { buffer: this.prefixSumBuffer }
                },
                {
                    binding: 3,
                    resource: { buffer: this.blockSumsBuffer }
                },
                {
                    binding: 4,
                    resource: { buffer: this.carryBuffer }
                }
            ]
        });

        // Create compute pipeline for stream compaction
        this.pathtracerComputePipelineCompact = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline stream compaction",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout stream compaction",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    this.pathtracerComputeBindGroupLayout,
                    this.streamCompactionBindGroupLayout
                ]
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "streamCompaction",
            }
        });


        // Create pipeline for marking active paths
        this.pathtracerComputePipelineMarkActive = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline mark active",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout mark active",
                bindGroupLayouts: [
                    this.sceneUniformsBindGroupLayout,
                    this.pathtracerComputeBindGroupLayout,
                    this.streamCompactionBindGroupLayout
                ]
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "markActivePaths",
            }
        });

        // Create pipeline for prefix sum computation
        this.pathtracerComputePipelinePrefixSum = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline prefix sum",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout prefix sum",
                bindGroupLayouts: [ this.sceneUniformsBindGroupLayout, 
                    this.pathtracerComputeBindGroupLayout,
                    this.streamCompactionBindGroupLayout
                ]
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader prefix sum",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "prefixSumFn",
            }
        });

        this.pathtracerComputePipelinePrefixSumBlocks = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline prefix sum blocks",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout prefix sum blocks",
                bindGroupLayouts: [ this.sceneUniformsBindGroupLayout, 
                    this.pathtracerComputeBindGroupLayout,
                    this.streamCompactionBindGroupLayout
                ]
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader prefix sum blocks",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "prefixSumBlocks"
            }
        });

        this.pathtracerComputePipelineAddBlockSums = renderer.device.createComputePipeline({
            label: "pathtracer compute pipeline add block sums",
            layout: renderer.device.createPipelineLayout({
                label: "pathtracer compute pipeline layout add block sums",
                bindGroupLayouts: [ this.sceneUniformsBindGroupLayout, 
                    this.pathtracerComputeBindGroupLayout,
                    this.streamCompactionBindGroupLayout
                ]  // Reuse same layout as first stage
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: "pathtracer compute shader add block sums",
                    code: shaders.pathtracerComputeSrc,
                }),
                entryPoint: "addBlockSums"
            }
        });

        this.debugReadbackBuffers = [
            renderer.device.createBuffer({
                size: 2048,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            }),
            renderer.device.createBuffer({
                size: 2048,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
            })
        ];

        // end AHHHH
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder();
        const canvasTextureView = renderer.context.getCurrentTexture().createView();
    
        const computePass = encoder.beginComputePass();
    
        if (this.camera.updated) {
            // Reset contents of render textures
            computePass.setPipeline(this.pathtracerComputePipelineClearTexture);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
    
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp2);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
            this.numFramesAveraged = 0;
            this.camera.updated = false;
        }
    
        this.camera.updateCameraUniformsNumFrames(this.numFramesAveraged);
    
        // Generate camera rays
        this.camera.updateCameraUniformsCounter();
        computePass.setPipeline(this.pathtracerComputePipelineGenerateRay);
        computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
        computePass.dispatchWorkgroups(
            Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
            Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
        );
    
        for (let d = this.camera.rayDepth; d >= 0; d--) {
            // Compute ray-scene intersections
            this.camera.updateCameraUniformsCounter();
            computePass.setPipeline(this.pathtracerComputePipelineComputeIntersections);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(shaders.constants.bindGroup_geometry, this.pathtracerGeometryBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
    
            // Evaluate the integral and shade materials
            this.camera.updateCameraUniformsCounter();
            computePass.setPipeline(this.pathtracerComputePipelineIntegrate);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(shaders.constants.bindGroup_textures, this.pathtracerTextureBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
    
            // Stream compaction
            // 1. Mark active paths
            computePass.setPipeline(this.pathtracerComputePipelineMarkActive);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(2, this.streamCompactionBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );

            //2. First stage of prefix sum
            computePass.setPipeline(this.pathtracerComputePipelinePrefixSum);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(2, this.streamCompactionBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width * renderer.canvas.height / this.SCAN_BLOCK_SIZE), 
                1, 
                1
            );

            // 3. 
            computePass.setPipeline(this.pathtracerComputePipelinePrefixSumBlocks);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(2, this.streamCompactionBindGroup);
            computePass.dispatchWorkgroups(1, 1, 1);  // Single dispatch since operating on block sums

            // After prefixSumBlocks in your draw loop:
            computePass.setPipeline(this.pathtracerComputePipelineAddBlockSums);
            computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            computePass.setBindGroup(2, this.streamCompactionBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width * renderer.canvas.height / this.SCAN_BLOCK_SIZE), 
                1, 
                1
            );

        }
    
        // End first compute pass before copy
        computePass.end();
    
        // Do the buffer copy
        encoder.copyBufferToBuffer(
            this.activePathsBuffer,
            0,  // src offset
            this.debugReadbackBuffers[this.debugBufferIndex],
            0,  // dst offset
            16  // size - copying 4 uint32s
        );
        encoder.copyBufferToBuffer(
            this.prefixSumBuffer,
            0,
            this.debugReadbackBuffers[this.debugBufferIndex],
            16, // Offset by 16 bytes
            16  // Next 4 values
        );

        // For debugging, add another buffer copy to see block sums results
        encoder.copyBufferToBuffer(
            this.blockSumsBuffer,
            0,
            this.debugReadbackBuffers[this.debugBufferIndex],
            32,  // Offset past the previous debug data
            16
        );


        // Update debug readout to include final values
        encoder.copyBufferToBuffer(
            this.prefixSumBuffer,
            0,
            this.debugReadbackBuffers[this.debugBufferIndex],
            48, // Offset to new position after other debug data
            16  // Next 4 values
        );

        encoder.copyBufferToBuffer(
            this.carryBuffer,
            0,
            this.debugReadbackBuffers[this.debugBufferIndex],
            64,  // New offset
            8    // Two u32s
        );

        encoder.copyBufferToBuffer(
            this.activePathsBuffer,
            128 * 4,  // Look at start of second block
            this.debugReadbackBuffers[this.debugBufferIndex],
            80,  // New offset
            16   // Four elements from second block
        );
    
        // Begin new compute pass for final gather
        const finalGatherPass = encoder.beginComputePass();
        finalGatherPass.setPipeline(this.pathtracerComputePipelineFinalGather);
        finalGatherPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        if (this.numFramesAveraged % 2 == 0) {
            finalGatherPass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
        } else {
            finalGatherPass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp2);
        }
        finalGatherPass.dispatchWorkgroups(
            Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
            Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
        );
        finalGatherPass.end();
    
        this.numFramesAveraged += 1;
    
        const renderPass = encoder.beginRenderPass({
            label: "pathtracer render pass",
            colorAttachments: [
                {
                    view: canvasTextureView,
                    clearValue: [0, 0, 0, 0],
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
    
        renderPass.setPipeline(this.pipeline);
        renderPass.setVertexBuffer(0, this.emptyBuffer);
        if (this.numFramesAveraged % 2 == 1) {
            renderPass.setBindGroup(0, this.renderTextureBindGroupTemp1);
        } else {
            renderPass.setBindGroup(0, this.renderTextureBindGroupTemp2);
        }
        renderPass.draw(6);
        renderPass.end();
    
        renderer.device.queue.submit([encoder.finish()]);

        if (this.numFramesAveraged % 30 === 0) {
            const currentBuffer = this.debugReadbackBuffers[this.debugBufferIndex];
            this.debugBufferIndex = (this.debugBufferIndex + 1) % 2;
            currentBuffer.mapAsync(GPUMapMode.READ).then(() => {
                const data = new Uint32Array(currentBuffer.getMappedRange());
                console.log("Active flags (first 4):", Array.from(data.slice(0, 4)));
                console.log("Prefix sum results (first 4):", Array.from(data.slice(4, 8)));
                console.log("Block sums results (first 4):", Array.from(data.slice(8, 12)));
                console.log("Final prefix sum (first 4):", Array.from(data.slice(12, 16)));
                console.log("Carry buffer:", Array.from(data.slice(16, 18)));
                console.log("Block index calculation:", Math.floor(4 / 128));
                console.log("Second block active flags:", Array.from(data.slice(20, 24))); // New debug output
                currentBuffer.unmap();

            });
        }
    }
}

