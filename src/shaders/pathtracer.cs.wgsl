@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;

@group(${bindGroup_pathtracer}) @binding(0) var outputTex : texture_storage_2d<rgba8unorm, write>;
@group(${bindGroup_pathtracer}) @binding(1) var inputTex : texture_2d<f32>;
@group(${bindGroup_pathtracer}) @binding(2) var<storage, read_write> pathSegments : PathSegments;
@group(${bindGroup_pathtracer}) @binding(3) var<storage, read_write> intersections : Intersections;

@group(${bindGroup_geometry}) @binding(0) var<storage, read> vertices : Vertices;
@group(${bindGroup_geometry}) @binding(1) var<storage, read> tris : Triangles;
@group(${bindGroup_geometry}) @binding(2) var<storage, read> geoms : Geoms;
@group(${bindGroup_geometry}) @binding(3) var<storage, read> bvhNodes : BVHNodes;

@group(${bindGroup_textures}) @binding(0) var<storage, read> materials : array<Material>;
// TextureDescriptor contains offset into texture buffer, and dimensions
@group(${bindGroup_textures}) @binding(1) var<storage, read> textureDescriptors: array<TextureDescriptor>;
// Texture buffer contains textures from all meshes, appended end to end
@group(${bindGroup_textures}) @binding(2) var<storage, read> textures: Textures;

// First add the new bindings for stream compaction
@group(${bindGroup_stream_compaction}) @binding(0) var<storage, read_write> activePaths: array<u32>;
@group(${bindGroup_stream_compaction}) @binding(1) var<storage, read_write> compactedPaths: array<u32>;
@group(${bindGroup_stream_compaction}) @binding(2) var<storage, read_write> prefixSum: array<u32>;
@group(${bindGroup_stream_compaction}) @binding(3) var<storage, read_write> blockSums: array<u32>;
@group(${bindGroup_stream_compaction}) @binding(4) var<storage, read_write> carry: array<u32>;


@compute
@workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn generateRay(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {

        let gIdx = shiftIndex(globalIdx, cameraUniforms.counter);
        init_rand(gIdx, cameraUniforms.seed);

        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));

        let segment = &pathSegments.segments[index];

        // Antialiasing: jitter rays by [0,1] to generate uniformly random direction distribution per pixel
        let jitter = vec2(rand(), rand());
        segment.ray.direction = normalize(cameraUniforms.front
            - cameraUniforms.right * f32(cameraUniforms.pixelLength[0]) * (f32(globalIdx.x) - 0.5 + jitter[0] - f32(cameraUniforms.resolution[0]) * 0.5)
            - cameraUniforms.up * f32(cameraUniforms.pixelLength[1]) * (f32(globalIdx.y) - 0.5 + jitter[1] - f32(cameraUniforms.resolution[1]) * 0.5)
        );

        // Depth of Field, construct a new direction pointing the same direction but from new origin AND at focal length away
        let apertureOrigin = vec3(0.0); // cameraUniforms.apertureSize * randomOnUnitCircle(rng);
        segment.ray.origin = cameraUniforms.cameraPos + cameraUniforms.right * apertureOrigin[0] + cameraUniforms.up * apertureOrigin[1];
        // segment.ray.direction = normalize(segment.ray.direction * cameraUniforms.focalLength + cameraUniforms.position - segment.ray.origin);

        segment.color = vec3f(1.0);
        segment.pixelIndex = i32(index);
        segment.remainingBounces = i32(cameraUniforms.depth);
        segment.pathPrefix = 0;
        segment.appliedStyleType = 0;
    }
}

@compute
@workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn computeIntersections(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {

        let gIdx = shiftIndex(globalIdx, cameraUniforms.counter);
        init_rand(gIdx, cameraUniforms.seed);

        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));

        let pathSegment = &pathSegments.segments[index];

        var closestHit : HitInfo;
        var tempHit : HitInfo;
        var tMin = 10000000000.0; // arbitrary high number for max float
        var hitGeomIndex = -1;

        // naive parse through global geoms
        for (var i = 0; i < i32(geoms.geomsSize); i++)
        {
            let geom = &geoms.geoms[i];

            if (geom.geomType == 0)
            {
                tempHit = boxIntersectionTest(geom, pathSegment.ray);
            }
            else if (geom.geomType == 1)
            {
                tempHit = sphereIntersectionTest(geom, pathSegment.ray);
            }
            else if (geom.geomType == 2)
            {
                tempHit = meshIntersectionTest(geom, &vertices, &tris, &bvhNodes, pathSegment.ray);
            }

            // Compute the minimum t from the intersection tests to determine what
            // scene geometry object was hit first.
            if (tempHit.dist > 0.0 && tMin > tempHit.dist)
            {
                tMin = tempHit.dist;
                closestHit = tempHit;
                hitGeomIndex = i;
            }
        }

        if (hitGeomIndex == -1)
        {
            intersections.intersections[index].t = -1.0;
            intersections.intersections[index].materialId = -1;
        }
        else
        {
            // The ray hits something
            intersections.intersections[index].t = closestHit.dist;
            intersections.intersections[index].materialId = closestHit.materialId;
            intersections.intersections[index].objectId = geoms.geoms[hitGeomIndex].objectId;
            intersections.intersections[index].surfaceNormal = closestHit.normal;
            intersections.intersections[index].uv = closestHit.uv;
        }
    }
}

fn scatterRay(index: u32) {
    let pathSegment = &pathSegments.segments[index];
    let intersect = &intersections.intersections[index];

    if (intersect.t < 0.0) {
        // let color = vec3f(sampleEnvironmentMap(bgTextureInfo, pathSegment.ray.direction, textures));
        let color = vec3f(0.0);
        pathSegment.color *= color;
        pathSegment.remainingBounces = -2;
        return;
    }

    let matId: u32 = bitcast<u32>(intersect.materialId);
    let material = &materials[matId];

    var scattered : PathSegment;
    var bsdf : vec3f;
    var pdf : f32;
    var attenuation : vec3f;

    // hopefully we can template if we have time later on
    let dirIn = normalize(-pathSegment.ray.direction);

    let hitPoint = pathSegment.ray.origin + normalize(pathSegment.ray.direction) * intersect.t;
    let normal = intersect.surfaceNormal;
    let uv = intersect.uv;

    var baseColor = material.baseColorFactor.rgb;
    if (material.baseColorTextureIndex >= 0) {
        let texDesc = textureDescriptors[material.baseColorTextureIndex];
        baseColor *= textureLookup(texDesc, uv.x, uv.y, &textures);
    }

    if (material.matType == 0) { // Emissive
        var emissiveColor = material.emissiveFactor.rgb;
        var emissiveFactor = vec3f(1.0);
        if (material.emissiveTextureIndex >= 0) {
            let texDesc = textureDescriptors[material.emissiveTextureIndex];
            emissiveFactor = textureLookup(texDesc, uv.x, uv.y, &textures);
        }
        bsdf = emissiveColor * emissiveFactor;
        // bsdf = evalEmissive(dirIn, pathSegment.ray.direction, intersect.surfaceNormal, emissiveColor, emissiveFactor); // TODO: Fix

        attenuation = bsdf;

        pathSegment.remainingBounces = -1;
        pathSegment.color *= attenuation;
        return;
    } else if (material.matType == 1) { // Lambertian
        scattered = scatterLambertian(index, hitPoint, dirIn, normal);
        bsdf = evalLambertian(dirIn, scattered.ray.direction, normal, baseColor);
        pdf = pdfLambertian(dirIn, scattered.ray.direction, normal);

        if (pdf == 0.0) {
            attenuation = vec3f(1.0);
            pathSegment.color = baseColor;
        } else {
            attenuation = bsdf / pdf;
        }
    } else if (material.matType == 2) { // Metal
        scattered = scatterMetal(index, hitPoint, dirIn, normal, material.roughnessFactor);
        // bsdf = evalMetal(dirIn, scattered.ray.direction, normal, baseColor, material.metallicFactor); // TODO: add metallic
        bsdf = evalMetal(dirIn, scattered.ray.direction, normal, baseColor);

        attenuation = bsdf;
    }
    pathSegment.ray.origin = scattered.ray.origin;
    pathSegment.ray.direction = scattered.ray.direction;
    pathSegment.remainingBounces--;

    if (scattered.pixelIndex == -1) {
        pathSegment.color = vec3f(0.0);
        pathSegment.remainingBounces = -1;
        return;
    }
    
    // materialId, objectId, path prefix, 
    // params : vec4<f32>,
    // position : vec3<f32>,
    // normal : vec3<f32>,
    var sc : StyleContext;
    sc.params = vec4i(i32(intersect.materialId), intersect.objectId, pathSegment.pathPrefix, pathSegment.appliedStyleType);
    sc.position = scattered.ray.origin;
    sc.normal = intersect.surfaceNormal;

    attenuation = stylize(sc, attenuation);

    pathSegment.color *= attenuation;

    if (pathSegment.remainingBounces < 0 && material.matType != 0) {
        // did not reach a light till max depth, terminate path as invalid
        pathSegment.color = vec3f(0.0);
    }

    // store path prefix for next iteration
    pathSegment.pathPrefix = intersect.objectId;
    pathSegment.appliedStyleType = i32(material.styleType);
}

@compute
@workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn integrate(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {
        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));

        let pathSegment = &pathSegments.segments[index];

        if (pathSegment.remainingBounces >= 0) {
            let gIdx = shiftIndex(globalIdx, cameraUniforms.counter);
            init_rand(gIdx, cameraUniforms.seed);

            scatterRay(index);
        }
    }
}

@compute
@workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn finalGather(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {
        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));
        let pathSegment = &pathSegments.segments[index];

        let accumulated = textureLoad(inputTex, globalIdx.xy, 0).xyz;
        let resultColor = vec4((pathSegment.color + accumulated * f32(cameraUniforms.numFrames)) / f32(cameraUniforms.numFrames + 1), 1);
        textureStore(outputTex, globalIdx.xy, resultColor);
    }
}

@compute
@workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn clearTexture(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {
        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));

        textureStore(outputTex, globalIdx.xy, vec4(0.0));
    }
}

@id(0) override SCAN_BLOCK_SIZE: u32 = 512;

// Mark paths that should continue (have remaining bounces)
@compute @workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn markActivePaths(@builtin(global_invocation_id) globalIdx: vec3u) {
    if (globalIdx.x < u32(cameraUniforms.resolution[0]) && globalIdx.y < u32(cameraUniforms.resolution[1])) {
        let index = globalIdx.x + (globalIdx.y * u32(cameraUniforms.resolution[0]));
        let pathSegment = &pathSegments.segments[index];
        if (index % 2 == 0) {
            pathSegment.remainingBounces = i32(1);
        } else {
            pathSegment.remainingBounces = i32(-1);
        }

        // Just mark paths as active/inactive based on remaining bounces
        if (pathSegment.remainingBounces <= -1) {
            activePaths[index] = 0u;
        } else {
            activePaths[index] = 1u;
        }
    }
}
var<workgroup> chunk: array<u32, SCAN_BLOCK_SIZE>;

@compute @workgroup_size(SCAN_BLOCK_SIZE / 2)
fn prefixSumFn(
    @builtin(global_invocation_id) globalId: vec3<u32>,
    @builtin(local_invocation_id) localId: vec3<u32>,
    @builtin(workgroup_id) groupId: vec3<u32>
) {
    // Load from activePaths into workgroup memory
    chunk[2 * localId.x] = activePaths[2 * globalId.x];
    chunk[2 * localId.x + 1] = activePaths[2 * globalId.x + 1];

    var offset = 1u;
    // Reduce step up tree
    for (var d = SCAN_BLOCK_SIZE >> 1; d > 0; d = d >> 1) {
        workgroupBarrier();
        if (localId.x < d) {
            let ai = offset * (2u * localId.x + 1u) - 1u;
            let bi = offset * (2u * localId.x + 2u) - 1u;
            chunk[bi] += chunk[ai];
        }
        offset = offset << 1;
    }

    // Store block sum and clear last element
    if (localId.x == 0u) {
        blockSums[groupId.x] = chunk[SCAN_BLOCK_SIZE - 1];
        chunk[SCAN_BLOCK_SIZE - 1] = 0u;
    }

    // Down-sweep phase
    for (var d = 1u; d < SCAN_BLOCK_SIZE; d = d << 1) {
        offset = offset >> 1;
        workgroupBarrier();
        if (localId.x < d) {
            let ai = offset * (2u * localId.x + 1u) - 1u;
            let bi = offset * (2u * localId.x + 2u) - 1u;
            let t = chunk[ai];
            chunk[ai] = chunk[bi];
            chunk[bi] += t;
        }
    }

    workgroupBarrier();
    // Store results in prefixSum buffer
    prefixSum[2 * globalId.x] = chunk[2 * localId.x];
    prefixSum[2 * globalId.x + 1] = chunk[2 * localId.x + 1];
}

// Process block sums with carry
@compute @workgroup_size(SCAN_BLOCK_SIZE / 2)
fn prefixSumBlocks(
    @builtin(global_invocation_id) globalId: vec3<u32>,
    @builtin(local_invocation_id) localId: vec3<u32>,
    @builtin(workgroup_id) groupId: vec3<u32>
) {
    // Load from blockSums into workgroup memory
    chunk[2 * localId.x] = blockSums[2 * globalId.x];
    chunk[2 * localId.x + 1] = blockSums[2 * globalId.x + 1];

    var offset = 1u;
    // Up-sweep phase
    for (var d = SCAN_BLOCK_SIZE >> 1; d > 0; d = d >> 1) {
        workgroupBarrier();
        if (localId.x < d) {
            let ai = offset * (2u * localId.x + 1u) - 1u;
            let bi = offset * (2u * localId.x + 2u) - 1u;
            chunk[bi] += chunk[ai];
        }
        offset = offset << 1;
    }

    // Update carry
    if (localId.x == 0u) {
        carry[1] = chunk[SCAN_BLOCK_SIZE - 1] + carry[0];
        chunk[SCAN_BLOCK_SIZE - 1] = 0u;
    }

    // Down-sweep phase
    for (var d = 1u; d < SCAN_BLOCK_SIZE; d = d << 1) {
        offset = offset >> 1;
        workgroupBarrier();
        if (localId.x < d) {
            let ai = offset * (2u * localId.x + 1u) - 1u;
            let bi = offset * (2u * localId.x + 2u) - 1u;
            let t = chunk[ai];
            chunk[ai] = chunk[bi];
            chunk[bi] += t;
        }
    }

    workgroupBarrier();
    // Store results back into blockSums
    blockSums[2 * globalId.x] = chunk[2 * localId.x] + carry[0];
    blockSums[2 * globalId.x + 1] = chunk[2 * localId.x + 1] + carry[0];
}

@compute @workgroup_size(SCAN_BLOCK_SIZE / 2)
fn addBlockSums(
    @builtin(global_invocation_id) globalId: vec3<u32>,
    @builtin(workgroup_id) groupId: vec3<u32>
) {
    // First, calculate the actual index in our data
    let index = globalId.x + (globalId.y * u32(cameraUniforms.resolution[0]));
    
    // Calculate which block this index belongs to
    let blockIndex = index / SCAN_BLOCK_SIZE;
    // Get this block's sum from the previous scan
    let blockSum = blockSums[blockIndex];
    
    // Add block sum of all previous blocks to this element's prefix sum
    if (index < u32(cameraUniforms.resolution[0]) * u32(cameraUniforms.resolution[1])) {
        prefixSum[index] = prefixSum[index] + blockSum;
    }
}


@compute @workgroup_size(${workgroupSizeX}, ${workgroupSizeY})
fn streamCompaction(@builtin(global_invocation_id) globalId: vec3u) {
    let idx = globalId.x;
    if (idx < streamCompactionParams.totalElements) {
        if (activePaths[idx] != 0u) {
            compactedPaths[prefixSum[idx]] = idx;
        }
    }
}