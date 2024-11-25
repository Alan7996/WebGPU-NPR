struct Uniforms {
    gridWidth: u32
}

@group(0) @binding(3) var<uniform> uniforms: Uniforms;

const gravity: vec3<f32> = vec3<f32>(0.0, -9.81, 0.0);
const timeStep: f32 = 0.016; // Assuming 60 FPS
const damping: f32 = 0.99;

@group(0) @binding(0) var<storage, read_write> positions: array<vec3<f32>>;
@group(0) @binding(1) var<storage, read_write> previousPositions: array<vec3<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec3<f32>>;

@compute @workgroup_size(256)
fn simulateCloth(@builtin(global_invocation_id) GlobalInvocationID: vec3<u32>) {
    let idx: u32 = GlobalInvocationID.x;
    if (idx >= arrayLength(&positions)) {
        return;
    }

    // Verlet Integration
    let currentPosition = positions[idx];
    let previousPosition = previousPositions[idx];
    var velocity = velocities[idx];

    // Apply gravity
    velocity += gravity * timeStep;

    // Damping
    velocity *= damping;

    // Update positions
    let newPosition = currentPosition + velocity * timeStep;

    previousPositions[idx] = currentPosition;
    positions[idx] = newPosition;
    velocities[idx] = velocity;

    // Constraints (pin top row)
    if (idx < uniforms.gridWidth) {
        positions[idx] = currentPosition; // Pin the top row
        velocities[idx] = vec3<f32>(0.0, 0.0, 0.0);
    }
}
