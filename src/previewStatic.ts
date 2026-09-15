import type { ContentView } from './engine.js';
import { validationFailed } from './errors.js';

/**
 * Instant static render (issue #16, research §2): a pure schematic SVG over
 * the `ContentView` — no engine, no browser, <1s. Deliberately schematic
 * (dots + labels), not a faithful GDJS frame: it answers "what moved where"
 * right after a mutation, while the playable build answers "how it plays".
 */

export const STATIC_RENDER_DOT_LIMIT = 500;

export interface StaticRenderResult {
  sessionId: string;
  scene: string;
  width: number;
  height: number;
  objectCount: number;
  instanceCount: number;
  /** Instances beyond the dot limit (not drawn, still counted). */
  skipped: number;
  layers: string[];
  /** Minimal inline SVG thumbnail (pure, no engine, no browser). */
  svg: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Shared scene resolution: first layout by default, actionable refusal otherwise. */
export function resolveSceneName(view: ContentView, wanted?: string): string {
  if (view.scenes.length === 0) {
    throw validationFailed('No scenes in this project: create one with create_scene first.');
  }
  if (wanted === undefined) {
    const first = view.scenes[0]?.name;
    if (first === undefined) throw validationFailed('No scenes in this project: create one with create_scene first.');
    return first;
  }
  if (!view.scenes.some((scene) => scene.name === wanted)) {
    const known = view.scenes.map((scene) => scene.name).join(', ');
    throw validationFailed(`Unknown scene "${wanted}". Known scenes: ${known}.`);
  }
  return wanted;
}

/** Pure static render over the content view: no engine, no browser, <1s. */
export function renderSceneStaticView(
  sessionId: string,
  view: ContentView,
  options: { scene?: string | undefined; width: number; height: number },
): StaticRenderResult {
  const name = resolveSceneName(view, options.scene);
  const scene = view.scenes.find((candidate) => candidate.name === name);
  if (!scene) throw validationFailed(`Unknown scene "${options.scene}".`);
  // Raw coordinates: the SVG viewport clips out-of-bounds instances, so the
  // thumbnail stays faithful instead of wrapping them back onto the canvas.
  const dots = scene.instances
    .slice(0, STATIC_RENDER_DOT_LIMIT)
    .map((instance, index) => {
      const hue = (index * 47) % 360;
      return `<circle cx="${instance.x.toFixed(1)}" cy="${instance.y.toFixed(1)}" r="5" fill="hsl(${hue},70%,55%)"><title>${escapeXml(instance.object)}</title></circle>`;
    })
    .join('');
  const skipped = Math.max(0, scene.instances.length - STATIC_RENDER_DOT_LIMIT);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">` +
    `<rect width="100%" height="100%" fill="#101828"/>` +
    `<text x="12" y="24" fill="#fff" font-size="14">${escapeXml(scene.name)} (${scene.instances.length})</text>` +
    dots +
    `</svg>`;
  return {
    sessionId,
    scene: scene.name,
    width: options.width,
    height: options.height,
    objectCount: scene.objects.length,
    instanceCount: scene.instances.length,
    skipped,
    layers: [...scene.layers],
    svg,
  };
}
