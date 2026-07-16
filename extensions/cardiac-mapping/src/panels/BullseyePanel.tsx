import React, { useCallback, useEffect, useState } from 'react';
import { useSystem } from '@ohif/core/src';
import { analysisTracker } from '../analysisTracker';
import { getActiveSource, checkEligible } from '../activeSource';

// Step della pipeline (informativi, sola lettura) e mappatura dagli stage del backend.
const STEPS = ['Segmentazione', 'Quantificazione T2*', 'Correzione', 'Statistica / referto'];
const STAGE_TO_IDX: Record<string, number> = {
  download: 0, ingest: 0, segmentation: 0,
  mapping: 1,
  aggregation: 2,
  report: 3, writeback: 3,
};

// Indicatore passivo di avanzamento pipeline (NON navigabile): mostra a che punto e' l'analisi.
function ProgressSteps({ stage, running }: { stage: string; running: boolean }) {
  const done = stage === 'done';
  const cur = done ? STEPS.length : (STAGE_TO_IDX[stage] ?? -1);
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ color: '#9e9e9e', marginBottom: 6 }}>
        {done ? 'Pipeline completata' : running ? 'Analisi in corso…' : 'Pipeline'}
      </div>
      {STEPS.map((s, i) => {
        const state = i < cur ? 'done' : i === cur ? 'active' : 'todo';
        const color = state === 'done' ? '#43a047' : state === 'active' ? '#42a5f5' : '#555';
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
            <span style={{
              width: 16, height: 16, borderRadius: '50%', flex: '0 0 auto',
              border: `2px solid ${color}`, background: state === 'done' ? color : 'transparent',
              color: '#fff', fontSize: 10, lineHeight: '13px', textAlign: 'center',
            }}>{state === 'done' ? '✓' : state === 'active' ? '' : ''}</span>
            <span style={{ color: state === 'todo' ? '#777' : '#e0e0e0', fontWeight: state === 'active' ? 700 : 400 }}>
              {i + 1}. {s}{state === 'active' && running ? '…' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Pannello Analisi: pulsante "Analizza T2*" + indicatore avanzamento pipeline.
// Lo stato dell'analisi vive nel tracker condiviso (analysisTracker): non si perde cambiando
// pannello e riprende un job in corso al rientro.
export default function BullseyePanel() {
  const { servicesManager } = useSystem();
  const [status, setStatus] = useState<string>('');
  const [hasAnalysis, setHasAnalysis] = useState<boolean>(false);
  const [eligible, setEligible] = useState<{ eligible: boolean; reason?: string }>({ eligible: false });
  const [, force] = useState(0);

  // Serie T2* SORGENTE attiva nel viewport (studio+serie): si analizza QUELLA, non il primo
  // studio dell'URL. I risultati sono legati alla serie (scoped source_series).
  const src = getActiveSource(servicesManager);
  const study = src?.study || null;

  // Ri-deriva su cambi di viewport/displaySet (l'utente cambia serie) + eventi del tracker.
  useEffect(() => {
    const refresh = () => force(n => n + 1);
    const unsubT = analysisTracker.subscribe(refresh);
    const subs: any[] = [];
    const { viewportGridService, displaySetService } = servicesManager?.services || {};
    try {
      const vg = viewportGridService;
      [vg?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED, vg?.EVENTS?.GRID_STATE_CHANGED, vg?.EVENTS?.VIEWPORTS_READY]
        .filter(Boolean).forEach((ev: string) => subs.push(vg.subscribe(ev, refresh)));
      const ds = displaySetService;
      [ds?.EVENTS?.DISPLAY_SETS_ADDED, ds?.EVENTS?.DISPLAY_SETS_CHANGED]
        .filter(Boolean).forEach((ev: string) => subs.push(ds.subscribe(ev, refresh)));
    } catch (e) { /* */ }
    return () => { unsubT && unsubT(); subs.forEach(s => s?.unsubscribe?.()); };
  }, [servicesManager]);

  // stato corrente dal tracker (relativo allo studio attivo)
  const ts = analysisTracker.getState();
  const running = ts.running && ts.study === study;
  const stage = ts.study === study ? ts.stage : '';

  useEffect(() => { if (study) analysisTracker.resume(study); }, [study]);

  // GATE: la serie attiva e' analizzabile (cuore + multi-echo GRE)? Giudizio del backend.
  useEffect(() => {
    let alive = true;
    if (!src) { setEligible({ eligible: false, reason: 'nessuna serie attiva' }); return; }
    checkEligible(src).then(e => { if (alive) setEligible(e); });
    return () => { alive = false; };
  }, [src?.study, src?.series]);

  // "Analisi disponibile" per QUESTA serie = SR in Orthanc scoped su source_series.
  useEffect(() => {
    if (!src) { setHasAnalysis(false); return; }
    let alive = true;
    fetch(`/api/studies/${encodeURIComponent(src.study)}/segments?source_series=${encodeURIComponent(src.series)}`)
      .then(r => { if (alive) setHasAnalysis(r.ok); }).catch(() => { if (alive) setHasAnalysis(false); });
    return () => { alive = false; };
  }, [src?.study, src?.series, stage]);

  const analyze = useCallback(() => {
    if (!src) { setStatus('seleziona nel viewport una serie T2*'); return; }
    if (!eligible.eligible) { setStatus('serie non analizzabile: ' + (eligible.reason || 'non idonea')); return; }
    // Idempotenza (scoped per serie): rifarla SOVRASCRIVE solo i risultati di QUESTA sequenza.
    if (hasAnalysis && !window.confirm(
      'Esiste gia\' un\'analisi per QUESTA serie T2*.\n\n' +
      'Rifarla SOVRASCRIVE i risultati di questa sequenza (le altre restano intatte).\n\n' +
      'Procedere?')) {
      return;
    }
    setStatus('');
    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ study_instance_uid: src.study, series_overrides: { t2star: src.series } }),
    })
      .then(r => r.json())
      .then(j => (j.job_id ? analysisTracker.start(src.study, j.job_id) : setStatus('risposta inattesa')))
      .catch(e => setStatus('errore: ' + e));
  }, [src?.study, src?.series, eligible, hasAnalysis]);

  const canAnalyze = !!src && eligible.eligible && !running;

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      <div style={{ marginBottom: 8, color: '#b0bec5' }}>
        Serie: <b style={{ color: '#e0e0e0' }}>{src ? (src.description || src.series) : '—'}</b>
      </div>
      <button
        onClick={analyze}
        disabled={!canAnalyze}
        title={!src ? 'Seleziona una serie T2* nel viewport'
          : !eligible.eligible ? ('Non analizzabile: ' + (eligible.reason || '')) : ''}
        style={{
          width: '100%', padding: '10px', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600,
          background: !canAnalyze ? '#455a64' : '#1565c0', cursor: canAnalyze ? 'pointer' : 'default',
        }}
      >
        {running ? 'Analisi in corso…' : 'Analizza T2*'}
      </button>
      {src && !eligible.eligible && !running && (
        <div style={{ marginTop: 6, color: '#ef9a9a' }}>
          Serie non analizzabile: {eligible.reason || 'non idonea'} (serve T2* cardiaca multi-echo).
        </div>
      )}
      {(running || stage) && <ProgressSteps stage={stage} running={running} />}
      {status && !running && <div style={{ marginTop: 8, color: '#90caf9' }}>{status}</div>}
      <div style={{ marginTop: 10, color: '#9e9e9e' }}>
        {hasAnalysis
          ? 'Analisi disponibile per questa serie (da Orthanc). Bull’s eye e tabella nel pannello "Voxel T2*".'
          : 'Avvia l’analisi T2*; i risultati (bull’s eye + tabella) compaiono nel pannello "Voxel T2*".'}
      </div>
      <button
        onClick={() => src && window.open(
          `/api/studies/${encodeURIComponent(src.study)}/report?source_series=${encodeURIComponent(src.series)}`, '_blank')}
        disabled={!hasAnalysis}
        style={{
          width: '100%', marginTop: 10, padding: '8px', border: 'none', borderRadius: 6,
          cursor: hasAnalysis ? 'pointer' : 'default', color: '#fff', fontWeight: 600,
          background: hasAnalysis ? '#37474f' : '#2b3238',
        }}
      >
        Apri referto PDF
      </button>
    </div>
  );
}
