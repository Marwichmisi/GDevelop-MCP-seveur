import type { ContentView } from './contentView.js';

export interface DiffSection {
  added: string[];
  removed: string[];
  modified: string[];
}

export interface ContentDiff {
  empty: boolean;
  scenes: DiffSection;
  objects: DiffSection;
  instances: DiffSection;
  variables: DiffSection;
  groups: DiffSection;
  resources: DiffSection;
  events: DiffSection;
}

function blankSection(): DiffSection {
  return { added: [], removed: [], modified: [] };
}

/** Empreinte stable (JSON) utilisée pour comparer avant/après clé par clé. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function diffKeys(before: Map<string, string>, after: Map<string, string>): DiffSection {
  const section = blankSection();
  for (const key of after.keys()) {
    if (!before.has(key)) section.added.push(key);
    else if (before.get(key) !== after.get(key)) section.modified.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) section.removed.push(key);
  }
  section.added.sort();
  section.removed.sort();
  section.modified.sort();
  return section;
}

function collectSceneVariables(view: ContentView): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(view.globalVariables)) {
    out.set(`global/${name}`, fingerprint(value));
  }
  for (const scene of view.scenes) {
    for (const [name, value] of Object.entries(scene.variables)) {
      out.set(`scene/${scene.name}/${name}`, fingerprint(value));
    }
    for (const object of scene.objects) {
      for (const [name, value] of Object.entries(object.variables)) {
        out.set(`object/scene/${scene.name}/${object.name}/${name}`, fingerprint(value));
      }
    }
    for (const instance of scene.instances) {
      for (const [name, value] of Object.entries(instance.variables)) {
        out.set(`instance/${scene.name}/${instance.id}/${name}`, fingerprint(value));
      }
    }
  }
  for (const object of view.globalObjects) {
    for (const [name, value] of Object.entries(object.variables)) {
      out.set(`object/global/${object.name}/${name}`, fingerprint(value));
    }
  }
  return out;
}

/**
 * Diff semantique avant/apres sur ContentView (pur, sans moteur).
 */
export function diffContentView(before: ContentView, after: ContentView): ContentDiff {
  const scenes = diffKeys(
    new Map(before.scenes.map((s) => [s.name, s.name])),
    new Map(after.scenes.map((s) => [s.name, s.name])),
  );
  const beforeByName = new Map(before.scenes.map((s) => [s.name, s]));
  const afterByName = new Map(after.scenes.map((s) => [s.name, s]));
  for (const name of beforeByName.keys()) {
    if (!afterByName.has(name) || scenes.modified.includes(name)) continue;
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    if (b === undefined || a === undefined) continue;
    const sigB = fingerprint({ layers: b.layers, variables: b.variables, groups: b.groups, events: b.events });
    const sigA = fingerprint({ layers: a.layers, variables: a.variables, groups: a.groups, events: a.events });
    if (sigB !== sigA) {
      scenes.modified.push(name);
      scenes.modified.sort();
    }
  }
  const bo = new Map<string, string>();
  const ao = new Map<string, string>();
  for (const o of before.globalObjects) bo.set(`global/${o.name}`, fingerprint(o));
  for (const o of after.globalObjects) ao.set(`global/${o.name}`, fingerprint(o));
  for (const sc of before.scenes) for (const o of sc.objects) bo.set(`scene/${sc.name}/${o.name}`, fingerprint(o));
  for (const sc of after.scenes) for (const o of sc.objects) ao.set(`scene/${sc.name}/${o.name}`, fingerprint(o));
  const objects = diffKeys(bo, ao);
  const bi = new Map<string, string>();
  const ai = new Map<string, string>();
  for (const sc of before.scenes) for (const i of sc.instances) bi.set(`scene/${sc.name}/${i.id}`, fingerprint(i));
  for (const sc of after.scenes) for (const i of sc.instances) ai.set(`scene/${sc.name}/${i.id}`, fingerprint(i));
  const instances = diffKeys(bi, ai);
  const variables = diffKeys(collectSceneVariables(before), collectSceneVariables(after));
  const bg = new Map<string, string>();
  const ag = new Map<string, string>();
  for (const g of before.globalGroups) bg.set(`global/${g.name}`, fingerprint(g.objects));
  for (const g of after.globalGroups) ag.set(`global/${g.name}`, fingerprint(g.objects));
  for (const sc of before.scenes) for (const g of sc.groups) bg.set(`scene/${sc.name}/${g.name}`, fingerprint(g.objects));
  for (const sc of after.scenes) for (const g of sc.groups) ag.set(`scene/${sc.name}/${g.name}`, fingerprint(g.objects));
  const groups = diffKeys(bg, ag);
  const resources = diffKeys(
    new Map(before.resources.map((r) => [r.name, fingerprint(r)])),
    new Map(after.resources.map((r) => [r.name, fingerprint(r)])),
  );
  const be = new Map<string, string>();
  const ae = new Map<string, string>();
  const walkEvents = (into: Map<string, string>, prefix: string, nodes: ContentView['scenes'][number]['events']): void => {
    nodes.forEach((e, idx) => {
      into.set(`${prefix}/${idx}:${e.id || e.kind}`, fingerprint(e));
      if (e.events.length > 0) walkEvents(into, `${prefix}/${idx}:${e.id || e.kind}`, e.events);
    });
  };
  for (const sc of before.scenes) walkEvents(be, `scene/${sc.name}`, sc.events);
  for (const sc of after.scenes) walkEvents(ae, `scene/${sc.name}`, sc.events);
  const events = diffKeys(be, ae);
  const sections = [scenes, objects, instances, variables, groups, resources, events];
  const empty = sections.every((s) => s.added.length === 0 && s.removed.length === 0 && s.modified.length === 0);
  return { empty, scenes, objects, instances, variables, groups, resources, events };
}


