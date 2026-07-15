import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSystem } from '@ohif/core/src';

// Pannello "fit del segmento AHA": clic su un voxel DENTRO la segmentazione -> individua il
// segmento AHA (1..16) che lo contiene, media il segnale dei 10 echi su TUTTI i voxel del
// segmento (senza filtro CV), fitta la media (mono-esponenziale log-lineare pesato S^2) e
// mostra T2*(ms) + curva media con bande +-SD (variabilita' nel segmento).
// Clic FUORI dalla segmentazione -> non consentito. Una selezione alla volta.
//
// Usa le istanze cornerstone CONDIVISE di @ohif/extension-cornerstone (getCornerstoneLibraries):
// import diretti di '@cornerstonejs/*' creerebbero istanze duplicate (tool morto, eventi persi).

type Slice = { id: string; te: number; ipp: number[]; iop: number[]; rows: number; cols: number; d: number };
type Fit = { t2star: number; s0: number };
type Sample = { te: number[]; mean: number[]; sd: number[]; fit: Fit | null; segIdx: number; label: string; nVox: number };

const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

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

// Slice (10 echi) piu' vicina al punto mondo, echi ordinati per TE.
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
    if (dist < bestDist) { bestDist = dist; bestD = m.d; }
  });
  const slice = metas.filter(m => Math.abs(m.d - bestD) < 0.5).sort((a, b) => a.te - b.te);
  return slice.length >= 2 ? slice : null;
}

// Fit mono-esponenziale log-lineare pesato (peso S^2) sulla curva MEDIA del segmento.
function fitT2star(te: number[], sig: number[]): Fit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (let i = 0; i < te.length; i++) {
    if (sig[i] > 0) { xs.push(te[i]); ys.push(Math.log(sig[i])); ws.push(sig[i] * sig[i]); }
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
  if (slope >= 0) return null;
  return { t2star: -1 / slope, s0: Math.exp(intercept) };
}

// Individua il segmento AHA al click e media il decadimento su tutti i suoi voxel.
async function readSegment(
  world: number[],
  cs: any,
  t2ds: any,
  segId: string,
  labelOf: (s: number) => string
): Promise<{ outside?: boolean; sample?: Sample } | null> {
  const segUtils = cs.cornerstoneTools.utilities.segmentation;
  const labelVol = segUtils.getOrCreateSegmentationVolume(segId);
  if (!labelVol) return null;
  const [nx, ny] = labelVol.dimensions;
  const vm = labelVol.voxelManager;
  // indice di segmento direttamente dal labelmap al voxel cliccato
  const idx = cs.cornerstone.utilities.transformWorldToIndex(labelVol.imageData, world);
  const ci = Math.round(idx[0]);
  const cj = Math.round(idx[1]);
  const k = Math.round(idx[2]);
  const segIdx = vm.getAtIJK(ci, cj, k);
  if (!segIdx || segIdx < 1) return { outside: true };

  const slice = pickSlice(echoMetas(t2ds, cs.cornerstone.metaData), world);
  if (!slice) return null;
  const cols = slice[0].cols;
  const rows = slice[0].rows;
  const imgs = await Promise.all(slice.map((m: Slice) => cs.cornerstone.imageLoader.loadAndCacheImage(m.id)));
  const pds = imgs.map((img: any) => img.getPixelData());

  // raccogli, per ogni echo, i valori di tutti i voxel del segmento sulla slice k
  const perEcho: number[][] = slice.map(() => []);
  for (let j = 0; j < ny && j < rows; j++) {
    for (let i = 0; i < nx && i < cols; i++) {
      if (vm.getAtIJK(i, j, k) === segIdx) {
        const off = j * cols + i;
        for (let e = 0; e < pds.length; e++) perEcho[e].push(Number(pds[e][off]));
      }
    }
  }
  const nVox = perEcho[0].length;
  if (!nVox) return { outside: true };

  const te = slice.map((m: Slice) => m.te);
  const mean = perEcho.map(v => v.reduce((s, x) => s + x, 0) / v.length);
  const sd = perEcho.map((v, e) => {
    const mu = mean[e];
    return Math.sqrt(v.reduce((s, x) => s + (x - mu) * (x - mu), 0) / v.length);
  });
  return { sample: { te, mean, sd, fit: fitT2star(te, mean), segIdx, label: labelOf(segIdx), nVox } };
}

function DecayPlot({ sample }: { sample: Sample }) {
  const W = 264, H = 156, ml = 34, mr = 8, mt = 8, mb = 22;
  const { te, mean, sd, fit } = sample;
  const teMax = Math.max(...te, 1);
  const sMax = Math.max(...mean.map((m, i) => m + sd[i]), 1);
  const px = (t: number) => ml + (t / teMax) * (W - ml - mr);
  const py = (s: number) => H - mb - (s / sMax) * (H - mt - mb);
  // banda +-SD (poligono upper/lower)
  const upper = te.map((t, i) => `${px(t).toFixed(1)},${py(mean[i] + sd[i]).toFixed(1)}`);
  const lower = te.map((t, i) => `${px(t).toFixed(1)},${py(Math.max(mean[i] - sd[i], 0)).toFixed(1)}`).reverse();
  const band = `M${upper.join(' L')} L${lower.join(' L')} Z`;
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
      <path d={band} fill="#42a5f533" stroke="none" />
      {te.map((t, i) => (
        <line key={'e' + i} x1={px(t)} y1={py(Math.max(mean[i] - sd[i], 0))} x2={px(t)} y2={py(mean[i] + sd[i])} stroke="#42a5f5" strokeWidth={1} />
      ))}
      {curve.length > 0 && <path d={curve.join(' ')} fill="none" stroke="#ff7043" strokeWidth={1.5} />}
      {te.map((t, i) => (
        <circle key={'p' + i} cx={px(t)} cy={py(mean[i])} r={2.4} fill="#90caf9" />
      ))}
      <text x={ml} y={H - 6} fill="#888" fontSize={9}>0</text>
      <text x={W - mr} y={H - 6} fill="#888" fontSize={9} textAnchor="end">{teMax.toFixed(0)} ms (TE)</text>
      <text x={4} y={mt + 8} fill="#888" fontSize={9}>S</text>
    </svg>
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
    } catch (e) {
      return null;
    }
  }, [extensionManager]);

  const [active, setActive] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [status, setStatus] = useState<string>('');

  const setActiveTool = useCallback(
    (tool: 'WindowLevel' | 'Probe') => {
      const { toolGroupService, viewportGridService } = servicesManager.services;
      const { activeViewportId } = viewportGridService.getState();
      const tg = toolGroupService.getToolGroupForViewport(activeViewportId);
      commandsManager.run('setToolActive', { toolName: tool, toolGroupId: tg?.id });
    },
    [commandsManager, servicesManager]
  );

  const toggle = useCallback(() => {
    if (active) {
      setActive(false);
      setActiveTool('WindowLevel');
      setStatus('W/L attivo');
    } else {
      setActive(true);
      setActiveTool('Probe');
      setStatus('clic su un voxel dentro la segmentazione…');
    }
  }, [active, setActiveTool]);

  useEffect(() => {
    if (!cs) return;
    const eventTarget = cs.cornerstone.eventTarget;
    const EVT = cs.cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED;
    const handler = async (evt: any) => {
      const ann = evt?.detail?.annotation;
      const name = ann?.metadata?.toolName;
      if (!ann || name !== 'Probe') return;
      // una selezione alla volta: rimuovi i punti precedenti
      try {
        const state = cs.cornerstoneTools.annotation.state;
        state.getAllAnnotations().forEach((a: any) => {
          if (a?.metadata?.toolName === 'Probe' && a.annotationUID !== ann.annotationUID) {
            state.removeAnnotation(a.annotationUID);
          }
        });
        cs.cornerstone.getRenderingEngines?.().forEach((re: any) => re.render());
      } catch (e) { /* best-effort */ }

      const t2ds = findT2starDisplaySet(displaySetService);
      if (!t2ds) { setStatus('serie T2* multi-echo non trovata'); return; }
      const segs = segmentationService?.getSegmentations?.() || [];
      if (!segs.length) { setStatus('segmentazione non caricata'); return; }
      const segId = segs[0].segmentationId;
      const labelOf = (s: number) => segs[0]?.segments?.[s]?.label || `Segmento AHA ${s}`;
      try {
        const world = ann.data?.handles?.points?.[0];
        const r = await readSegment(world, cs, t2ds, segId, labelOf);
        if (!r) { setStatus('lettura non riuscita'); return; }
        if (r.outside) { setSample(null); setStatus('voxel FUORI dalla segmentazione — scegline uno dentro'); return; }
        setSample(r.sample || null);
        setStatus('');
      } catch (e: any) {
        setStatus('errore lettura: ' + (e?.message || e));
      }
    };
    eventTarget.addEventListener(EVT, handler);
    return () => eventTarget.removeEventListener(EVT, handler);
  }, [cs, displaySetService, segmentationService]);

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      <button
        onClick={toggle}
        style={{
          width: '100%', padding: '9px', border: 'none', borderRadius: 6, cursor: 'pointer',
          fontWeight: 600, color: '#fff', background: active ? '#1565c0' : '#37474f',
        }}
      >
        {active ? 'Selezione attiva — clic su un segmento' : 'Seleziona segmento'}
      </button>
      {status && <div style={{ marginTop: 8, color: status.includes('FUORI') ? '#e57373' : '#90caf9' }}>{status}</div>}
      {sample && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#ffb74d', fontWeight: 600 }}>{sample.label}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
            <span>T2* (media):&nbsp;<b style={{ color: '#ff8a65' }}>
              {sample.fit ? sample.fit.t2star.toFixed(1) : '—'} ms</b></span>
            <span style={{ color: '#9e9e9e' }}>{sample.nVox} voxel</span>
          </div>
          <div style={{ color: '#9e9e9e', marginTop: 2 }}>curva media ± SD (banda = variabilita' nel segmento)</div>
          <DecayPlot sample={sample} />
        </div>
      )}
      {!sample && !status && (
        <div style={{ marginTop: 10, color: '#777' }}>
          Premi <b>Seleziona segmento</b> e clicca un voxel dentro la segmentazione: media ± SD dei 10 echi del segmento AHA + T2*.
        </div>
      )}
    </div>
  );
}
