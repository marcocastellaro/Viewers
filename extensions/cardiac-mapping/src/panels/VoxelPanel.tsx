import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSystem } from '@ohif/core/src';
import { getActiveSource, getSourceDisplaySet } from '../activeSource';

// Pannello CardioMap (riquadro 4). Due parti:
//  1) Selezione segmento: clic su un voxel DENTRO la segmentazione -> curva media +-SD dei 10
//     echi (variabilita' del segnale) del segmento; il T2* mostrato e' quello DELL'ANALISI.
//  2) Statistiche: bullseye T2* (SVG) + tabella per-segmento, coi valori RICAVATI DALL'ANALISI
//     (endpoint /api/studies/{uid}/segments), piu' due ROI aggregate: Mid-ventricular septum
//     (8+9) e Global myocardium. Nessun ricalcolo lato client.
//
// Usa le istanze cornerstone CONDIVISE di @ohif/extension-cornerstone (getCornerstoneLibraries):
// import diretti di '@cornerstonejs/*' creerebbero istanze duplicate (tool morto, eventi persi).

type Slice = { id: string; te: number; ipp: number[]; iop: number[]; rows: number; cols: number; d: number };
type Fit = { t2star: number; s0: number };
type Curve = { te: number[]; mean: number[]; sd: number[]; fit: Fit | null; segIdx: number; nVox: number };
type Stat = { t2star: number | null; sd: number; n: number };
type SegStat = Stat & { label: string };
type Stats = { perSeg: Record<number, SegStat>; septum: Stat; global: Stat };

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function studyUID(): string | null {
  const s = new URL(window.location.href).searchParams.get('StudyInstanceUIDs');
  return s ? s.split(',')[0] : null;
}

// Scala colori clinica T2* (ms): rosso <10 -> arancio 20 -> giallo 30 -> verde >=30 (normale).
const _hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const _lerp = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
const _STOPS: [number, string][] = [[0, '#e53935'], [10, '#e53935'], [20, '#fb8c00'], [30, '#fdd835']];
function t2starColor(v: number | null): string {
  if (v == null || !isFinite(v)) return '#616161';
  if (v >= 30) return '#43a047';
  let a = _STOPS[0], b = _STOPS[_STOPS.length - 1];
  for (let i = 0; i < _STOPS.length - 1; i++) if (v >= _STOPS[i][0] && v <= _STOPS[i + 1][0]) { a = _STOPS[i]; b = _STOPS[i + 1]; break; }
  return _lerp(_hex(a[1]), _hex(b[1]), (v - a[0]) / ((b[0] - a[0]) || 1));
}

const _GEOM: Record<number, [number, number, number, number]> = {
  1: [2, 3, 60, 120], 2: [2, 3, 120, 180], 3: [2, 3, 180, 240], 4: [2, 3, 240, 300], 5: [2, 3, 300, 360], 6: [2, 3, 0, 60],
  7: [1, 2, 60, 120], 8: [1, 2, 120, 180], 9: [1, 2, 180, 240], 10: [1, 2, 240, 300], 11: [1, 2, 300, 360], 12: [1, 2, 0, 60],
  13: [0, 1, 45, 135], 14: [0, 1, 135, 225], 15: [0, 1, 225, 315], 16: [0, 1, 315, 405],
};

function findT2starDisplaySet(displaySetService: any) {
  const dss = displaySetService?.getActiveDisplaySets?.() || [];
  return dss.find((ds: any) => ds?.Modality === 'MR' && /t2star/i.test(ds?.SeriesDescription || '') &&
    ((ds?.imageIds?.length || 0) >= 20 || (ds?.images?.length || 0) >= 20));
}

function echoMetas(ds: any, metaData: any): Slice[] {
  const ids: string[] = ds?.imageIds || (ds?.images || []).map((i: any) => i.imageId);
  return (ids || []).map((id: string) => {
    const inst: any = metaData.get('instance', id) || {};
    return {
      id, te: Number(inst.EchoTime),
      ipp: (inst.ImagePositionPatient || []).map(Number),
      iop: (inst.ImageOrientationPatient || []).map(Number),
      rows: Number(inst.Rows), cols: Number(inst.Columns), d: 0,
    } as Slice;
  }).filter(m => m.ipp.length === 3 && m.iop.length === 6 && isFinite(m.te));
}

function pickSlice(metas: Slice[], world: number[]): Slice[] | null {
  if (!metas.length || !world) return null;
  const iop = metas[0].iop;
  const n = cross(iop.slice(0, 3), iop.slice(3, 6));
  metas.forEach(m => (m.d = dot(m.ipp, n)));
  const wd = dot(world, n);
  let bestD = metas[0].d, bestDist = Infinity;
  metas.forEach(m => { const dist = Math.abs(m.d - wd); if (dist < bestDist) { bestDist = dist; bestD = m.d; } });
  const slice = metas.filter(m => Math.abs(m.d - bestD) < 0.5).sort((a, b) => a.te - b.te);
  return slice.length >= 2 ? slice : null;
}

// Fit log-lineare pesato S^2 sulla curva media (solo per disegnare la linea di fit).
function fitMeanDecay(te: number[], sig: number[]): Fit | null {
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (let i = 0; i < te.length; i++) if (sig[i] > 0) { xs.push(te[i]); ys.push(Math.log(sig[i])); ws.push(sig[i] * sig[i]); }
  if (xs.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < xs.length; i++) { const w = ws[i]; sw += w; swx += w * xs[i]; swy += w * ys[i]; swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i]; }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  if (slope >= 0) return null;
  return { t2star: -1 / slope, s0: Math.exp((swy - slope * swx) / sw) };
}

// Clic: individua il segmento e ricava la curva media +-SD del segnale (per il grafico).
async function readCurve(world: number[], cs: any, t2ds: any, segId: string): Promise<{ outside?: boolean; curve?: Curve } | null> {
  const segUtils = cs.cornerstoneTools.utilities.segmentation;
  const labelVol = segUtils.getOrCreateSegmentationVolume(segId);
  if (!labelVol) return null;
  const [nx, ny] = labelVol.dimensions;
  const vm = labelVol.voxelManager;
  const idx = cs.cornerstone.utilities.transformWorldToIndex(labelVol.imageData, world);
  const ci = Math.round(idx[0]), cj = Math.round(idx[1]), k = Math.round(idx[2]);
  const segIdx = vm.getAtIJK(ci, cj, k);
  if (!segIdx || segIdx < 1) return { outside: true };
  const slice = pickSlice(echoMetas(t2ds, cs.cornerstone.metaData), world);
  if (!slice) return null;
  const cols = slice[0].cols, rows = slice[0].rows;
  const imgs = await Promise.all(slice.map((m: Slice) => cs.cornerstone.imageLoader.loadAndCacheImage(m.id)));
  const pds = imgs.map((img: any) => img.getPixelData());
  const te = slice.map((m: Slice) => m.te);
  const perEcho: number[][] = slice.map(() => []);
  for (let j = 0; j < ny && j < rows; j++) for (let i = 0; i < nx && i < cols; i++) {
    if (vm.getAtIJK(i, j, k) === segIdx) { const off = j * cols + i; pds.forEach((pd: any, e: number) => perEcho[e].push(Number(pd[off]))); }
  }
  const nVox = perEcho[0].length;
  if (!nVox) return { outside: true };
  const mean = perEcho.map(v => v.reduce((s, x) => s + x, 0) / v.length);
  const sd = perEcho.map((v, e) => { const mu = mean[e]; return Math.sqrt(v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / v.length); });
  return { curve: { te, mean, sd, fit: fitMeanDecay(te, mean), segIdx, nVox } };
}

function DecayPlot({ curve }: { curve: Curve }) {
  const W = 264, H = 150, ml = 34, mr = 8, mt = 8, mb = 22;
  const { te, mean, sd, fit } = curve;
  const teMax = Math.max(...te, 1), sMax = Math.max(...mean.map((m, i) => m + sd[i]), 1);
  const px = (t: number) => ml + (t / teMax) * (W - ml - mr);
  const py = (s: number) => H - mb - (s / sMax) * (H - mt - mb);
  const upper = te.map((t, i) => `${px(t).toFixed(1)},${py(mean[i] + sd[i]).toFixed(1)}`);
  const lower = te.map((t, i) => `${px(t).toFixed(1)},${py(Math.max(mean[i] - sd[i], 0)).toFixed(1)}`).reverse();
  const band = `M${upper.join(' L')} L${lower.join(' L')} Z`;
  const line: string[] = [];
  if (fit && fit.t2star > 0) for (let i = 0; i <= 40; i++) { const t = (i / 40) * teMax; line.push(`${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(fit.s0 * Math.exp(-t / fit.t2star)).toFixed(1)}`); }
  return (
    <svg width={W} height={H} style={{ background: '#111', borderRadius: 4, marginTop: 8 }}>
      <line x1={ml} y1={mt} x2={ml} y2={H - mb} stroke="#555" />
      <line x1={ml} y1={H - mb} x2={W - mr} y2={H - mb} stroke="#555" />
      <path d={band} fill="#42a5f533" stroke="none" />
      {te.map((t, i) => <line key={'e' + i} x1={px(t)} y1={py(Math.max(mean[i] - sd[i], 0))} x2={px(t)} y2={py(mean[i] + sd[i])} stroke="#42a5f5" strokeWidth={1} />)}
      {line.length > 0 && <path d={line.join(' ')} fill="none" stroke="#ff7043" strokeWidth={1.5} />}
      {te.map((t, i) => <circle key={'p' + i} cx={px(t)} cy={py(mean[i])} r={2.4} fill="#90caf9" />)}
      <text x={ml} y={H - 6} fill="#888" fontSize={9}>0</text>
      <text x={W - mr} y={H - 6} fill="#888" fontSize={9} textAnchor="end">{teMax.toFixed(0)} ms (TE)</text>
      <text x={4} y={mt + 8} fill="#888" fontSize={9}>S</text>
    </svg>
  );
}

function _sectorPath(ri: number, ro: number, t0: number, t1: number, samples = 18): string {
  const p = (r: number, a: number): [number, number] => { const rad = (a * Math.PI) / 180; return [r * Math.cos(rad), -r * Math.sin(rad)]; };
  const pts: string[] = [];
  for (let s = 0; s <= samples; s++) { const [x, y] = p(ro, t0 + ((t1 - t0) * s) / samples); pts.push(`${x.toFixed(3)},${y.toFixed(3)}`); }
  if (ri > 0) for (let s = samples; s >= 0; s--) { const [x, y] = p(ri, t0 + ((t1 - t0) * s) / samples); pts.push(`${x.toFixed(3)},${y.toFixed(3)}`); }
  else pts.push('0,0');
  return 'M' + pts.join(' L') + ' Z';
}
function _labelPos(ri: number, ro: number, t0: number, t1: number): [number, number] {
  const r = ri === 0 ? 0.55 : (ri + ro) / 2;
  const a = (((t0 + t1) / 2) * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
}
function Bullseye({ stats }: { stats: Stats }) {
  return (
    <svg width="100%" viewBox="-3.4 -3.4 6.8 6.8" style={{ background: '#111', borderRadius: 4, marginTop: 8, maxHeight: 300 }}>
      {Object.entries(_GEOM).map(([k, g]) => {
        const s = +k, v = stats.perSeg[s]?.t2star ?? null;
        const [lx, ly] = _labelPos(g[0], g[1], g[2], g[3]);
        return (
          <g key={k}>
            <path d={_sectorPath(g[0], g[1], g[2], g[3])} fill={t2starColor(v)} stroke="#222" strokeWidth={0.02} />
            <text x={lx} y={ly} fontSize={0.24} fill="#000" textAnchor="middle" dominantBaseline="middle">{v == null ? 'N/D' : v.toFixed(0)}</text>
          </g>
        );
      })}
    </svg>
  );
}

const fmt = (st: Stat | undefined) => (!st || st.t2star == null ? 'N/D' : `${st.t2star.toFixed(1)} ± ${st.sd.toFixed(1)}`);

function StatsTable({ stats }: { stats: Stats }) {
  const cell: React.CSSProperties = { padding: '2px 6px', borderBottom: '1px solid #333' };
  const dot = (v: number | null | undefined) => (
    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: t2starColor(v ?? null), marginRight: 5 }} />
  );
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 6 }}>
      <thead>
        <tr style={{ color: '#9e9e9e', textAlign: 'left' }}>
          <th style={cell}>Segmento</th><th style={{ ...cell, textAlign: 'right' }}>T2* (ms)</th><th style={{ ...cell, textAlign: 'right' }}>n</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 16 }, (_, i) => i + 1).map(s => {
          const st = stats.perSeg[s];
          return (
            <tr key={s}>
              <td style={cell}>{dot(st?.t2star)}{s}. {st?.label || `seg ${s}`}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmt(st)}</td>
              <td style={{ ...cell, textAlign: 'right', color: '#9e9e9e' }}>{st?.n || 0}</td>
            </tr>
          );
        })}
        <tr style={{ fontWeight: 700, background: '#1a2733' }}>
          <td style={cell}>{dot(stats.septum.t2star)}Mid-ventricular septum (8+9)</td>
          <td style={{ ...cell, textAlign: 'right' }}>{fmt(stats.septum)}</td>
          <td style={{ ...cell, textAlign: 'right', color: '#9e9e9e' }}>{stats.septum.n}</td>
        </tr>
        <tr style={{ fontWeight: 700, background: '#1a2733' }}>
          <td style={cell}>{dot(stats.global.t2star)}Global myocardium</td>
          <td style={{ ...cell, textAlign: 'right' }}>{fmt(stats.global)}</td>
          <td style={{ ...cell, textAlign: 'right', color: '#9e9e9e' }}>{stats.global.n}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function VoxelPanel() {
  const { servicesManager, commandsManager, extensionManager } = useSystem();
  const { displaySetService, segmentationService } = servicesManager?.services || {};

  const cs = useMemo(() => {
    try {
      const { cornerstone, cornerstoneTools } = extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common').exports.getCornerstoneLibraries();
      return { cornerstone, cornerstoneTools };
    } catch (e) { return null; }
  }, [extensionManager]);

  const [active, setActive] = useState(false);
  const [curve, setCurve] = useState<Curve | null>(null);
  const [status, setStatus] = useState<string>('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsMsg, setStatsMsg] = useState<string>('');

  const fetchStats = useCallback(() => {
    // scope sulla serie T2* SORGENTE attiva -> mostra i valori di QUELLA sequenza (piu' sequenze
    // multi-echo per studio hanno risultati separati). Fallback: studio (retro-compat).
    const src = getActiveSource(servicesManager);
    const url = src
      ? `/api/studies/${encodeURIComponent(src.study)}/segments?source_series=${encodeURIComponent(src.series)}`
      : (studyUID() ? `/api/studies/${studyUID()}/segments` : null);
    if (!url) return;
    setStatsMsg('caricamento valori analisi…');
    fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(d => {
        const perSeg: Record<number, SegStat> = {};
        d.per_segment.forEach((x: any) => { perSeg[x.seg] = { t2star: x.t2star, sd: x.sd, n: x.n, label: x.label }; });
        setStats({ perSeg, septum: d.aggregates.septum_mid, global: d.aggregates.global });
        setStatsMsg('');
      })
      .catch(() => { setStats(null); setStatsMsg('nessuna analisi per questa serie — esegui "Analizza T2*"'); });
  }, [servicesManager]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // ricarica i valori quando l'utente cambia serie/viewport (risultati di un'altra sequenza)
  useEffect(() => {
    const { viewportGridService, displaySetService } = servicesManager?.services || {};
    const subs: any[] = [];
    try {
      const vg = viewportGridService;
      [vg?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED, vg?.EVENTS?.GRID_STATE_CHANGED]
        .filter(Boolean).forEach((ev: string) => subs.push(vg.subscribe(ev, fetchStats)));
      const ds = displaySetService;
      [ds?.EVENTS?.DISPLAY_SETS_ADDED, ds?.EVENTS?.DISPLAY_SETS_CHANGED]
        .filter(Boolean).forEach((ev: string) => subs.push(ds.subscribe(ev, fetchStats)));
    } catch (e) { /* */ }
    return () => subs.forEach(s => s?.unsubscribe?.());
  }, [servicesManager, fetchStats]);

  const setActiveTool = useCallback((tool: 'WindowLevel' | 'Probe') => {
    const { toolGroupService, viewportGridService } = servicesManager.services;
    const tg = toolGroupService.getToolGroupForViewport(viewportGridService.getState().activeViewportId);
    commandsManager.run('setToolActive', { toolName: tool, toolGroupId: tg?.id });
  }, [commandsManager, servicesManager]);

  const toggle = useCallback(() => {
    if (active) { setActive(false); setActiveTool('WindowLevel'); setStatus('W/L attivo'); }
    else { setActive(true); setActiveTool('Probe'); setStatus('clic su un voxel dentro la segmentazione…'); }
  }, [active, setActiveTool]);

  useEffect(() => {
    if (!cs) return;
    const eventTarget = cs.cornerstone.eventTarget;
    const EVT = cs.cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED;
    const handler = async (evt: any) => {
      const ann = evt?.detail?.annotation;
      if (!ann || ann?.metadata?.toolName !== 'Probe') return;
      try {
        const st = cs.cornerstoneTools.annotation.state;
        st.getAllAnnotations().forEach((a: any) => { if (a?.metadata?.toolName === 'Probe' && a.annotationUID !== ann.annotationUID) st.removeAnnotation(a.annotationUID); });
        cs.cornerstone.getRenderingEngines?.().forEach((re: any) => re.render());
      } catch (e) { /* best-effort */ }
      // stessa serie sorgente (viewport 1) usata per le statistiche -> nessun conflitto col
      // viewport 2 (mappa). Fallback al vecchio criterio se non disponibile.
      const t2ds = getSourceDisplaySet(servicesManager) || findT2starDisplaySet(displaySetService);
      if (!t2ds) { setStatus('serie T2* multi-echo non trovata'); return; }
      const segs = segmentationService?.getSegmentations?.() || [];
      if (!segs.length) { setStatus('segmentazione non caricata'); return; }
      try {
        const r = await readCurve(ann.data?.handles?.points?.[0], cs, t2ds, segs[0].segmentationId);
        if (!r) { setStatus('lettura non riuscita'); return; }
        if (r.outside) { setCurve(null); setStatus('voxel FUORI dalla segmentazione — scegline uno dentro'); return; }
        setCurve(r.curve || null); setStatus('');
      } catch (e: any) { setStatus('errore lettura: ' + (e?.message || e)); }
    };
    eventTarget.addEventListener(EVT, handler);
    return () => eventTarget.removeEventListener(EVT, handler);
  }, [cs, displaySetService, segmentationService]);

  const seg = curve ? stats?.perSeg[curve.segIdx] : undefined;
  const btn = (bg: string): React.CSSProperties => ({ width: '100%', padding: '9px', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, color: '#fff', background: bg });

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Parte 1: selezione segmento */}
      <button onClick={toggle} style={btn(active ? '#1565c0' : '#37474f')}>
        {active ? 'Selezione attiva — clic su un segmento' : 'Seleziona segmento'}
      </button>
      {status && <div style={{ marginTop: 8, color: status.includes('FUORI') ? '#e57373' : '#90caf9' }}>{status}</div>}
      {curve && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#ffb74d', fontWeight: 600 }}>{seg?.label || `Segmento AHA ${curve.segIdx}`}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>T2* (analisi):&nbsp;<b style={{ color: '#ff8a65' }}>{fmt(seg)} ms</b></span>
            <span style={{ color: '#9e9e9e' }}>n={seg?.n ?? '—'}</span>
          </div>
          <div style={{ color: '#9e9e9e', marginTop: 2 }}>curva media ± SD del segnale (dai voxel del segmento)</div>
          <DecayPlot curve={curve} />
        </div>
      )}

      {/* Parte 2: bullseye + tabella (valori dall'analisi) */}
      <div style={{ marginTop: 12, borderTop: '1px solid #333', paddingTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: '#9e9e9e' }}>Bullseye T2* — rosso &lt;10 · verde ≥30</span>
          <button onClick={fetchStats} style={{ padding: '3px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', background: '#37474f', fontSize: 11 }}>Aggiorna</button>
        </div>
        {stats ? (
          <>
            <Bullseye stats={stats} />
            <StatsTable stats={stats} />
            <div style={{ color: '#777', marginTop: 6, fontSize: 10 }}>T2* corretto dall'analisi (media ± SD, CV&lt;10%).</div>
          </>
        ) : (
          <div style={{ marginTop: 8, color: '#90caf9' }}>{statsMsg}</div>
        )}
      </div>
    </div>
  );
}
