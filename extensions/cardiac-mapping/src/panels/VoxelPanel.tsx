import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSystem } from '@ohif/core/src';

// Pannello "fit 4D delle ROI": clic (Punto/ROI) sul viewport -> legge il segnale dei 10 echi
// dal volume T2* multi-echo, fitta mono-esponenziale (log-lineare pesato S^2) e mostra
// curva + T2*(ms) e CV%. Tutto client-side: nessun roundtrip, legge le immagini gia' in cache.
//
// IMPORTANTE: usa le istanze cornerstone CONDIVISE esposte da @ohif/extension-cornerstone
// (getCornerstoneLibraries). Importare '@cornerstonejs/*' direttamente qui crea istanze
// duplicate -> il tool non si attiva e gli eventi (eventTarget) non arrivano.

type Slice = { id: string; te: number; ipp: number[]; iop: number[]; rows: number; cols: number; d: number };
type Fit = { t2star: number; s0: number; cv: number; n: number };
type Sample = { te: number[]; sig: number[]; fit: Fit | null; where: string };

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function findT2starDisplaySet(displaySetService: any) {
  const dss = displaySetService?.getActiveDisplaySets?.() || [];
  // multi-echo T2*: MR, descrizione con "T2Star", >=20 immagini (3 slice x 10 echi)
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
        id,
        te: Number(inst.EchoTime),
        ipp: (inst.ImagePositionPatient || []).map(Number),
        iop: (inst.ImageOrientationPatient || []).map(Number),
        rows: Number(inst.Rows),
        cols: Number(inst.Columns),
        d: 0,
      } as Slice;
    })
    .filter(m => m.ipp.length === 3 && m.iop.length === 6 && isFinite(m.te));
}

// Seleziona la slice (10 echi) piu' vicina al punto mondo; ritorna gli echi ordinati per TE.
function pickSlice(metas: Slice[], world: number[]): Slice[] | null {
  if (!metas.length || !world) return null;
  const iop = metas[0].iop;
  const n = cross(iop.slice(0, 3), iop.slice(3, 6));
  metas.forEach(m => (m.d = dot(m.ipp, n)));
  const wd = dot(world, n);
  let bestD = metas[0].d;
  let bestDist = Infinity;
  metas.forEach(m => {
    const dist = Math.abs(m.d - wd);
    if (dist < bestDist) {
      bestDist = dist;
      bestD = m.d;
    }
  });
  const slice = metas.filter(m => Math.abs(m.d - bestD) < 0.5).sort((a, b) => a.te - b.te);
  return slice.length >= 2 ? slice : null;
}

// Fit mono-esponenziale log-lineare pesato (peso S^2 ~ approssima il fit non lineare).
function fitT2star(te: number[], sig: number[]): Fit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (let i = 0; i < te.length; i++) {
    if (sig[i] > 0) {
      xs.push(te[i]);
      ys.push(Math.log(sig[i]));
      ws.push(sig[i] * sig[i]);
    }
  }
  if (xs.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    sw += w; swx += w * xs[i]; swy += w * ys[i];
    swxx += w * xs[i] * xs[i]; swxy += w * xs[i] * ys[i];
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (sw * swxy - swx * swy) / denom;
  const intercept = (swy - slope * swx) / sw;
  if (slope >= 0) return null; // decadimento atteso (slope < 0)
  const t2star = -1 / slope; // ms (TE in ms)
  const s0 = Math.exp(intercept);
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ssr += ws[i] * r * r;
  }
  const dof = Math.max(xs.length - 2, 1);
  const varSlope = (ssr / dof) * (sw / denom);
  const seSlope = Math.sqrt(Math.max(varSlope, 0));
  const cv = Math.abs(seSlope / slope) * 100;
  return { t2star, s0, cv, n: xs.length };
}

async function readProbe(ds: any, world: number[], cs: any): Promise<Sample | null> {
  const slice = pickSlice(echoMetas(ds, cs.metaData), world);
  if (!slice) return null;
  const [cx, cy] = cs.utilities.worldToImageCoords(slice[0].id, world) as number[];
  const col = Math.round(cx);
  const row = Math.round(cy);
  if (col < 0 || row < 0 || col >= slice[0].cols || row >= slice[0].rows) return null;
  const imgs = await Promise.all(slice.map(m => cs.imageLoader.loadAndCacheImage(m.id)));
  const te: number[] = [];
  const sig: number[] = [];
  imgs.forEach((img: any, k: number) => {
    const pd = img.getPixelData();
    te.push(slice[k].te);
    sig.push(Number(pd[row * slice[k].cols + col]));
  });
  return { te, sig, fit: fitT2star(te, sig), where: `voxel (${col}, ${row})` };
}

async function readRoi(ds: any, ann: any, cs: any): Promise<Sample | null> {
  const pts: number[][] = ann?.data?.handles?.points || [];
  if (pts.length < 3) return null;
  const center = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const slice = pickSlice(echoMetas(ds, cs.metaData), center);
  if (!slice) return null;
  const id0 = slice[0].id;
  const [ccx, ccy] = cs.utilities.worldToImageCoords(id0, center) as number[];
  let ax = 1, ay = 1;
  pts.forEach(p => {
    const [px, py] = cs.utilities.worldToImageCoords(id0, p) as number[];
    ax = Math.max(ax, Math.abs(px - ccx));
    ay = Math.max(ay, Math.abs(py - ccy));
  });
  const cols = slice[0].cols;
  const rows = slice[0].rows;
  const x0 = Math.max(0, Math.floor(ccx - ax));
  const x1 = Math.min(cols - 1, Math.ceil(ccx + ax));
  const y0 = Math.max(0, Math.floor(ccy - ay));
  const y1 = Math.min(rows - 1, Math.ceil(ccy + ay));
  const imgs = await Promise.all(slice.map(m => cs.imageLoader.loadAndCacheImage(m.id)));
  const te: number[] = [];
  const sig: number[] = [];
  let nPix = 0;
  imgs.forEach((img: any, k: number) => {
    const pd = img.getPixelData();
    let sum = 0;
    let cnt = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - ccx) / ax;
        const ny = (y - ccy) / ay;
        if (nx * nx + ny * ny <= 1) {
          sum += Number(pd[y * cols + x]);
          cnt++;
        }
      }
    }
    te.push(slice[k].te);
    sig.push(cnt ? sum / cnt : 0);
    nPix = cnt;
  });
  return { te, sig, fit: fitT2star(te, sig), where: `ROI (${nPix} voxel)` };
}

function DecayPlot({ sample }: { sample: Sample }) {
  const W = 264, H = 150, ml = 34, mr = 8, mt = 8, mb = 22;
  const { te, sig, fit } = sample;
  const teMax = Math.max(...te, 1);
  const sMax = Math.max(...sig, 1);
  const px = (t: number) => ml + (t / teMax) * (W - ml - mr);
  const py = (s: number) => H - mb - (s / sMax) * (H - mt - mb);
  const curve: string[] = [];
  if (fit && fit.t2star > 0) {
    for (let i = 0; i <= 40; i++) {
      const t = (i / 40) * teMax;
      const s = fit.s0 * Math.exp(-t / fit.t2star);
      curve.push(`${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(s).toFixed(1)}`);
    }
  }
  return (
    <svg width={W} height={H} style={{ background: '#111', borderRadius: 4, marginTop: 8 }}>
      <line x1={ml} y1={mt} x2={ml} y2={H - mb} stroke="#555" />
      <line x1={ml} y1={H - mb} x2={W - mr} y2={H - mb} stroke="#555" />
      {curve.length > 0 && <path d={curve.join(' ')} fill="none" stroke="#ff7043" strokeWidth={1.5} />}
      {te.map((t, i) => (
        <circle key={i} cx={px(t)} cy={py(sig[i])} r={2.5} fill="#42a5f5" />
      ))}
      <text x={ml} y={H - 6} fill="#888" fontSize={9}>0</text>
      <text x={W - mr} y={H - 6} fill="#888" fontSize={9} textAnchor="end">{teMax.toFixed(0)} ms (TE)</text>
      <text x={4} y={mt + 8} fill="#888" fontSize={9}>S</text>
    </svg>
  );
}

export default function VoxelPanel() {
  const { servicesManager, commandsManager, extensionManager } = useSystem();
  const displaySetService = servicesManager?.services?.displaySetService;

  // istanze cornerstone CONDIVISE con OHIF (stesso eventTarget/registry dei tool)
  const cs = useMemo(() => {
    try {
      const mod = extensionManager.getModuleEntry(
        '@ohif/extension-cornerstone.utilityModule.common'
      );
      const { cornerstone, cornerstoneTools } = mod.exports.getCornerstoneLibraries();
      return { cornerstone, cornerstoneTools };
    } catch (e) {
      return null;
    }
  }, [extensionManager]);

  const [mode, setMode] = useState<'off' | 'Probe' | 'EllipticalROI'>('off');
  const [sample, setSample] = useState<Sample | null>(null);
  const [status, setStatus] = useState<string>('');

  const setActiveTool = useCallback(
    (tool: 'WindowLevel' | 'Probe' | 'EllipticalROI') => {
      const { toolGroupService, viewportGridService } = servicesManager.services;
      const { activeViewportId } = viewportGridService.getState();
      const tg = toolGroupService.getToolGroupForViewport(activeViewportId);
      commandsManager.run('setToolActive', { toolName: tool, toolGroupId: tg?.id });
    },
    [commandsManager, servicesManager]
  );

  const toggle = useCallback(
    (tool: 'Probe' | 'EllipticalROI') => {
      if (mode === tool) {
        setMode('off');
        setActiveTool('WindowLevel');
        setStatus('W/L attivo');
      } else {
        setMode(tool);
        setActiveTool(tool);
        setStatus(tool === 'Probe' ? 'clic su un voxel…' : 'traccia una ROI…');
      }
    },
    [mode, setActiveTool]
  );

  useEffect(() => {
    if (!cs) return;
    const eventTarget = cs.cornerstone.eventTarget;
    const EVT = cs.cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED;
    const handler = async (evt: any) => {
      const ann = evt?.detail?.annotation;
      const name = ann?.metadata?.toolName;
      if (!ann || (name !== 'Probe' && name !== 'EllipticalROI')) return;
      const ds = findT2starDisplaySet(displaySetService);
      if (!ds) { setStatus('serie T2* multi-echo non trovata'); return; }
      try {
        const r = name === 'Probe'
          ? await readProbe(ds, ann.data?.handles?.points?.[0], cs.cornerstone)
          : await readRoi(ds, ann, cs.cornerstone);
        if (!r) { setStatus('punto fuori dalla mappa'); return; }
        setSample(r);
        setStatus('');
      } catch (e: any) {
        setStatus('errore lettura: ' + (e?.message || e));
      }
    };
    eventTarget.addEventListener(EVT, handler);
    return () => eventTarget.removeEventListener(EVT, handler);
  }, [cs, displaySetService]);

  const btn = (active: boolean) => ({
    flex: 1, padding: '8px', border: 'none', borderRadius: 6, cursor: 'pointer',
    fontWeight: 600, color: '#fff', background: active ? '#1565c0' : '#37474f',
  });

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn(mode === 'Probe')} onClick={() => toggle('Probe')}>Punto</button>
        <button style={btn(mode === 'EllipticalROI')} onClick={() => toggle('EllipticalROI')}>ROI</button>
      </div>
      {status && <div style={{ marginTop: 8, color: '#90caf9' }}>{status}</div>}
      {sample && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>T2*:&nbsp;<b style={{ color: '#ff8a65' }}>
              {sample.fit ? sample.fit.t2star.toFixed(1) : '—'} ms</b></span>
            <span>CV:&nbsp;<b style={{ color: sample.fit && sample.fit.cv < 10 ? '#81c784' : '#e57373' }}>
              {sample.fit ? sample.fit.cv.toFixed(1) : '—'}%</b></span>
          </div>
          <div style={{ color: '#9e9e9e', marginTop: 2 }}>
            {sample.where} · {sample.fit ? sample.fit.n : 0}/{sample.te.length} echi
          </div>
          <DecayPlot sample={sample} />
        </div>
      )}
      {!sample && !status && (
        <div style={{ marginTop: 10, color: '#777' }}>
          Seleziona <b>Punto</b> o <b>ROI</b>, poi clicca sul riquadro mappa: curva dei 10 echi + T2*/CV.
        </div>
      )}
    </div>
  );
}
