import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSystem } from '@ohif/core/src';

// Pannello CardioMap (riquadro 4). Due parti:
//  1) Selezione segmento: clic su un voxel DENTRO la segmentazione -> segmento AHA -> curva
//     media +-SD dei 10 echi (variabilita') + T2* del segmento (media dei T2* per-voxel).
//  2) Statistiche: bullseye T2* live (SVG) + tabella per-segmento (stile referto) con due ROI
//     aggregate: Setto medio (8+9) e Miocardio globale.
// T2* per-voxel = fit log-lineare del singolo voxel (TUTTI i voxel, nessun filtro CV).
//
// Usa le istanze cornerstone CONDIVISE di @ohif/extension-cornerstone (getCornerstoneLibraries):
// import diretti di '@cornerstonejs/*' creerebbero istanze duplicate (tool morto, eventi persi).

type Slice = { id: string; te: number; ipp: number[]; iop: number[]; rows: number; cols: number; d: number };
type Fit = { t2star: number; s0: number };
type Sample = {
  te: number[]; mean: number[]; sd: number[]; fit: Fit | null;
  label: string; nVox: number; t2mean: number | null; t2sd: number;
};
type Stat = { t2star: number | null; sd: number; n: number };
type Stats = { perSeg: Record<number, Stat>; septum: Stat; global: Stat; labels: Record<number, string> };

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Scala colori clinica T2* (ms), coerente col bullseye PNG del referto:
// rosso <10 -> arancio 20 -> giallo 30 -> verde >=30 (normale).
const _hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const _lerp = (a: number[], b: number[], t: number) =>
  `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
const _STOPS: [number, string][] = [[0, '#e53935'], [10, '#e53935'], [20, '#fb8c00'], [30, '#fdd835']];
function t2starColor(v: number | null): string {
  if (v == null || !isFinite(v)) return '#616161';
  if (v >= 30) return '#43a047';
  let a = _STOPS[0], b = _STOPS[_STOPS.length - 1];
  for (let i = 0; i < _STOPS.length - 1; i++) {
    if (v >= _STOPS[i][0] && v <= _STOPS[i + 1][0]) { a = _STOPS[i]; b = _STOPS[i + 1]; break; }
  }
  const t = (v - a[0]) / ((b[0] - a[0]) || 1);
  return _lerp(_hex(a[1]), _hex(b[1]), t);
}

// Geometria AHA-16: seg -> [r_in, r_out, theta0_deg, theta1_deg] (0=destra, CCW, y in alto).
const _GEOM: Record<number, [number, number, number, number]> = {
  1: [2, 3, 60, 120], 2: [2, 3, 120, 180], 3: [2, 3, 180, 240], 4: [2, 3, 240, 300], 5: [2, 3, 300, 360], 6: [2, 3, 0, 60],
  7: [1, 2, 60, 120], 8: [1, 2, 120, 180], 9: [1, 2, 180, 240], 10: [1, 2, 240, 300], 11: [1, 2, 300, 360], 12: [1, 2, 0, 60],
  13: [0, 1, 45, 135], 14: [0, 1, 135, 225], 15: [0, 1, 225, 315], 16: [0, 1, 315, 405],
};

function findT2starDisplaySet(displaySetService: any) {
  const dss = displaySetService?.getActiveDisplaySets?.() || [];
  return dss.find(
    (ds: any) =>
      ds?.Modality === 'MR' &&
      /t2star/i.test(ds?.SeriesDescription || '') &&
      ((ds?.imageIds?.length || 0) >= 20 || (ds?.images?.length || 0) >= 20)
  );
}

function echoMetas(ds: any, metaData: any): Slice[] {
  const ids: string[] = ds?.imageIds || (ds?.images || []).map((i: any) => i.imageId);
  return (ids || [])
    .map((id: string) => {
      const inst: any = metaData.get('instance', id) || {};
      return {
        id, te: Number(inst.EchoTime),
        ipp: (inst.ImagePositionPatient || []).map(Number),
        iop: (inst.ImageOrientationPatient || []).map(Number),
        rows: Number(inst.Rows), cols: Number(inst.Columns), d: 0,
      } as Slice;
    })
    .filter(m => m.ipp.length === 3 && m.iop.length === 6 && isFinite(m.te));
}

function pickSlice(metas: Slice[], world: number[]): Slice[] | null {
  if (!metas.length || !world) return null;
  const iop = metas[0].iop;
  const n = cross(iop.slice(0, 3), iop.slice(3, 6));
  metas.forEach(m => (m.d = dot(m.ipp, n)));
  const wd = dot(world, n);
  let bestD = metas[0].d;
  let bestDist = Infinity;
  metas.forEach(m => { const dist = Math.abs(m.d - wd); if (dist < bestDist) { bestDist = dist; bestD = m.d; } });
  const slice = metas.filter(m => Math.abs(m.d - bestD) < 0.5).sort((a, b) => a.te - b.te);
  return slice.length >= 2 ? slice : null;
}

// T2* di un singolo voxel (log-lineare non pesato). null se non fittabile (decadimento assente).
function voxelT2star(sig: number[], te: number[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < te.length; i++) if (sig[i] > 0) { xs.push(te[i]); ys.push(Math.log(sig[i])); }
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return null;
  const slope = (n * sxy - sx * sy) / d;
  if (slope >= 0) return null;
  const t2 = -1 / slope;
  return isFinite(t2) && t2 > 0 ? t2 : null;
}

function meanSd(vals: number[]): Stat {
  const n = vals.length;
  if (!n) return { t2star: null, sd: 0, n: 0 };
  const mean = vals.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n);
  return { t2star: mean, sd, n };
}

// Fit log-lineare pesato S^2 sulla curva MEDIA (per la linea di fit nel grafico).
function fitMeanDecay(te: number[], sig: number[]): Fit | null {
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (let i = 0; i < te.length; i++) if (sig[i] > 0) { xs.push(te[i]); ys.push(Math.log(sig[i])); ws.push(sig[i] * sig[i]); }
  if (xs.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < xs.length; i++) { const w = ws[i]; sw += w; swx += w * xs[i]; swy += w * ys[i]; swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i]; }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  const intercept = (swy - slope * swx) / sw;
  if (slope >= 0) return null;
  return { t2star: -1 / slope, s0: Math.exp(intercept) };
}

// Raccoglie i voxel di ogni slice del labelmap: chiama cb(segIdx, echoSignal[]) per voxel miocardico.
async function scanMyocardium(
  cs: any, t2ds: any, labelVol: any,
  cb: (seg: number, sig: number[], te: number[]) => void
): Promise<void> {
  const [nx, ny, nz] = labelVol.dimensions;
  const vm = labelVol.voxelManager;
  const metas = echoMetas(t2ds, cs.cornerstone.metaData);
  for (let k = 0; k < nz; k++) {
    const worldC = labelVol.imageData.indexToWorld([Math.floor(nx / 2), Math.floor(ny / 2), k]);
    const slice = pickSlice(metas, Array.from(worldC) as number[]);
    if (!slice) continue;
    const cols = slice[0].cols;
    const te = slice.map((m: Slice) => m.te);
    const imgs = await Promise.all(slice.map((m: Slice) => cs.cornerstone.imageLoader.loadAndCacheImage(m.id)));
    const pds = imgs.map((img: any) => img.getPixelData());
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const s = vm.getAtIJK(i, j, k);
      if (s >= 1 && s <= 16) {
        const off = j * cols + i;
        cb(s, pds.map((pd: any) => Number(pd[off])), te);
      }
    }
  }
}

// Selezione: media +-SD del decadimento sul segmento cliccato + T2* per-voxel (media +-SD).
async function readSegment(
  world: number[], cs: any, t2ds: any, segId: string, labelOf: (s: number) => string
): Promise<{ outside?: boolean; sample?: Sample } | null> {
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
  const voxT2: number[] = [];
  for (let j = 0; j < ny && j < rows; j++) for (let i = 0; i < nx && i < cols; i++) {
    if (vm.getAtIJK(i, j, k) === segIdx) {
      const off = j * cols + i;
      const sig = pds.map((pd: any) => Number(pd[off]));
      sig.forEach((x, e) => perEcho[e].push(x));
      const t2 = voxelT2star(sig, te);
      if (t2 != null) voxT2.push(t2);
    }
  }
  const nVox = perEcho[0].length;
  if (!nVox) return { outside: true };
  const mean = perEcho.map(v => v.reduce((s, x) => s + x, 0) / v.length);
  const sd = perEcho.map((v, e) => { const mu = mean[e]; return Math.sqrt(v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / v.length); });
  const t2ms = meanSd(voxT2);
  return {
    sample: {
      te, mean, sd, fit: fitMeanDecay(te, mean), label: labelOf(segIdx),
      nVox, t2mean: t2ms.t2star, t2sd: t2ms.sd,
    },
  };
}

// Statistiche complete: T2* per-voxel per ogni segmento + aggregate Setto(8+9) e Globale.
async function computeStats(cs: any, t2ds: any, segId: string, labelOf: (s: number) => string): Promise<Stats | null> {
  const segUtils = cs.cornerstoneTools.utilities.segmentation;
  const labelVol = segUtils.getOrCreateSegmentationVolume(segId);
  if (!labelVol) return null;
  const perVox: Record<number, number[]> = {};
  await scanMyocardium(cs, t2ds, labelVol, (s, sig, te) => {
    const t2 = voxelT2star(sig, te);
    if (t2 != null) (perVox[s] = perVox[s] || []).push(t2);
  });
  const perSeg: Record<number, Stat> = {};
  const all: number[] = [];
  const sept: number[] = [];
  const labels: Record<number, string> = {};
  for (let s = 1; s <= 16; s++) {
    const v = perVox[s] || [];
    perSeg[s] = meanSd(v);
    labels[s] = labelOf(s);
    all.push(...v);
    if (s === 8 || s === 9) sept.push(...v);
  }
  return { perSeg, septum: meanSd(sept), global: meanSd(all), labels };
}

function DecayPlot({ sample }: { sample: Sample }) {
  const W = 264, H = 150, ml = 34, mr = 8, mt = 8, mb = 22;
  const { te, mean, sd, fit } = sample;
  const teMax = Math.max(...te, 1);
  const sMax = Math.max(...mean.map((m, i) => m + sd[i]), 1);
  const px = (t: number) => ml + (t / teMax) * (W - ml - mr);
  const py = (s: number) => H - mb - (s / sMax) * (H - mt - mb);
  const upper = te.map((t, i) => `${px(t).toFixed(1)},${py(mean[i] + sd[i]).toFixed(1)}`);
  const lower = te.map((t, i) => `${px(t).toFixed(1)},${py(Math.max(mean[i] - sd[i], 0)).toFixed(1)}`).reverse();
  const band = `M${upper.join(' L')} L${lower.join(' L')} Z`;
  const curve: string[] = [];
  if (fit && fit.t2star > 0) for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * teMax;
    curve.push(`${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(fit.s0 * Math.exp(-t / fit.t2star)).toFixed(1)}`);
  }
  return (
    <svg width={W} height={H} style={{ background: '#111', borderRadius: 4, marginTop: 8 }}>
      <line x1={ml} y1={mt} x2={ml} y2={H - mb} stroke="#555" />
      <line x1={ml} y1={H - mb} x2={W - mr} y2={H - mb} stroke="#555" />
      <path d={band} fill="#42a5f533" stroke="none" />
      {te.map((t, i) => (
        <line key={'e' + i} x1={px(t)} y1={py(Math.max(mean[i] - sd[i], 0))} x2={px(t)} y2={py(mean[i] + sd[i])} stroke="#42a5f5" strokeWidth={1} />
      ))}
      {curve.length > 0 && <path d={curve.join(' ')} fill="none" stroke="#ff7043" strokeWidth={1.5} />}
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
        const s = +k;
        const v = stats.perSeg[s]?.t2star ?? null;
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

const short = (full: string, s: number) => (full || '').replace(/^AHA\s*\d+\s*-\s*/i, '') || `seg ${s}`;
const fmt = (st: Stat) => (st.t2star == null ? 'N/D' : `${st.t2star.toFixed(1)} ± ${st.sd.toFixed(1)}`);

function StatsTable({ stats }: { stats: Stats }) {
  const cell: React.CSSProperties = { padding: '2px 6px', borderBottom: '1px solid #333' };
  const dot = (v: number | null) => (
    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: t2starColor(v), marginRight: 5 }} />
  );
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 6 }}>
      <thead>
        <tr style={{ color: '#9e9e9e', textAlign: 'left' }}>
          <th style={cell}>Segmento</th><th style={{ ...cell, textAlign: 'right' }}>T2* (ms)</th><th style={{ ...cell, textAlign: 'right' }}>n</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 16 }, (_, i) => i + 1).map(s => (
          <tr key={s}>
            <td style={cell}>{dot(stats.perSeg[s]?.t2star ?? null)}{s}. {short(stats.labels[s], s)}</td>
            <td style={{ ...cell, textAlign: 'right' }}>{fmt(stats.perSeg[s])}</td>
            <td style={{ ...cell, textAlign: 'right', color: '#9e9e9e' }}>{stats.perSeg[s]?.n || 0}</td>
          </tr>
        ))}
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
      const mod = extensionManager.getModuleEntry('@ohif/extension-cornerstone.utilityModule.common');
      const { cornerstone, cornerstoneTools } = mod.exports.getCornerstoneLibraries();
      return { cornerstone, cornerstoneTools };
    } catch (e) { return null; }
  }, [extensionManager]);

  const [active, setActive] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [status, setStatus] = useState<string>('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [computing, setComputing] = useState(false);

  const setActiveTool = useCallback((tool: 'WindowLevel' | 'Probe') => {
    const { toolGroupService, viewportGridService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    const tg = toolGroupService.getToolGroupForViewport(activeViewportId);
    commandsManager.run('setToolActive', { toolName: tool, toolGroupId: tg?.id });
  }, [commandsManager, servicesManager]);

  const toggle = useCallback(() => {
    if (active) { setActive(false); setActiveTool('WindowLevel'); setStatus('W/L attivo'); }
    else { setActive(true); setActiveTool('Probe'); setStatus('clic su un voxel dentro la segmentazione…'); }
  }, [active, setActiveTool]);

  const segLabelOf = useCallback(() => {
    const segs = segmentationService?.getSegmentations?.() || [];
    return { segs, labelOf: (s: number) => segs[0]?.segments?.[s]?.label || `Segmento AHA ${s}` };
  }, [segmentationService]);

  const computeAll = useCallback(async () => {
    if (!cs) return;
    const t2ds = findT2starDisplaySet(displaySetService);
    const { segs, labelOf } = segLabelOf();
    if (!t2ds || !segs.length) { setStatus('serie T2* o segmentazione mancante'); return; }
    setComputing(true); setStatus('calcolo statistiche…');
    try {
      const res = await computeStats(cs, t2ds, segs[0].segmentationId, labelOf);
      setStats(res); setStatus('');
    } catch (e: any) { setStatus('errore statistiche: ' + (e?.message || e)); }
    finally { setComputing(false); }
  }, [cs, displaySetService, segLabelOf]);

  useEffect(() => {
    if (!cs) return;
    const eventTarget = cs.cornerstone.eventTarget;
    const EVT = cs.cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED;
    const handler = async (evt: any) => {
      const ann = evt?.detail?.annotation;
      if (!ann || ann?.metadata?.toolName !== 'Probe') return;
      try {
        const state = cs.cornerstoneTools.annotation.state;
        state.getAllAnnotations().forEach((a: any) => {
          if (a?.metadata?.toolName === 'Probe' && a.annotationUID !== ann.annotationUID) state.removeAnnotation(a.annotationUID);
        });
        cs.cornerstone.getRenderingEngines?.().forEach((re: any) => re.render());
      } catch (e) { /* best-effort */ }
      const t2ds = findT2starDisplaySet(displaySetService);
      if (!t2ds) { setStatus('serie T2* multi-echo non trovata'); return; }
      const { segs, labelOf } = segLabelOf();
      if (!segs.length) { setStatus('segmentazione non caricata'); return; }
      try {
        const r = await readSegment(ann.data?.handles?.points?.[0], cs, t2ds, segs[0].segmentationId, labelOf);
        if (!r) { setStatus('lettura non riuscita'); return; }
        if (r.outside) { setSample(null); setStatus('voxel FUORI dalla segmentazione — scegline uno dentro'); return; }
        setSample(r.sample || null); setStatus('');
      } catch (e: any) { setStatus('errore lettura: ' + (e?.message || e)); }
    };
    eventTarget.addEventListener(EVT, handler);
    return () => eventTarget.removeEventListener(EVT, handler);
  }, [cs, displaySetService, segLabelOf]);

  const btn = (bg: string): React.CSSProperties => ({
    width: '100%', padding: '9px', border: 'none', borderRadius: 6, cursor: 'pointer',
    fontWeight: 600, color: '#fff', background: bg,
  });

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      {/* Parte 1: selezione segmento */}
      <button onClick={toggle} style={btn(active ? '#1565c0' : '#37474f')}>
        {active ? 'Selezione attiva — clic su un segmento' : 'Seleziona segmento'}
      </button>
      {status && <div style={{ marginTop: 8, color: status.includes('FUORI') ? '#e57373' : '#90caf9' }}>{status}</div>}
      {sample && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#ffb74d', fontWeight: 600 }}>{sample.label}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>T2*:&nbsp;<b style={{ color: '#ff8a65' }}>
              {sample.t2mean == null ? '—' : `${sample.t2mean.toFixed(1)} ± ${sample.t2sd.toFixed(1)}`} ms</b></span>
            <span style={{ color: '#9e9e9e' }}>{sample.nVox} voxel</span>
          </div>
          <div style={{ color: '#9e9e9e', marginTop: 2 }}>curva media ± SD (banda = variabilita' del segnale)</div>
          <DecayPlot sample={sample} />
        </div>
      )}

      {/* Parte 2: statistiche (bullseye + tabella) */}
      <div style={{ marginTop: 12, borderTop: '1px solid #333', paddingTop: 10 }}>
        <button onClick={computeAll} disabled={computing} style={btn(computing ? '#455a64' : '#37474f')}>
          {computing ? 'Calcolo…' : 'Calcola T2* (bullseye + tabella)'}
        </button>
        {stats && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: '#9e9e9e' }}>Bullseye T2* (media per segmento, ms) — rosso &lt;10 · verde ≥30</div>
            <Bullseye stats={stats} />
            <StatsTable stats={stats} />
            <div style={{ color: '#777', marginTop: 6, fontSize: 10 }}>
              media ± SD dei T2* per-voxel (log-lineare, tutti i voxel, nessun filtro CV).
            </div>
          </div>
        )}
      </div>

      {!sample && !stats && !status && (
        <div style={{ marginTop: 10, color: '#777' }}>
          Premi <b>Seleziona segmento</b> per la curva di un segmento, o <b>Calcola T2*</b> per bullseye + tabella.
        </div>
      )}
    </div>
  );
}
