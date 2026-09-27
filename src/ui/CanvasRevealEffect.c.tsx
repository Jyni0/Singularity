/**
 * Canvas Reveal Effect — a WebGL dot matrix that "reveals" from the centre
 * and then twinkles. Adapted from Aceternity UI
 * (`npx shadcn@latest add @aceternity/canvas-reveal-effect-demo-2`):
 *  - no shadcn `cn` helper / path aliases (this project has neither);
 *  - `totalSize` exposed and the default dots much bigger;
 *  - uniforms feed the material, so a colour change applies live;
 *  - transparent background — the chat shows through between the dots.
 *
 * Heavy (three.js) — import it lazily; see GenerationGlow.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import React, { useMemo, useRef } from "react";
import * as THREE from "three";

export const CanvasRevealEffect = ({
  animationSpeed = 0.4,
  opacities = [0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1],
  colors = [[0, 255, 255]],
  containerClassName = "",
  dotSize = 12,
  totalSize = 20,
}: {
  /** 0.1 slower … 1.0 faster reveal. */
  animationSpeed?: number;
  opacities?: number[];
  colors?: number[][];
  containerClassName?: string;
  /** Size of one square, in canvas units (2 per CSS pixel). */
  dotSize?: number;
  /** Grid pitch: square + gap. */
  totalSize?: number;
}) => {
  return (
    <div className={`relative h-full w-full ${containerClassName}`}>
      <DotMatrix
        colors={colors}
        dotSize={dotSize}
        totalSize={totalSize}
        opacities={opacities}
        shader={`
            float animation_speed_factor = ${animationSpeed.toFixed(1)};
            float intro_offset = distance(u_resolution / 2.0 / u_total_size, st2) * 0.01 + (random(st2) * 0.15);
            opacity *= step(intro_offset, u_time * animation_speed_factor);
            opacity *= clamp((1.0 - step(intro_offset + 0.1, u_time * animation_speed_factor)) * 1.25, 1.0, 1.25);
          `}
        center={["x", "y"]}
      />
    </div>
  );
};

interface DotMatrixProps {
  colors: number[][];
  opacities: number[];
  totalSize: number;
  dotSize: number;
  shader: string;
  center: ("x" | "y")[];
}

type Uniforms = Record<string, { value: number[] | number[][] | number; type: string }>;

const DotMatrix: React.FC<DotMatrixProps> = ({ colors, opacities, totalSize, dotSize, shader, center }) => {
  const uniforms = useMemo<Uniforms>(() => {
    let colorsArray = [colors[0], colors[0], colors[0], colors[0], colors[0], colors[0]];
    if (colors.length === 2) {
      colorsArray = [colors[0], colors[0], colors[0], colors[1], colors[1], colors[1]];
    } else if (colors.length === 3) {
      colorsArray = [colors[0], colors[0], colors[1], colors[1], colors[2], colors[2]];
    }
    return {
      u_colors: { value: colorsArray.map((c) => [c[0] / 255, c[1] / 255, c[2] / 255]), type: "uniform3fv" },
      u_opacities: { value: opacities, type: "uniform1fv" },
      u_total_size: { value: totalSize, type: "uniform1f" },
      u_dot_size: { value: dotSize, type: "uniform1f" },
    };
  }, [colors, opacities, totalSize, dotSize]);

  return (
    <Shader
      source={`
        precision mediump float;
        in vec2 fragCoord;

        uniform float u_time;
        uniform float u_opacities[10];
        uniform vec3 u_colors[6];
        uniform float u_total_size;
        uniform float u_dot_size;
        uniform vec2 u_resolution;
        out vec4 fragColor;
        float PHI = 1.61803398874989484820459;
        float random(vec2 xy) {
            return fract(tan(distance(xy * PHI, xy) * 0.5) * xy.x);
        }
        void main() {
            vec2 st = fragCoord.xy;
            ${center.includes("x") ? "st.x -= abs(floor((mod(u_resolution.x, u_total_size) - u_dot_size) * 0.5));" : ""}
            ${center.includes("y") ? "st.y -= abs(floor((mod(u_resolution.y, u_total_size) - u_dot_size) * 0.5));" : ""}
            float opacity = step(0.0, st.x);
            opacity *= step(0.0, st.y);

            vec2 st2 = vec2(int(st.x / u_total_size), int(st.y / u_total_size));

            float frequency = 5.0;
            float show_offset = random(st2);
            float rand = random(st2 * floor((u_time / frequency) + show_offset + frequency) + 1.0);
            opacity *= u_opacities[int(rand * 10.0)];
            // Rounded squares: signed distance to a rounded box inside each
            // grid cell (radius ~30% of the square), 1px soft edge.
            vec2 cell = mod(st, u_total_size) - vec2(u_dot_size * 0.5);
            float radius = u_dot_size * 0.3;
            vec2 q = abs(cell) - vec2(u_dot_size * 0.5 - radius);
            float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
            opacity *= 1.0 - smoothstep(-0.5, 0.5, d);

            vec3 color = u_colors[int(show_offset * 6.0)];

            ${shader}

            fragColor = vec4(color, opacity);
            fragColor.rgb *= fragColor.a;
        }`}
      uniforms={uniforms}
      maxFps={60}
    />
  );
};

function prepareUniforms(uniforms: Uniforms, width: number, height: number) {
  const out: Record<string, { value: unknown }> = {};
  for (const [name, u] of Object.entries(uniforms)) {
    switch (u.type) {
      case "uniform1f":
      case "uniform1fv":
        out[name] = { value: u.value };
        break;
      case "uniform3fv":
        out[name] = { value: (u.value as number[][]).map((v) => new THREE.Vector3().fromArray(v)) };
        break;
      default:
        console.error(`Invalid uniform type for '${name}'.`);
    }
  }
  out.u_time = { value: 0 };
  out.u_resolution = { value: new THREE.Vector2(width * 2, height * 2) };
  return out;
}

const ShaderMaterial = ({ source, uniforms, maxFps = 60 }: { source: string; uniforms: Uniforms; maxFps?: number }) => {
  const { size } = useThree();
  const ref = useRef<THREE.Mesh>(null);
  const lastFrame = useRef(0);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    if (t - lastFrame.current < 1 / maxFps) return;
    lastFrame.current = t;
    (ref.current.material as THREE.ShaderMaterial).uniforms.u_time.value = t;
  });

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: `
          precision mediump float;
          uniform vec2 u_resolution;
          out vec2 fragCoord;
          void main(){
            gl_Position = vec4(position.x, position.y, 0.0, 1.0);
            fragCoord = (position.xy + vec2(1.0)) * 0.5 * u_resolution;
            fragCoord.y = u_resolution.y - fragCoord.y;
          }
        `,
        fragmentShader: source,
        uniforms: prepareUniforms(uniforms, size.width, size.height),
        glslVersion: THREE.GLSL3,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneFactor,
        transparent: true,
      }),
    [size.width, size.height, source, uniforms]
  );

  return (
    <mesh ref={ref}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
};

const Shader = ({ source, uniforms, maxFps = 60 }: { source: string; uniforms: Uniforms; maxFps?: number }) => (
  <Canvas className="absolute inset-0 h-full w-full" gl={{ alpha: true, antialias: false }}>
    <ShaderMaterial source={source} uniforms={uniforms} maxFps={maxFps} />
  </Canvas>
);

export default CanvasRevealEffect;
