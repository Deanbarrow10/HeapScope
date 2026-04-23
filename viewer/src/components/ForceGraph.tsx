import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { FilterKey, LeakReport, LeakNode } from '../types';

interface Props {
  data: LeakReport;
  filter: FilterKey;
  zone: string | null;
  search: string;
  focusCycle: number | null;   // index into data.cycles — bump to re-focus
  focusNonce: number;          // increments to force a re-focus even if same cycle
}

interface SimNode extends LeakNode {
  index: number;
  r: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}
interface SimLink {
  source: number | SimNode;
  target: number | SimNode;
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export default function ForceGraph({ data, filter, zone, search, focusCycle, focusNonce }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Imperative graph state across renders.
  const stateRef = useRef<{
    nodes: SimNode[];
    links: SimLink[];
    idToIdx: Map<string, number>;
    byZone: Map<string, number[]>;
    adjOut: number[][];
    adjIn:  number[][];
    sim: d3.Simulation<SimNode, undefined> | null;
    nodeSel: d3.Selection<SVGCircleElement, SimNode, SVGGElement, unknown> | null;
    linkSel: d3.Selection<SVGPathElement, SimLink, SVGGElement, unknown> | null;
    rootG: d3.Selection<SVGGElement, unknown, null, undefined> | null;
    zoom: d3.ZoomBehavior<SVGSVGElement, unknown> | null;
    pulseG: SVGGElement | null;
    viewW: number;
    viewH: number;
  }>({
    nodes: [], links: [], idToIdx: new Map(), byZone: new Map(),
    adjOut: [], adjIn: [], sim: null, nodeSel: null, linkSel: null,
    rootG: null, zoom: null, pulseG: null, viewW: 1000, viewH: 620,
  });

  const [selected, setSelected] = useState<number | null>(null);

  // Build the graph once per new dataset.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    // <defs> — arrow markers + glow filter.
    const defs = svg.append('defs');
    const markerDef = (id: string, fill: string) => {
      defs.append('marker')
        .attr('id', id)
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', fill);
    };
    markerDef('arr-reach', 'rgba(122,143,240,0.6)');
    markerDef('arr-leak',  'rgba(255,101,116,0.7)');
    markerDef('arr-cycle', 'rgba(192,132,255,0.9)');

    const glowFilter = defs.append('filter')
      .attr('id', 'node-glow')
      .attr('x', '-50%').attr('y', '-50%')
      .attr('width', '200%').attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', 2.2).attr('result', 'b');
    const merge = glowFilter.append('feMerge');
    merge.append('feMergeNode').attr('in', 'b');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');

    const W = 1000, H = 620;
    stateRef.current.viewW = W;
    stateRef.current.viewH = H;

    const idToIdx = new Map<string, number>();
    data.nodes.forEach((n, i) => idToIdx.set(n.id, i));

    const nodes: SimNode[] = data.nodes.map((n, i) => ({
      ...n,
      index: i,
      r: Math.max(4, Math.min(22, 3 + Math.log2(Math.max(2, n.size)))),
    }));
    const links: SimLink[] = (data.edges || [])
      .filter(e => idToIdx.has(e.from) && idToIdx.has(e.to))
      .map(e => ({ source: idToIdx.get(e.from)!, target: idToIdx.get(e.to)! }));

    const adjOut: number[][] = nodes.map(() => []);
    const adjIn:  number[][] = nodes.map(() => []);
    links.forEach(l => {
      const s = typeof l.source === 'number' ? l.source : l.source.index;
      const t = typeof l.target === 'number' ? l.target : l.target.index;
      adjOut[s].push(t);
      adjIn[t].push(s);
    });

    const byZone = new Map<string, number[]>();
    nodes.forEach((n, i) => {
      const z = n.zone || '(unknown)';
      if (!byZone.has(z)) byZone.set(z, []);
      byZone.get(z)!.push(i);
    });

    const rootG = svg.append('g') as d3.Selection<SVGGElement, unknown, null, undefined>;
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 8])
      .on('zoom', ev => rootG.attr('transform', ev.transform.toString()));
    svg.call(zoom);
    svg.on('dblclick.zoom', null);

    const edgeColor = (d: SimLink) => {
      const a = nodes[typeof d.source === 'number' ? d.source : d.source.index];
      const b = nodes[typeof d.target === 'number' ? d.target : d.target.index];
      if (a.in_cycle && b.in_cycle) return 'rgba(192,132,255,0.70)';
      if (!a.reachable || !b.reachable) return 'rgba(255,101,116,0.42)';
      return 'rgba(122,143,240,0.28)';
    };
    const edgeMarker = (d: SimLink) => {
      const a = nodes[typeof d.source === 'number' ? d.source : d.source.index];
      const b = nodes[typeof d.target === 'number' ? d.target : d.target.index];
      if (a.in_cycle && b.in_cycle) return 'url(#arr-cycle)';
      if (!a.reachable || !b.reachable) return 'url(#arr-leak)';
      return 'url(#arr-reach)';
    };

    const linkSel = rootG.append('g')
      .attr('class', 'links')
      .selectAll<SVGPathElement, SimLink>('path')
      .data(links).enter().append('path')
      .attr('class', 'link-el')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('stroke-width', 0.9)
      .attr('stroke', edgeColor as any)
      .attr('marker-end', edgeMarker as any);

    const nodeColor = (d: SimNode) =>
      d.in_cycle ? 'var(--cycle)' : (d.reachable ? 'var(--reach)' : 'var(--leak)');
    const nodeStroke = (d: SimNode) =>
      d.in_cycle ? 'rgba(192,132,255,0.95)' :
      d.reachable ? 'rgba(122,143,240,0.95)' : 'rgba(255,101,116,0.95)';

    const tooltip = tooltipRef.current!;

    const nodeSel = rootG.append('g')
      .attr('class', 'nodes')
      .selectAll<SVGCircleElement, SimNode>('circle')
      .data(nodes).enter().append('circle')
      .attr('class', 'node-el')
      .attr('r', d => d.r)
      .attr('fill', nodeColor)
      .attr('stroke', nodeStroke)
      .attr('stroke-width', 1.2)
      .attr('filter', d => d.in_cycle ? 'url(#node-glow)' : null)
      .style('cursor', 'pointer')
      .call(
        d3.drag<SVGCircleElement, SimNode>()
          .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x!; d.fy = d.y!; })
          .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .on('mousemove', (ev: MouseEvent, d) => {
        tooltip.style.display = 'block';
        tooltip.style.left = (ev.clientX + 14) + 'px';
        tooltip.style.top  = (ev.clientY + 14) + 'px';
        const cls = d.in_cycle ? 'cycle' : (d.reachable ? 'reach' : 'leak');
        const lbl = d.in_cycle ? 'in cycle' : (d.reachable ? 'reachable' : 'leaked');
        tooltip.innerHTML =
          `<div><span class="t ${cls}">${lbl}</span><span class="a">${d.id}</span></div>` +
          `<div class="b">${fmtBytes(d.size)} &middot; zone: ${d.zone}</div>`;
      })
      .on('mouseleave', () => { tooltip.style.display = 'none'; })
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        setSelected(d.index);
      });

    svg.on('click', () => setSelected(null));

    const pathFor = (d: SimLink): string => {
      const s = typeof d.source === 'number' ? nodes[d.source] : d.source;
      const t = typeof d.target === 'number' ? nodes[d.target] : d.target;
      const sx = s.x!, sy = s.y!;
      let tx = t.x!, ty = t.y!;
      const dx = tx - sx, dy = ty - sy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const tr = (t.r || 6) + 2.5;
      tx = tx - (dx / dist) * tr;
      ty = ty - (dy / dist) * tr;
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const nx = -dy / dist, ny = dx / dist;
      const k = Math.min(22, dist * 0.18);
      const cx = mx + nx * k, cy = my + ny * k;
      return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
    };

    const sim = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links).distance(54).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-160))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide<SimNode>().radius(d => d.r + 3))
      .alpha(1).alphaDecay(0.028)
      .on('tick', () => {
        linkSel.attr('d', pathFor);
        nodeSel.attr('cx', d => d.x!).attr('cy', d => d.y!);
      });

    Object.assign(stateRef.current, {
      nodes, links, idToIdx, byZone, adjOut, adjIn,
      sim, nodeSel, linkSel, rootG, zoom,
    });

    return () => { sim.stop(); };
  }, [data]);

  // Filter / zone / search / selection → dim state.
  useEffect(() => {
    const s = stateRef.current;
    if (!s.nodeSel || !s.linkSel) return;

    // Clear pulse rings.
    if (s.pulseG) { s.pulseG.remove(); s.pulseG = null; }

    const q = search.trim().toLowerCase();
    let visible: Set<number>;

    if (selected != null) {
      // Neighborhood mode: show selected + direct neighbors.
      visible = new Set<number>([selected]);
      (s.adjOut[selected] || []).forEach(t => visible.add(t));
      (s.adjIn[selected]  || []).forEach(t => visible.add(t));
    } else {
      visible = new Set<number>();
      for (let i = 0; i < s.nodes.length; i++) {
        const d = s.nodes[i];
        if (zone) {
          const idxs = s.byZone.get(zone) || [];
          if (idxs.indexOf(i) < 0) continue;
        }
        if (q && d.id.toLowerCase().indexOf(q) < 0) continue;
        if (filter === 'reachable' && (!d.reachable || d.in_cycle)) continue;
        if (filter === 'leaked'    && d.reachable) continue;
        if (filter === 'cycle'     && !d.in_cycle) continue;
        visible.add(i);
      }
    }

    s.nodeSel.classed('dim', (_, i) => !visible.has(i));
    s.linkSel.classed('dim', (l) => {
      const src = typeof l.source === 'number' ? l.source : (l.source as SimNode).index;
      const tgt = typeof l.target === 'number' ? l.target : (l.target as SimNode).index;
      return !(visible.has(src) && visible.has(tgt));
    });
  }, [filter, zone, search, selected]);

  // Focus on cycle: compute bounding box, fly zoom transform, spawn pulse rings.
  useEffect(() => {
    const s = stateRef.current;
    if (focusCycle == null || !s.rootG || !s.zoom || !svgRef.current) return;

    const cycle = data.cycles[focusCycle] || [];
    const indices = cycle
      .map(id => s.idToIdx.get(id))
      .filter((x): x is number => x != null);
    if (indices.length === 0) return;

    // Give the sim a moment to have positions (noop if already settled).
    const nodes = s.nodes;
    const pad = 60;
    const xs = indices.map(i => nodes[i].x || 0);
    const ys = indices.map(i => nodes[i].y || 0);
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const k = Math.min(3.0, Math.min(s.viewW / bw, s.viewH / bh));
    const tx = s.viewW / 2 - ((x0 + x1) / 2) * k;
    const ty = s.viewH / 2 - ((y0 + y1) / 2) * k;

    d3.select(svgRef.current).transition().duration(650)
      .call(s.zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));

    // Pulse rings.
    if (s.pulseG) s.pulseG.remove();
    const pulseG = s.rootG.append('g').attr('class', 'pulses').node() as SVGGElement;
    s.pulseG = pulseG;
    const pulseSel = d3.select(pulseG);
    indices.forEach(i => {
      const n = nodes[i];
      const r = n.r;
      pulseSel.append('circle')
        .attr('class', 'pulse-ring')
        .attr('cx', n.x!).attr('cy', n.y!)
        .attr('r', r)
        .attr('style', `--r0:${r}`);
    });

    // Dim everything else.
    const set = new Set(indices);
    s.nodeSel!.classed('dim', (_, i) => !set.has(i));
    s.linkSel!.classed('dim', (l) => {
      const src = typeof l.source === 'number' ? l.source : (l.source as SimNode).index;
      const tgt = typeof l.target === 'number' ? l.target : (l.target as SimNode).index;
      return !(set.has(src) && set.has(tgt));
    });
  }, [focusCycle, focusNonce, data.cycles]);

  // Node detail (right-top panel inside graph-wrap).
  const sel = selected != null ? stateRef.current.nodes[selected] : null;
  const outCount = selected != null ? (stateRef.current.adjOut[selected] || []).length : 0;
  const inCount  = selected != null ? (stateRef.current.adjIn[selected]  || []).length : 0;

  return (
    <>
      <svg ref={svgRef} viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet" />
      <div className="legend">
        <div><span className="sw" style={{ background: 'var(--reach)' }} />Reachable</div>
        <div><span className="sw" style={{ background: 'var(--leak)' }} />Leaked</div>
        <div><span className="sw" style={{ background: 'var(--cycle)' }} />Leaked · in cycle</div>
      </div>
      <div className="tooltip" ref={tooltipRef} style={{ display: 'none' }} />
      {sel && (
        <div className="node-detail" onClick={e => e.stopPropagation()}>
          <div className="nd-head">
            <span
              className="t"
              style={{
                background: sel.in_cycle ? 'rgba(192,132,255,0.14)'
                         : sel.reachable ? 'rgba(122,143,240,0.12)'
                                         : 'rgba(255,101,116,0.12)',
                border: `1px solid ${
                  sel.in_cycle ? 'rgba(192,132,255,0.55)'
                  : sel.reachable ? 'rgba(122,143,240,0.55)'
                                  : 'rgba(255,101,116,0.55)'
                }`,
                color: sel.in_cycle ? 'var(--cycle)' : (sel.reachable ? 'var(--reach)' : 'var(--leak)'),
              }}
            >
              {sel.in_cycle ? 'in cycle' : (sel.reachable ? 'reachable' : 'leaked')}
            </span>
            <button className="x" onClick={() => setSelected(null)} aria-label="Close">×</button>
          </div>
          <div className="nd-addr">{sel.id}</div>
          <div className="nd-row"><span>size</span><span>{fmtBytes(sel.size)}</span></div>
          <div className="nd-row"><span>zone</span><span>{sel.zone}</span></div>
          <div className="nd-row"><span>out-edges</span><span>{outCount}</span></div>
          <div className="nd-row"><span>in-edges</span><span>{inCount}</span></div>
          <div className="nd-foot">
            Connected nodes are highlighted. Click background or press <span className="mono" style={{ color: 'var(--fg-0)' }}>Esc</span> to reset.
          </div>
        </div>
      )}
    </>
  );
}
