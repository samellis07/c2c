/**
 * Workflow modeling for the React target. The machine the client
 * shows must be the machine the server enforces, so the spec is parsed out of
 * the generated flow modules (`export const machine = {...}` in
 * functions/flow/<slug>.mjs) rather than re-derived from the workflows. The
 * nav's `systemcomponent { type = approval }` entries — the Approvals section —
 * map to the two inbox views, pending and completed.
 */
import { unquote, type App, type Property } from '../../core/src/ir.js';
import type { FlowSpec, FlowTransitionSpec, NavItem } from '../template/lib/c2c-ui/types.js';
import { flowSpecs } from '../../deluge/src/generate.js';

/** A menu entry of a section (ComponentRef) or device menu (DeviceComponent). */
interface MenuEntry {
  kind: string;
  name: string;
  properties?: Property[];
}

interface MachineJson {
  kind?: unknown;
  name?: unknown;
  form?: unknown;
  statusColumn?: unknown;
  start?: unknown;
  stages?: unknown;
  transitions?: unknown;
  endpoints?: unknown;
}

const ACTIONS = new Set(['approve', 'reject', 'transition']);

/**
 * The machines of the generated bundle: one entry per `functions/flow/*.mjs`
 * module, in file order. The literal is a JSON.stringify(..., 2) value that
 * closes with `\n}` at column zero, which is what the matcher anchors on.
 */
export function machineFlows(files: readonly { path: string; data: string | Buffer }[], reportFor?: (form: string) => string | undefined): FlowSpec[] {
  const flows: FlowSpec[] = [];
  for (const file of files) {
    if (!/^functions\/flow\/[^/]+\.mjs$/.test(file.path)) continue;
    const source = typeof file.data === 'string' ? file.data : file.data.toString('utf8');
    const match = /\nexport const machine = (\{[\s\S]*?\n\});\n/.exec(`\n${source}`);
    if (!match) continue;
    let machine: MachineJson;
    try {
      machine = JSON.parse(match[1]!) as MachineJson;
    } catch {
      continue;
    }
    const kind = machine.kind === 'approval' || machine.kind === 'blueprint' ? machine.kind : undefined;
    const name = typeof machine.name === 'string' ? machine.name : '';
    const form = typeof machine.form === 'string' ? machine.form : '';
    const statusColumn = typeof machine.statusColumn === 'string' ? machine.statusColumn : '';
    const start = typeof machine.start === 'string' ? machine.start : '';
    const endpoints = machine.endpoints as Record<string, unknown> | undefined;
    const approve = typeof endpoints?.approve === 'string' ? endpoints.approve : '';
    const reject = typeof endpoints?.reject === 'string' ? endpoints.reject : '';
    const transition = typeof endpoints?.transition === 'string' ? endpoints.transition : '';
    if (!kind || !name || !form || !statusColumn || !approve || !reject || !transition) continue;
    const transitions: FlowTransitionSpec[] = [];
    for (const row of Array.isArray(machine.transitions) ? machine.transitions : []) {
      if (!row || typeof row !== 'object') continue;
      const t = row as Record<string, unknown>;
      if (typeof t.name !== 'string' || typeof t.action !== 'string' || typeof t.from !== 'string' || typeof t.to !== 'string') continue;
      if (!ACTIONS.has(t.action)) continue;
      transitions.push({ name: t.name, action: t.action as FlowTransitionSpec['action'], from: t.from, to: t.to });
    }
    const stages: string[] = [];
    const push = (stage: string) => {
      if (stage && !stages.includes(stage)) stages.push(stage);
    };
    for (const stage of Array.isArray(machine.stages) ? machine.stages : []) if (typeof stage === 'string') push(stage);
    push(start);
    for (const t of transitions) push(t.from);
    // Terminal stages the transitions land on, success before rejection, so the
    // stepper reads Pending … Approved, Rejected for approvals.
    const open = new Set(transitions.map((t) => t.from));
    const ends = transitions.map((t) => t.to).filter((to) => !open.has(to) && !stages.includes(to));
    for (const to of ends.filter((to) => !/reject/i.test(to))) push(to);
    for (const to of ends.filter((to) => /reject/i.test(to))) push(to);
    const report = reportFor?.(form);
    flows.push({
      kind,
      name,
      label: name.replace(/_+/g, ' ').trim() || name,
      form,
      statusColumn,
      start,
      stages,
      transitions,
      endpoints: { approve, reject, transition },
      ...(report ? { report } : {}),
    });
  }
  return flows;
}

/**
 * The nav source sections, in the same order `navigation()` maps them into
 * model.nav. A systemcomponent entry of `app.sections` carries no properties —
 * its `approval status`/`displayname` live on the device-section component of
 * the same name and index, so those are resolved for the lookup.
 */
function rawNavSections(app: App): { components: MenuEntry[] }[] {
  if (app.sections.length) {
    const deviceComponents = new Map<string, MenuEntry[]>();
    for (const device of app.devices) {
      for (const section of device.sections) {
        if (!deviceComponents.has(section.name)) deviceComponents.set(section.name, section.components);
      }
    }
    return app.sections.map((section) => ({
      components: section.components.map((component, index) =>
        component.kind === 'systemcomponent' && !component.properties?.length
          ? (deviceComponents.get(section.name)?.[index] ?? component)
          : component,
      ),
    }));
  }
  const web = app.devices.find((device) => device.device === 'web');
  return web?.sections ?? [];
}

function prop(properties: Property[] | undefined, key: string): string | undefined {
  const found = (properties ?? []).find((p) => p.key.toLowerCase() === key);
  const value = found ? unquote(found.value).trim() : '';
  return value ? value : undefined;
}

/** The route names of the two inbox views; `flow/approvals` and `flow/approvals/completed`. */
export const INBOX_ROUTES = { pending: 'approvals', completed: 'approvals/completed' } as const;

/**
 * The flow nav item a `systemcomponent { type = approval }` menu entry maps to,
 * or undefined. `approval status = completed` names the completed view; every
 * other value is the pending inbox.
 */
export function approvalNavItem(component: MenuEntry | undefined): NavItem | undefined {
  if (!component || component.kind !== 'systemcomponent' || component.name !== 'approval') return undefined;
  const completed = (prop(component.properties, 'approval status') ?? '').toLowerCase() === 'completed';
  const label = prop(component.properties, 'displayname');
  return completed
    ? { kind: 'flow', name: INBOX_ROUTES.completed, label: label ?? 'Completed tasks', href: `#/flow/${INBOX_ROUTES.completed}` }
    : { kind: 'flow', name: INBOX_ROUTES.pending, label: label ?? 'Pending tasks', href: `#/flow/${INBOX_ROUTES.pending}` };
}

/**
 * For reactAppSpec's nav walk: maps model.nav's items back onto the raw
 * menu components (same order, hidden sections included). Returns the approval
 * item for systemcomponent entries so the caller can swap them for flow links.
 */
export function approvalComponentAt(app: App, sectionIndex: number, itemIndex: number): MenuEntry | undefined {
  return rawNavSections(app)[sectionIndex]?.components[itemIndex];
}

/** The fallback Approvals section when the menu declares none but approval machines exist. */
export function approvalsSection(): NavItem[] {
  return [
    { kind: 'flow', name: INBOX_ROUTES.pending, label: 'Pending tasks', href: `#/flow/${INBOX_ROUTES.pending}` },
    { kind: 'flow', name: INBOX_ROUTES.completed, label: 'Completed tasks', href: `#/flow/${INBOX_ROUTES.completed}` },
  ];
}

/** True when the app's workflows produce at least one approval machine (drives the fallback section). */
export function hasApprovalFlows(app: App): boolean {
  return flowSpecs(app).some((spec) => spec.kind === 'approval');
}
