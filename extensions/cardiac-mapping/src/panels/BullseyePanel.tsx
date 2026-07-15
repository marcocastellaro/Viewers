import React, { useCallback, useEffect, useState } from 'react';

function studyUID(): string | null {
  const u = new URL(window.location.href);
  const s = u.searchParams.get('StudyInstanceUIDs');
  return s ? s.split(',')[0] : null;
}

// Pannello Bull's eye: pulsante "Analizza T2*" (nativo, chiama l'orchestrator) + PNG del bull's eye.
export default function BullseyePanel() {
  const uid = studyUID();
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [ts, setTs] = useState<number>(Date.now());

  const loadLatest = useCallback(() => {
    if (!uid) return;
    fetch(`/api/studies/${uid}/latest`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && d.status === 'done') {
          setJobId(d.job_id);
          setTs(Date.now());
        }
      })
      .catch(() => {});
  }, [uid]);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  const poll = useCallback((id: string) => {
    fetch(`/api/jobs/${id}`)
      .then(r => r.json())
      .then(j => {
        if (j.status === 'done') {
          setStatus('');
          setJobId(id);
          setTs(Date.now());
        } else if (j.status === 'error') {
          setStatus('errore: ' + (j.error || 'sconosciuto'));
        } else {
          setStatus('analisi: ' + (j.stage || j.status));
          setTimeout(() => poll(id), 3000);
        }
      })
      .catch(e => setStatus('errore rete: ' + e));
  }, []);

  const analyze = useCallback(() => {
    if (!uid) { setStatus('nessuno studio aperto'); return; }
    setStatus('avvio…');
    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ study_instance_uid: uid }),
    })
      .then(r => r.json())
      .then(j => (j.job_id ? poll(j.job_id) : setStatus('risposta inattesa')))
      .catch(e => setStatus('errore: ' + e));
  }, [uid, poll]);

  const done = jobId && !status;
  return (
    <div style={{ padding: 10, color: '#e0e0e0', fontFamily: 'sans-serif', fontSize: 12 }}>
      <button
        onClick={analyze}
        style={{
          width: '100%', padding: '10px', background: '#1565c0', color: '#fff',
          border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer',
        }}
      >
        Analizza T2*
      </button>
      {status && <div style={{ marginTop: 8, color: '#90caf9' }}>{status}</div>}
      <div style={{ marginTop: 10, color: '#9e9e9e' }}>
        {done
          ? 'Analisi disponibile. Bull’s eye e tabella nel pannello "Voxel T2*".'
          : 'Avvia l’analisi T2*; i risultati (bull’s eye + tabella) compaiono nel pannello "Voxel T2*".'}
      </div>
      <button
        onClick={() => window.open(`/api/jobs/${jobId}/report`, '_blank')}
        disabled={!done}
        style={{
          width: '100%', marginTop: 10, padding: '8px', border: 'none', borderRadius: 6,
          cursor: done ? 'pointer' : 'default', color: '#fff', fontWeight: 600,
          background: done ? '#37474f' : '#2b3238',
        }}
      >
        Apri referto PDF
      </button>
    </div>
  );
}
