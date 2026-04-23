/**
 * Debug catalogue — economy overview (build costs, production I/O, Mermaid flowcharts).
 */

import { dataManager } from '@/data/DataManager';
import type { BuildingDefinition, ResourceType } from '@/types/GameData';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function resourceLabel(id: string): string {
  return dataManager.getResource(id as ResourceType)?.name ?? id;
}

function buildSectionToc(
  ariaLabel: string,
  items: readonly { id: string; label: string }[]
): HTMLElement {
  const nav = el('nav', 'catalog-section-toc');
  nav.setAttribute('aria-label', ariaLabel);
  for (const { id, label } of items) {
    const a = document.createElement('a');
    a.href = `#${id}`;
    a.textContent = label;
    nav.appendChild(a);
  }
  return nav;
}

function mermaidSafeLabel(s: string): string {
  return s.replace(/["#[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function rid(id: string): string {
  return `R_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function bid(b: BuildingDefinition): string {
  return `B_${b.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function formatCost(cost: Record<string, number> | undefined): string {
  if (!cost || Object.keys(cost).length === 0) return '—';
  return Object.entries(cost)
    .map(([k, v]) => `${resourceLabel(k)} ×${v}`)
    .join(', ');
}

function formatInputsAny(
  groups: Array<{ resourceTypes: ResourceType[]; amount: number }> | undefined
): string {
  if (!groups?.length) return '—';
  return groups
    .map(
      (g) =>
        `${g.amount} from (${g.resourceTypes.map((t) => resourceLabel(t)).join(' OR ')})`
    )
    .join('; ');
}

function buildPlacementMermaid(buildings: BuildingDefinition[]): string {
  const nodes = new Map<string, string>();
  const edges: string[] = [];
  for (const b of buildings) {
    const bId = bid(b);
    nodes.set(bId, b.name);
    for (const [resId, qty] of Object.entries(b.buildCost)) {
      const rId = rid(resId);
      nodes.set(rId, resourceLabel(resId));
      edges.push(`${rId} -->|"×${qty} place"| ${bId}`);
    }
  }
  const lines: string[] = ['flowchart LR'];
  for (const [id, lab] of nodes) {
    lines.push(`${id}["${mermaidSafeLabel(lab)}"]`);
  }
  lines.push(...edges);
  if (edges.length === 0) lines.push('empty((No build costs in data))');
  return lines.join('\n');
}

function buildProductionMermaid(buildings: BuildingDefinition[]): string {
  const nodes = new Map<string, string>();
  const edges: string[] = [];
  let edgeCount = 0;
  const maxEdges = 120;
  let truncated = false;

  outer: for (const b of buildings) {
    const p = b.production;
    if (!p) continue;
    const bId = bid(b);
    nodes.set(bId, b.name);
    const time = p.productionTime;
    const mode = p.continuous ? 'cont.' : 'once';

    for (const [resId, qty] of Object.entries(p.inputs ?? {})) {
      if (edgeCount >= maxEdges) {
        truncated = true;
        break outer;
      }
      const rId = rid(resId);
      nodes.set(rId, resourceLabel(resId));
      edges.push(`${rId} -->|"in ×${qty}"| ${bId}`);
      edgeCount++;
    }
    for (const [resId, qty] of Object.entries(p.outputs)) {
      if (edgeCount >= maxEdges) {
        truncated = true;
        break outer;
      }
      const rId = rid(resId);
      nodes.set(rId, resourceLabel(resId));
      edges.push(`${bId} -->|"+${qty} / ${time}s ${mode}"| ${rId}`);
      edgeCount++;
    }
  }

  const lines: string[] = ['flowchart LR'];
  for (const [id, lab] of nodes) {
    lines.push(`${id}["${mermaidSafeLabel(lab)}"]`);
  }
  lines.push(...edges);
  if (edges.length === 0) lines.push('empty((No recipe I/O in data))');
  if (truncated) lines.push('truncNote[["…truncated at 120 edges"]]');
  return lines.join('\n');
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  run: (opts?: { querySelector?: string }) => Promise<unknown>;
};

export function scheduleEconomyMermaid(): void {
  let attempts = 0;
  const maxAttempts = 100;
  const tryRun = (): void => {
    const m = (window as unknown as { mermaid?: MermaidApi }).mermaid;
    if (m) {
      try {
        m.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'loose',
          flowchart: { useMaxWidth: true, htmlLabels: true },
        });
        void m.run({ querySelector: '#section-economy pre.mermaid' }).catch(() => {});
      } catch {
        /* ignore chart failures */
      }
      return;
    }
    if (++attempts < maxAttempts) requestAnimationFrame(tryRun);
  };
  requestAnimationFrame(tryRun);
}

export function economySection(): HTMLElement {
  const wrap = el('div');
  wrap.id = 'section-economy';
  wrap.appendChild(el('h2', '', 'Economy'));

  wrap.appendChild(
    buildSectionToc('Jump within economy', [
      { id: 'economy-build-costs', label: 'Build costs' },
      { id: 'economy-production', label: 'Production I/O' },
      { id: 'economy-resource-index', label: 'Resource index' },
      { id: 'economy-flow-placement', label: 'Chart: placement' },
      { id: 'economy-flow-production', label: 'Chart: production' },
    ])
  );

  wrap.appendChild(
    el(
      'p',
      'economy-intro',
      'From buildings.json via DataManager. Quantities are per placement (build) or per production cycle (recipe). Gather buildings take inputs from the map (trees, rock, water) rather than stockpiles — those links are not drawn as resource→building edges below.'
    )
  );

  const buildings = [...dataManager.getAllBuildings()].sort((a, b) => a.name.localeCompare(b.name));
  const resources = [...dataManager.getAllResources()].sort((a, b) => a.name.localeCompare(b.name));

  const h1 = el('h3', '', 'Building placement costs');
  h1.id = 'economy-build-costs';
  wrap.appendChild(h1);
  {
    const tw = el('div', 'economy-table-wrap');
    const table = el('table', 'economy-table');
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', '', 'Building'));
    hr.appendChild(el('th', '', 'Cost (from HQ / stockpile)'));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el('tbody');
    for (const b of buildings) {
      const tr = el('tr');
      const td1 = el('td', '', b.name);
      const td2 = el('td', '', formatCost(b.buildCost));
      tr.appendChild(td1);
      tr.appendChild(td2);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    tw.appendChild(table);
    wrap.appendChild(tw);
  }

  const h2 = el('h3', '', 'Production I/O (recipes & cycles)');
  h2.id = 'economy-production';
  wrap.appendChild(h2);
  {
    const tw = el('div', 'economy-table-wrap');
    const table = el('table', 'economy-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const lab of [
      'Building',
      'Tool',
      'Recipe inputs',
      'OR-input groups',
      'Outputs',
      'Cycle (s)',
      'Mode',
    ]) {
      hr.appendChild(el('th', '', lab));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el('tbody');
    for (const b of buildings) {
      const tr = el('tr');
      const p = b.production;
      tr.appendChild(el('td', '', b.name));
      tr.appendChild(el('td', '', b.requiredTool ? resourceLabel(b.requiredTool) : '—'));
      tr.appendChild(el('td', '', p ? formatCost(p.inputs) : '—'));
      tr.appendChild(el('td', '', p ? formatInputsAny(p.inputsAny) : '—'));
      tr.appendChild(el('td', '', p ? formatCost(p.outputs) : '—'));
      tr.appendChild(el('td', '', p ? String(p.productionTime) : '—'));
      tr.appendChild(el('td', '', p ? (p.continuous ? 'continuous' : 'batch') : '—'));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    tw.appendChild(table);
    wrap.appendChild(tw);
  }

  type RInfo = { produced: string[]; recipeIn: string[]; build: string[]; tool: string[] };
  const rmap = new Map<string, RInfo>();
  for (const r of resources) {
    rmap.set(r.id, { produced: [], recipeIn: [], build: [], tool: [] });
  }
  for (const b of buildings) {
    for (const [resId, qty] of Object.entries(b.buildCost)) {
      const info = rmap.get(resId) ?? { produced: [], recipeIn: [], build: [], tool: [] };
      info.build.push(`${b.name} ×${qty}`);
      rmap.set(resId, info);
    }
    if (b.requiredTool) {
      const info = rmap.get(b.requiredTool) ?? { produced: [], recipeIn: [], build: [], tool: [] };
      info.tool.push(b.name);
      rmap.set(b.requiredTool, info);
    }
    const p = b.production;
    if (p) {
      for (const [resId, qty] of Object.entries(p.outputs)) {
        const info = rmap.get(resId) ?? { produced: [], recipeIn: [], build: [], tool: [] };
        info.produced.push(`${b.name} ×${qty}/cycle`);
        rmap.set(resId, info);
      }
      for (const [resId, qty] of Object.entries(p.inputs ?? {})) {
        const info = rmap.get(resId) ?? { produced: [], recipeIn: [], build: [], tool: [] };
        info.recipeIn.push(`${b.name} ×${qty}/cycle`);
        rmap.set(resId, info);
      }
    }
  }

  const h3 = el('h3', '', 'Resource index');
  h3.id = 'economy-resource-index';
  wrap.appendChild(h3);
  {
    const tw = el('div', 'economy-table-wrap');
    const table = el('table', 'economy-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const lab of ['Resource', 'Produced by', 'Recipe input at', 'Build cost for', 'Required tool at']) {
      hr.appendChild(el('th', '', lab));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tb = el('tbody');
    for (const r of resources) {
      const info = rmap.get(r.id) ?? { produced: [], recipeIn: [], build: [], tool: [] };
      const tr = el('tr');
      tr.appendChild(el('td', '', r.name));
      tr.appendChild(el('td', 'muted', info.produced.length ? info.produced.join('; ') : '—'));
      tr.appendChild(el('td', 'muted', info.recipeIn.length ? info.recipeIn.join('; ') : '—'));
      tr.appendChild(el('td', 'muted', info.build.length ? info.build.join('; ') : '—'));
      tr.appendChild(el('td', 'muted', info.tool.length ? info.tool.join('; ') : '—'));
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    tw.appendChild(table);
    wrap.appendChild(tw);
  }

  const h4 = el('h3', '', 'Flow: resources → buildings (placement)');
  h4.id = 'economy-flow-placement';
  wrap.appendChild(h4);
  const mw1 = el('div', 'mermaid-wrap');
  const pre1 = el('pre', 'mermaid');
  pre1.textContent = buildPlacementMermaid(buildings);
  mw1.appendChild(pre1);
  wrap.appendChild(mw1);

  const h5 = el('h3', '', 'Flow: recipes & outputs (stockpiled goods)');
  h5.id = 'economy-flow-production';
  wrap.appendChild(h5);
  const mw2 = el('div', 'mermaid-wrap');
  const pre2 = el('pre', 'mermaid');
  pre2.textContent = buildProductionMermaid(buildings);
  mw2.appendChild(pre2);
  wrap.appendChild(mw2);

  return wrap;
}
