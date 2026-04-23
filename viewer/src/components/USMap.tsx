import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection } from 'geojson';
import { bugs } from '../data/bugs';
import { FIPS_TO_ABBR } from '../data/fips';
import type { MemoryBug } from '../types';

const TOPO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';

function milesToLon(miles: number, atLat: number): number {
  const milesPerDeg = 69.172 * Math.cos((atLat * Math.PI) / 180);
  return miles / milesPerDeg;
}

export default function USMap() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<HTMLDivElement | null>(null);
  const markerRefs = useRef<Map<number, SVGGElement>>(new Map());

  const [selectedBug, setSelectedBug] = useState<MemoryBug | null>(null);

  // Draw the map once on mount.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    let cancelled = false;
    const W = 960, H = 600;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    fetch(TOPO_URL)
      .then(r => r.json() as Promise<Topology>)
      .catch(() => null)
      .then(us => {
        if (cancelled || !us) {
          if (!us) {
            svg.append('text')
              .attr('x', W / 2).attr('y', H / 2)
              .attr('text-anchor', 'middle')
              .attr('fill', '#6A6A7E').attr('font-size', 13)
              .text('US map data unavailable (offline).');
          }
          return;
        }

        const statesGeom = us.objects.states as GeometryCollection;
        const states = topojson.feature(us, statesGeom) as unknown as FeatureCollection;
        const projection = d3.geoAlbersUsa().fitExtent([[12, 14], [W - 12, H - 66]], states);
        const path = d3.geoPath(projection);

        svg.append('g').attr('class', 'states')
          .selectAll('path')
          .data(states.features).enter().append('path')
          .attr('class', 'us-state')
          .attr('d', path as any);

        svg.append('g').attr('class', 'state-labels')
          .selectAll('text')
          .data(states.features).enter().append('text')
          .attr('class', 'state-label')
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('transform', (d: Feature) => {
            const c = path.centroid(d);
            if (!c || !isFinite(c[0])) return null as any;
            return `translate(${c[0]},${c[1]})`;
          })
          .text((d: Feature) => FIPS_TO_ABBR[String(d.id)] || '');

        // Scale bar — bottom right.
        const gScale = svg.append('g')
          .attr('class', 'scale-bar')
          .attr('transform', `translate(${W - 170},${H - 28})`);
        const a = projection([-98.5, 39.5]);
        const b = projection([-98.5 + milesToLon(1000, 39.5), 39.5]);
        const pxPer1000mi = Math.abs((b && a) ? (b[0] - a[0]) : 120);
        gScale.append('line').attr('x1', 0).attr('y1', 0).attr('x2', pxPer1000mi).attr('y2', 0);
        gScale.append('line').attr('x1', 0).attr('y1', -4).attr('x2', 0).attr('y2', 4);
        gScale.append('line').attr('x1', pxPer1000mi / 2).attr('y1', -4).attr('x2', pxPer1000mi / 2).attr('y2', 4);
        gScale.append('line').attr('x1', pxPer1000mi).attr('y1', -4).attr('x2', pxPer1000mi).attr('y2', 4);
        gScale.append('text').attr('x', 0).attr('y', 16).text('0');
        gScale.append('text').attr('x', pxPer1000mi).attr('y', 16).attr('text-anchor', 'end').text('~1000 mi');

        // Markers.
        const gMarkers = svg.append('g').attr('class', 'markers');
        bugs.forEach(bug => {
          const p = projection(bug.hq);
          if (!p) return;
          const mg = gMarkers.append('g')
            .attr('class', 'marker-group')
            .attr('data-bug', String(bug.n))
            .attr('transform', `translate(${p[0]},${p[1]})`)
            .style('cursor', 'pointer');

          mg.append('circle').attr('class', 'map-ping').attr('r', 13);
          mg.append('circle').attr('class', 'marker-circle').attr('r', 13);

          const tri = [[0, -9], [8, 6], [-8, 6]].map(q => q.join(',')).join(' ');
          mg.append('polygon').attr('class', 'marker-triangle').attr('points', tri);

          const lg = mg.append('g').attr('transform', 'translate(14,-6)');
          const tw = 24;
          lg.append('rect').attr('class', 'marker-label-bg')
            .attr('x', 0).attr('y', 0).attr('width', tw).attr('height', 14)
            .attr('rx', 3).attr('ry', 3);
          lg.append('text').attr('class', 'marker-label-text')
            .attr('x', tw / 2).attr('y', 10).attr('text-anchor', 'middle')
            .text('#' + String(bug.n).padStart(2, '0'));

          markerRefs.current.set(bug.n, mg.node() as SVGGElement);

          mg.on('mouseenter', (ev: MouseEvent) => {
            const hover = hoverRef.current;
            const wrap = wrapRef.current;
            if (!hover || !wrap) return;
            const rect = wrap.getBoundingClientRect();
            hover.innerHTML =
              `<div style="font-weight:600">${bug.company}</div>` +
              `<div class="c">${bug.tag} &middot; ${bug.year}</div>`;
            hover.style.display = 'block';
            hover.style.left = (ev.clientX - rect.left + 14) + 'px';
            hover.style.top  = (ev.clientY - rect.top + 14) + 'px';
          });
          mg.on('mousemove', (ev: MouseEvent) => {
            const hover = hoverRef.current;
            const wrap = wrapRef.current;
            if (!hover || !wrap) return;
            const rect = wrap.getBoundingClientRect();
            hover.style.left = (ev.clientX - rect.left + 14) + 'px';
            hover.style.top  = (ev.clientY - rect.top + 14) + 'px';
          });
          mg.on('mouseleave', () => {
            if (hoverRef.current) hoverRef.current.style.display = 'none';
          });
          mg.on('click', (ev: MouseEvent) => {
            ev.stopPropagation();
            if (hoverRef.current) hoverRef.current.style.display = 'none';
            setSelectedBug(bug);
          });
        });

        svg.on('click', () => setSelectedBug(null));
      });

    return () => { cancelled = true; };
  }, []);

  // Toggle .active on marker groups when selection changes.
  useEffect(() => {
    markerRefs.current.forEach((el, n) => {
      el.classList.toggle('active', selectedBug?.n === n);
    });
  }, [selectedBug]);

  // Arrow-key navigation through bugs when detail panel is open.
  useEffect(() => {
    if (!selectedBug) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = bugs.findIndex(b => b.n === selectedBug.n);
      if (e.key === 'ArrowLeft')  setSelectedBug(bugs[(idx - 1 + bugs.length) % bugs.length]);
      if (e.key === 'ArrowRight') setSelectedBug(bugs[(idx + 1) % bugs.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedBug]);

  const prev = () => {
    if (!selectedBug) return;
    const idx = bugs.findIndex(b => b.n === selectedBug.n);
    setSelectedBug(bugs[(idx - 1 + bugs.length) % bugs.length]);
  };
  const next = () => {
    if (!selectedBug) return;
    const idx = bugs.findIndex(b => b.n === selectedBug.n);
    setSelectedBug(bugs[(idx + 1) % bugs.length]);
  };

  return (
    <div className="map-wrap" ref={wrapRef}>
      <svg ref={svgRef} viewBox="0 0 960 600" preserveAspectRatio="xMidYMid meet" />
      <div className="map-hover" ref={hoverRef} style={{ display: 'none' }} />
      {selectedBug && (
        <div className="map-detail" onClick={e => e.stopPropagation()}>
          <div className="row-top">
            <span className="pill">#{String(selectedBug.n).padStart(2, '0')}</span>
            <span className="pill plain">{selectedBug.tag}</span>
            <span className="pill plain">{selectedBug.year}</span>
            <button className="close" aria-label="Close" onClick={() => setSelectedBug(null)}>×</button>
          </div>
          <h3>{selectedBug.company}</h3>
          <div className="hq">{selectedBug.area}</div>
          <div className="field-label">Issue</div>
          <div className="field-value">{selectedBug.issue}</div>
          <div className="field-label">What went wrong</div>
          <div className="field-value">{selectedBug.description}</div>
          <div className="field-label">Outcome</div>
          <div className="field-value">{selectedBug.outcome}</div>
          <div className="nav-btns">
            <button onClick={prev}>← Previous</button>
            <button onClick={next}>Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}
