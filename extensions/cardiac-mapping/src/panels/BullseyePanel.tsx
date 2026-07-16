import React, { useCallback, useEffect, useState } from 'react';
import { analysisTracker } from '../analysisTracker';

function studyUID(): string | null {
  const u = new URL(window.location.href);
  const s = u.searchParams.get('StudyInstanceUIDs');
  return s ? s.split(',')[0] : null;
}

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
  const uid = studyUID();
  const [status, setStatus] = useState<string>('');
  const [hasAnalysis, setHasAnalysis] = useState<boolean>(false);
  const [, force] = useState(0);

  // stato corrente dal tracker (solo se relativo a QUESTO studio)
  const ts = analysisTracker.getState();
  const running = ts.running && ts.study === uid;
  const stage = ts.study === uid ? ts.stage : '';

  useEffect(() => {
    const unsub = analysisTracker.subscribe(() => force(n => n + 1));
    if (uid) analysisTracker.resume(uid); // riprende un job in corso (dopo cambio tab/reload)
    return unsub;
  }, [uid]);

  // "Analisi disponibile" = risultati in ORTHANC (SR statistiche), non su disco.
  useEffect(() => {
    if (!uid) return;
    fetch(`/api/studies/${uid}/segments`).then(r => { if (r.ok) setHasAnalysis(true); }).catch(() => {});
  }, [uid, stage]); // ricontrolla quando lo stage cambia (es. -> done)

  const analyze = useCallback(() => {
    if (!uid) { setStatus('nessuno studio aperto'); return; }
    // Idempotenza: se un'analisi esiste gia', rifarla SOVRASCRIVE la precedente -> conferma.
    if (hasAnalysis && !window.confirm(
      'Esiste gia\' un\'analisi per questo studio.\n\n' +
      'Rifarla SOVRASCRIVE i risultati precedenti (mappe, segmentazione, referto e statistiche).\n\n' +
      'Procedere?')) {
      return;
    }
    setStatus('');
    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ study_instance_uid: uid }),
    })
      .then(r => r.json())
      .then(j => (j.job_id ? analysisTracker.start(uid, j.job_id) : setStatus('risposta inattesa')))
      .catch(e => setStatus('errore: ' + e));
  }, [uid, hasAnalysis]);

  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      <button
        onClick={analyze}
        disabled={running}
        style={{
          width: '100%', padding: '10px', background: running ? '#455a64' : '#1565c0', color: '#fff',
          border: 'none', borderRadius: 6, fontWeight: 600, cursor: running ? 'default' : 'pointer',
        }}
      >
        {running ? 'Analisi in corso…' : 'Analizza T2*'}
      </button>
      {(running || stage) && <ProgressSteps stage={stage} running={running} />}
      {status && !running && <div style={{ marginTop: 8, color: '#90caf9' }}>{status}</div>}
      <div style={{ marginTop: 10, color: '#9e9e9e' }}>
        {hasAnalysis
          ? 'Analisi disponibile (da Orthanc). Bull’s eye e tabella nel pannello "Voxel T2*".'
          : 'Avvia l’analisi T2*; i risultati (bull’s eye + tabella) compaiono nel pannello "Voxel T2*".'}
      </div>
      <button
        onClick={() => window.open(`/api/studies/${uid}/report`, '_blank')}
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
