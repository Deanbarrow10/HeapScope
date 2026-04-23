import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph from './components/ForceGraph';
import USMap from './components/USMap';
import JSONModal from './components/JSONModal';
import type { FilterKey, LeakReport } from './types';

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export default function App() {
  const [report, setReport] = useState<LeakReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [zone, setZone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [focusCycle, setFocusCycle] = useState<number | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [jsonOpen, setJsonOpen] = useState(false);

  const analysisRef = useRef<HTMLElement | null>(null);

  // Auto-load the captured leaks.json on mount.
  useEffect(() => {
    fetch('./leaks.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((data: LeakReport) => setReport(data))
      .catch((err: Error) => {
        setLoadError(err.message);
        console.error('[heapscope] failed to load leaks.json:', err);
      });
  }, []);

  // Keyboard shortcuts for filters + Esc to reset.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === 'Escape') { resetView(); setJsonOpen(false); return; }
      if (e.key === '1') setFilter('all');
      if (e.key === '2') setFilter('reachable');
      if (e.key === '3') setFilter('leaked');
      if (e.key === '4') setFilter('cycle');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function resetView() {
    setFilter('all');
    setZone(null);
    setSearch('');
    setFocusCycle(null);
  }

  const zoneRows = useMemo(() => {
    if (!report) return [];
    const byZone = new Map<string, { total: number; reach: number; leak: number; bytes: number }>();
    for (const n of report.nodes) {
      const z = n.zone || '(unknown)';
      let rec = byZone.get(z);
      if (!rec) { rec = { total: 0, reach: 0, leak: 0, bytes: 0 }; byZone.set(z, rec); }
      rec.total++;
      rec.bytes += n.size || 0;
      if (n.reachable) rec.reach++; else rec.leak++;
    }
    return Array.from(byZone.entries())
      .map(([name, rec]) => ({ name, ...rec }))
      .sort((a, b) => b.total - a.total);
  }, [report]);

  const cycleNodeCount = useMemo(
    () => (report ? report.nodes.filter(n => n.in_cycle).length : 0),
    [report]
  );

  function scrollToAnalysis() {
    analysisRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <>
      <nav className="top">
        <span className="brand"><span className="mark" />HeapScope</span>
        <span className="links">
          <a href="#platform">Platform</a>
          <a href="#analysis">Analysis</a>
          <a href="#map">Notable bugs</a>
        </span>
        <span className="spacer" />
        <button className="ghost" onClick={() => setJsonOpen(true)}>View JSON</button>
        <button className="cta" onClick={scrollToAnalysis}>Open analysis →</button>
      </nav>

      {/* ============================== HERO ============================== */}
      <section className="hero">
        <div className="chip"><span className="dot" />Apple Silicon · Mach · libmalloc · BFS + Tarjan</div>
        <h1 className="hero-title">
          Find what's leaking,<br />
          <span className="serif-i accent">precisely</span>.
        </h1>
        <p className="hero-sub">
          HeapScope is a miniature Leaks instrument for macOS on Apple Silicon.
          Attach to a running process, enumerate every malloc zone via cross-task{' '}
          <span className="mono">memory_reader_t</span>, conservatively scan roots out of{' '}
          <span className="mono">__DATA</span> / thread stacks / registers, and surface every
          allocation the program can no longer reach — including the retain cycles Tarjan
          finds in the leaked subgraph.
        </p>
        <div className="hero-cta">
          <button className="btn-primary" onClick={scrollToAnalysis}>
            Open analysis <span className="arrow">→</span>
          </button>
          <button className="btn-ghost" onClick={() => setJsonOpen(true)}>View JSON</button>
        </div>
        <div className="hero-pills">
          <span>task_for_pid</span>
          <span>malloc_get_all_zones</span>
          <span>memory_reader_t</span>
          <span>TASK_DYLD_INFO</span>
          <span>ARM_THREAD_STATE64</span>
          <span>LC_SEGMENT_64</span>
          <span>arm64e PAC strip</span>
        </div>
      </section>

      {/* ============================ PLATFORM ============================ */}
      <section className="platform" id="platform">
        <div className="eyebrow">Platform</div>
        <h2 className="section-title">What HeapScope <span className="serif-i">does</span></h2>
        <p className="section-lede">
          A short pipeline — attach, enumerate, scan, propagate, report — built directly on the APIs that power Instruments.
        </p>
        <div className="cards">
          <div className="card">
            <span className="tag">Heap snapshot</span>
            <h3>Cross-task zone enumeration</h3>
            <p>
              <span className="mono">malloc_get_all_zones</span> with a cross-task{' '}
              <span className="mono">memory_reader_t</span> callback recovers every live{' '}
              <span className="mono">{'{address, size}'}</span> range from the target's{' '}
              <span className="mono">malloc_introspection_t.enumerator</span> — called in-process
              via the shared-cache mapping.
            </p>
            <div className="chips"><span>libmalloc</span><span>mach_vm_read</span><span>MALLOC_PTR_IN_USE_RANGE_TYPE</span></div>
          </div>
          <div className="card">
            <span className="tag">Roots</span>
            <h3>Precise root collection</h3>
            <p>
              <span className="mono">TASK_DYLD_INFO</span> → <span className="mono">dyld_all_image_infos</span> walks every loaded Mach-O for{' '}
              <span className="mono">__DATA</span> / <span className="mono">__DATA_CONST</span> / <span className="mono">__DATA_DIRTY</span>.
              Per-thread <span className="mono">ARM_THREAD_STATE64</span> gives a stack window and 31 GPRs as candidate roots.
            </p>
            <div className="chips"><span>dyld</span><span>Mach-O</span><span>thread_get_state</span></div>
          </div>
          <div className="card">
            <span className="tag">Reachability</span>
            <h3>Conservative scan + BFS</h3>
            <p>
              Every 8-byte-aligned word in each root region and allocation body is a candidate pointer. Strip arm64e PAC bits, binary-search the sorted allocation array, and BFS-propagate. Unmapped shared-cache pages fall through per-4KB retries — one bad page doesn't nuke a segment.
            </p>
            <div className="chips"><span>PAC strip</span><span>BFS</span><span>per-page retry</span></div>
          </div>
          <div className="card">
            <span className="tag">Cycles</span>
            <h3>Tarjan on the leaked subgraph</h3>
            <p>
              Unreachable allocations still get their outgoing edges recorded, so Tarjan SCC runs over the leaked subgraph and finds every retain cycle — the thing reference counting can't escape. Non-trivial SCCs surface as cycle entries in the report.
            </p>
            <div className="chips"><span>Tarjan SCC</span><span>retain cycles</span><span>JSON report</span></div>
          </div>
        </div>
      </section>

      {/* ============================ ANALYSIS ============================ */}
      <section className="analysis" id="analysis" ref={analysisRef}>
        <div className="eyebrow">Analysis</div>
        <h2 className="section-title">The current <span className="serif-i">snapshot</span></h2>
        <p className="section-lede">
          Auto-loaded from <span className="mono">./leaks.json</span>. Blue = reachable, coral = leaked, purple = in a retain cycle. Drag a node to pin; scroll to zoom.
        </p>

        {report?._sample && (
          <div className="sample-banner">
            <b>Sample data.</b>
            This is the committed sample snapshot. Run the analyzer once and replace{' '}
            <span className="mono">viewer/public/leaks.json</span> to see your own process.
          </div>
        )}

        <div className="stats-bar">
          <div className="stat"><span className="label">pid</span><span className="value mono">{report?.pid ?? '—'}</span></div>
          <div className="stat"><span className="label">total allocations</span><span className="value">{report?.summary.total_allocations ?? '—'}</span></div>
          <div className="stat reach"><span className="label">reachable</span><span className="value">{report?.summary.reachable ?? '—'}</span></div>
          <div className="stat leak"><span className="label">leaked</span><span className="value">{report?.summary.leaked ?? '—'}</span></div>
          <div className="stat leak"><span className="label">leaked bytes</span><span className="value">{fmtBytes(report?.summary.leaked_bytes)}</span></div>
          <div className="stat cycle"><span className="label">cycles</span><span className="value">{report?.summary.cycles_found ?? '—'}</span></div>
        </div>

        <div className="hint">
          <strong>Try it:</strong> click a <span className="kbd">filter</span> to scope the graph · click a <span className="kbd">zone</span> to highlight its allocations · click a <span className="kbd">cycle</span> to fly to it · click a <span className="kbd">node</span> for details. Press <span className="kbd">Esc</span> to reset.
        </div>

        <div className="toolbar">
          <span className="tb-label">Filter</span>
          <button className={`tb-btn${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            All <span className="count">{report?.summary.total_allocations ?? '—'}</span>
          </button>
          <button className={`tb-btn${filter === 'reachable' ? ' active' : ''}`} onClick={() => setFilter('reachable')}>
            <span className="sw" style={{ background: 'var(--reach)' }} />Reachable <span className="count">{report?.summary.reachable ?? '—'}</span>
          </button>
          <button className={`tb-btn${filter === 'leaked' ? ' active' : ''}`} onClick={() => setFilter('leaked')}>
            <span className="sw" style={{ background: 'var(--leak)' }} />Leaked <span className="count">{report?.summary.leaked ?? '—'}</span>
          </button>
          <button className={`tb-btn${filter === 'cycle' ? ' active' : ''}`} onClick={() => setFilter('cycle')}>
            <span className="sw" style={{ background: 'var(--cycle)' }} />In cycle <span className="count">{cycleNodeCount}</span>
          </button>
          <span className="tb-spacer" />
          <input
            className="tb-search"
            type="text"
            placeholder="search address 0x…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="tb-reset" onClick={resetView}>Reset view</button>
        </div>

        <div className="analysis-body">
          <div className="graph-wrap">
            {report ? (
              <ForceGraph
                data={report}
                filter={filter}
                zone={zone}
                search={search}
                focusCycle={focusCycle}
                focusNonce={focusNonce}
              />
            ) : (
              <div className="empty">
                <div>
                  <div style={{ fontSize: 15, color: 'var(--fg-0)', marginBottom: 6 }}>
                    No <span className="mono">leaks.json</span> found
                  </div>
                  <div>
                    {loadError
                      ? `Error: ${loadError} — place your report at viewer/public/leaks.json.`
                      : 'Loading…'}
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside className="inspector">
            <div className="inspector-card">
              <h4>Zones</h4>
              {zoneRows.length === 0 ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 12.5 }}>Awaiting data…</div>
              ) : (
                zoneRows.map(r => {
                  const pctReach = r.total ? (r.reach / r.total) * 100 : 0;
                  const pctLeak  = 100 - pctReach;
                  return (
                    <div
                      key={r.name}
                      className={`zone-row${zone === r.name ? ' active' : ''}`}
                      onClick={() => setZone(zone === r.name ? null : r.name)}
                      title="Click to filter the graph to this zone"
                    >
                      <div className="name">{r.name}</div>
                      <div className="count">{r.total} · {fmtBytes(r.bytes)}</div>
                      <div className="bar-wrap">
                        <div className="reach-b" style={{ width: `${pctReach.toFixed(1)}%` }} />
                        <div className="leak-b"  style={{ width: `${pctLeak.toFixed(1)}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="inspector-card">
              <h4>Retain cycles</h4>
              {!report || report.cycles.length === 0 ? (
                <div style={{ color: 'var(--fg-2)', fontSize: 12.5 }}>No retain cycles detected.</div>
              ) : (
                report.cycles.map((c, i) => (
                  <div
                    key={i}
                    className={`cycle-row${focusCycle === i ? ' active' : ''}`}
                    onClick={() => { setFocusCycle(i); setFocusNonce(n => n + 1); }}
                    title="Click to fly to this cycle"
                  >
                    <div className="head">
                      <span className="lbl">CYCLE #{i + 1}</span>
                      <span className="meta">{c.length} node{c.length === 1 ? '' : 's'} · click to focus ↗</span>
                    </div>
                    <div className="addrs">{c.join(' → ')}</div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </section>

      {/* ============================ MAP ================================= */}
      <section className="map-section" id="map">
        <div className="eyebrow">Field notes</div>
        <h2 className="section-title">Notable memory bugs in <span className="serif-i">shipping software</span></h2>
        <p className="section-lede">
          A curated gallery — not live data. Each marker is a real, publicly reported memory issue at a major tech company, pinned to the company's HQ. Click a triangle for the summary.
        </p>
        <USMap />
      </section>

      <footer>
        <div>HeapScope · a miniature Leaks instrument for Apple Silicon</div>
        <div className="fl">
          <span>task_for_pid</span>
          <span>mach_vm_read</span>
          <span>memory_reader_t</span>
          <span>dyld_all_image_infos</span>
          <span>Tarjan SCC</span>
        </div>
      </footer>

      <JSONModal open={jsonOpen} onClose={() => setJsonOpen(false)} report={report} />
    </>
  );
}
