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

    override async draw() {
        let encoder = renderer.device.createCommandEncoder();
        const canvasTextureView = renderer.context.getCurrentTexture().createView();
    
        // Reset if camera moved
        if (this.camera.updated) {
            let resetPass = encoder.beginComputePass();
            resetPass.setPipeline(this.pathtracerComputePipelineClearTexture);
            resetPass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
            resetPass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
            resetPass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
            resetPass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp2);
            resetPass.dispatchWorkgroups(
                Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX),
                Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY)
            );
            resetPass.end();
            this.numFramesAveraged = 0;
            this.camera.updated = false;
        }
    
        this.camera.updateCameraUniformsNumFrames(this.numFramesAveraged);
        
        // Begin main compute pass
        let computePass = encoder.beginComputePass();
        const totalPaths = renderer.canvas.width * renderer.canvas.height;
        const workgroupsX = Math.ceil(renderer.canvas.width / shaders.constants.workgroupSizeX);
        const workgroupsY = Math.ceil(renderer.canvas.height / shaders.constants.workgroupSizeY);
    
        // Generate initial rays
        this.camera.updateCameraUniformsCounter();
        computePass.setPipeline(this.pathtracerComputePipelineGenerateRay);
        computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
        // Initialize carry buffer
        renderer.device.queue.writeBuffer(this.carryBuffer, 0, new Uint32Array([0, 0]));
    
        // For each bounce/depth level
        for (let depth = this.camera.rayDepth; depth >= 0; depth--) {
            // 1. Compute intersections for all paths
            this.camera.updateCameraUniformsCounter();
            computePass.setPipeline(this.pathtracerComputePipelineComputeIntersections);
            computePass.setBindGroup(shaders.constants.bindGroup_geometry, this.pathtracerGeometryBindGroup);
            computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
            // 2. Integrate/scatter for all paths
            this.camera.updateCameraUniformsCounter();
            computePass.setPipeline(this.pathtracerComputePipelineIntegrate);
            computePass.setBindGroup(shaders.constants.bindGroup_textures, this.pathtracerTextureBindGroup);
            computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
            if (depth > 0) { // Only compact if we have more bounces to do
                // 3. Mark active paths
                computePass.setPipeline(this.pathtracerComputePipelineMarkActive);
                computePass.setBindGroup(2, this.streamCompactionBindGroup);
                computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
                // 4. Prefix sum operations
                const totalElements = totalPaths;
                const numBlocks = Math.ceil(totalElements / this.SCAN_BLOCK_SIZE);
                
                // 4a. First scan within blocks
                computePass.setPipeline(this.pathtracerComputePipelinePrefixSum);
                computePass.dispatchWorkgroups(numBlocks, 1, 1);
    
                // 4b. Scan block sums
                computePass.setPipeline(this.pathtracerComputePipelinePrefixSumBlocks);
                computePass.dispatchWorkgroups(1, 1, 1);
    
                // 4c. Add block sums back
                computePass.setPipeline(this.pathtracerComputePipelineAddBlockSums);
                computePass.dispatchWorkgroups(numBlocks, 1, 1);
    
                // 5. Compact the paths
                computePass.setPipeline(this.pathtracerComputePipelineCompact);
                computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
            }
        }
    
        // Final gather
        computePass.setPipeline(this.pathtracerComputePipelineFinalGather);
        computePass.setBindGroup(shaders.constants.bindGroup_scene, this.sceneUniformsBindGroup);
        if (this.numFramesAveraged % 2 == 0) {
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp1);
        } else {
            computePass.setBindGroup(shaders.constants.bindGroup_pathtracer, this.pathtracerComputeBindGroupTemp2);
        }
        computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
        computePass.end();
    
        // Final render pass
        const renderPass = encoder.beginRenderPass({
            label: "pathtracer render pass",
            colorAttachments: [{
                view: canvasTextureView,
                clearValue: [0, 0, 0, 0],
                loadOp: "clear",
                storeOp: "store",
            }],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
    
        renderPass.setPipeline(this.pipeline);
        renderPass.setVertexBuffer(0, this.emptyBuffer);
        if (this.numFramesAveraged % 2 === 1) {
            renderPass.setBindGroup(0, this.renderTextureBindGroupTemp1);
        } else {
            renderPass.setBindGroup(0, this.renderTextureBindGroupTemp2);
        }
        renderPass.draw(6);
        renderPass.end();
    
        renderer.device.queue.submit([encoder.finish()]);
        this.numFramesAveraged += 1;
    }
}

