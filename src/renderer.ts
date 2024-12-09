import { Scene } from "./stage/scene";
import { Camera } from "./stage/camera";
import { Stage } from "./stage/stage";

export var canvas: HTMLCanvasElement;
export var canvasFormat: GPUTextureFormat;
export var context: GPUCanvasContext;
export var device: GPUDevice;
export var canvasTextureView: GPUTextureView;

export var aspectRatio: number;
export const fovYDegrees = 45;

export var modelBindGroupLayout: GPUBindGroupLayout;
export var materialBindGroupLayout: GPUBindGroupLayout;

export var canTimestamp: boolean;

// initialize WebGPU and also creates some bind group layouts shared by all the renderers
export async function initWebGPU() {
    canvas = document.getElementById("mainCanvas") as HTMLCanvasElement;

    //const devicePixelRatio = window.devicePixelRatio;
    canvas.width = canvas.clientWidth; // * devicePixelRatio;
    canvas.height = canvas.clientHeight; // * devicePixelRatio;

    aspectRatio = canvas.width / canvas.height;

    if (!navigator.gpu) {
        let errorMessageElement = document.createElement("h1");
        errorMessageElement.textContent = "This browser doesn't support WebGPU! Try using Google Chrome.";
        errorMessageElement.style.paddingLeft = "0.4em";
        document.body.innerHTML = "";
        document.body.appendChild(errorMessageElement);
        throw new Error("WebGPU not supported on this browser");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("no appropriate GPUAdapter found");
    }

    canTimestamp = adapter.features.has("timestamp-query");
    const hasBGRA8unormStorage = adapter.features.has("bgra8unorm-storage");
    device = await adapter.requestDevice({
        requiredFeatures: canTimestamp
            ? hasBGRA8unormStorage
                ? ["timestamp-query", "bgra8unorm-storage"]
                : ["timestamp-query"]
            : hasBGRA8unormStorage
              ? ["bgra8unorm-storage"]
              : [],
        // requiredLimits: {
        //     maxStorageBufferBindingSize: 2147483644,
        //     maxBufferSize: 2147483644,
        // },
    });

    context = canvas.getContext("webgpu")!;
    canvasFormat = hasBGRA8unormStorage ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm";
    context.configure({
        device: device,
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    console.log("WebGPU init successful");
    console.log(device.label);

    modelBindGroupLayout = device.createBindGroupLayout({
        label: "model bind group layout",
        entries: [
            {
                // modelMat
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform" },
            },
        ],
    });

    materialBindGroupLayout = device.createBindGroupLayout({
        label: "material bind group layout",
        entries: [
            {
                // diffuseTex
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {},
            },
            {
                // diffuseTexSampler
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {},
            },
        ],
    });
}

export const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        {
            // pos
            format: "float32x3",
            offset: 0,
            shaderLocation: 0,
        },
        {
            // nor
            format: "float32x3",
            offset: 12,
            shaderLocation: 1,
        },
        {
            // uv
            format: "float32x2",
            offset: 24,
            shaderLocation: 2,
        },
    ],
};

export abstract class Renderer {
    protected scene: Scene;
    protected camera: Camera;

    protected stats: Stats;

    private prevTime: number = 0;
    private frameRequestId: number;

    protected querySet: GPUQuerySet;
    protected resolveBuffer: GPUBuffer;
    protected resultBuffer: GPUBuffer;

    protected gpuTime: number = 0;
    protected gpuTimes: Array<number>;
    protected gpuTimesCompute: Array<number>;
    protected gpuTimesRender: Array<number>;
    protected gpuTimesIndex: number = 0;
    protected gpuTimesSize: number = 100;

    // IMPORTANT: Edit these flags to log times on browser console
    private logTime = false;
    protected logSeparateTimes = true;

    constructor(stage: Stage) {
        this.scene = stage.scene;
        this.camera = stage.camera;
        this.stats = stage.stats;

        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));

        this.querySet = device.createQuerySet({
            type: "timestamp",
            count: 4,
        });
        this.resolveBuffer = device.createBuffer({
            size: this.querySet.count * 8,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this.resultBuffer = device.createBuffer({
            size: this.resolveBuffer.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this.gpuTimes = new Array<number>(this.gpuTimesSize);
        this.gpuTimesCompute = new Array<number>(this.gpuTimesSize);
        this.gpuTimesRender = new Array<number>(this.gpuTimesSize);

        canTimestamp = canTimestamp && this.logTime;
    }

    stop(): void {
        cancelAnimationFrame(this.frameRequestId);
    }

    protected abstract draw(): void;

    // the main rendering loop
    private onFrame(time: number) {
        if (this.prevTime == 0) {
            this.prevTime = time;
        }

        let deltaTime = time - this.prevTime;
        this.camera.onFrame(deltaTime);

        this.stats.begin();

        this.draw();

        this.stats.end();

        this.prevTime = time;
        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }
}
