import { Camera } from "../stage/camera";

import commonRaw from "./common.wgsl?raw";
import intersectionRaw from "./intersection.wgsl?raw";
import integratorRaw from "./integrator.wgsl?raw";
import samplerRaw from "./sampler.wgsl?raw";
import stylizerRaw from "./stylizer.wgsl?raw";

import naiveVertRaw from "./naive.vs.wgsl?raw";
import naiveFragRaw from "./naive.fs.wgsl?raw";

import clusteredDeferredFragRaw from "./clustered_deferred.fs.wgsl?raw";
import clusteredDeferredFullscreenVertRaw from "./clustered_deferred_fullscreen.vs.wgsl?raw";
import clusteredDeferredFullscreenFragRaw from "./clustered_deferred_fullscreen.fs.wgsl?raw";

import clusteringComputeRaw from "./clustering.cs.wgsl?raw";

import pathtracerVertRaw from "./pathtracer.vs.wgsl?raw";
import pathtracerFragRaw from "./pathtracer.fs.wgsl?raw";

import pathtracerComputeRaw from "./pathtracer.cs.wgsl?raw";

// CONSTANTS (for use in shaders)
// =================================

// Note that these are declared in a somewhat roundabout way because otherwise minification will drop variables
// that are unused in host side code.
export const constants = {
    bindGroup_scene: 0,
    bindGroup_model: 1,
    bindGroup_material: 2,
    bindGroup_deferred: 3,
    bindGroup_pathtracer: 1,
    bindGroup_geometry: 2,
    bindGroup_textures: 2,
    bindGroup_stream_compaction: 2,

    moveLightsWorkgroupSize: 128,
    maxNumLightsPerCluster: 1000,

    numClusterX: 16,
    numClusterY: 16,
    numClusterZ: 24,

    workgroupSizeX: 4,
    workgroupSizeY: 4,
    workgroupSizeZ: 8,

    lightRadius: 10,

    maxResolutionWidth: 1920,
    maxResolutionHeight: 1080,

    presentationFormat: "bgra8unorm",
};

// =================================

function evalShaderRaw(raw: string) {
    return eval("`" + raw.replaceAll("${", "${constants.") + "`");
}

const commonSrc: string = evalShaderRaw(commonRaw);
const intersectionSrc: string = evalShaderRaw(intersectionRaw);
const integratorSrc: string = evalShaderRaw(integratorRaw);
const samplerSrc: string = evalShaderRaw(samplerRaw);
const stylizerSrc: string = evalShaderRaw(stylizerRaw);

function processShaderRaw(raw: string) {
    return commonSrc + intersectionSrc + evalShaderRaw(raw);
}

function processShaderRawPT(raw: string) {
    return commonSrc + intersectionSrc + integratorSrc + samplerSrc + stylizerSrc + evalShaderRaw(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);

export const clusteringComputeSrc: string = processShaderRaw(clusteringComputeRaw);

export const pathtracerVertSrc: string = processShaderRaw(pathtracerVertRaw);
export const pathtracerFragSrc: string = processShaderRaw(pathtracerFragRaw);

export const pathtracerComputeSrc: string = processShaderRawPT(pathtracerComputeRaw);
