// Tracker condiviso dell'analisi: vive a livello di modulo (fuori da React), cosi' il
// polling e lo stato NON si perdono cambiando pannello/tab. I pannelli si iscrivono e
// leggono lo stato corrente; il polling continua anche se nessun pannello e' montato.
// Su reload/cambio tab riprende un job in corso via /api/studies/{uid}/latest.

type Sub = () => void;
type State = { jobId: string | null; stage: string; running: boolean; study: string | null };

let state: State = { jobId: null, stage: '', running: false, study: null };
const subs = new Set<Sub>();
const emit = () => subs.forEach(s => s());

function poll(): void {
  const id = state.jobId;
  if (!id) return;
  fetch(`/api/jobs/${id}`)
    .then(r => r.json())
    .then(j => {
      if (state.jobId !== id) return; // job sostituito nel frattempo
      state.stage = j.stage || '';
      if (j.status === 'done') {
        state.running = false; state.stage = 'done'; emit();
        // notifica il mode per ricaricare le serie nei viewport (SEG + mappe appena create)
        try {
          window.dispatchEvent(new CustomEvent('cardiomap:analysis-done', { detail: { study: state.study } }));
        } catch (e) { /* */ }
      } else if (j.status === 'error') { state.running = false; state.stage = 'error'; emit(); }
      else { state.running = true; emit(); setTimeout(poll, 1500); }
    })
    .catch(() => { if (state.jobId === id) setTimeout(poll, 3000); });
}

export const analysisTracker = {
  getState: (): State => state,
  subscribe(fn: Sub): () => void {
    subs.add(fn);
    return () => { subs.delete(fn); };
  },
  start(study: string, jobId: string): void {
    state = { jobId, stage: 'download', running: true, study };
    emit();
    poll();
  },
  // riprende un job in corso per lo studio (dopo cambio tab o reload della pagina)
  resume(study: string): void {
    if (state.running && state.study === study) return;
    fetch(`/api/studies/${study}/latest`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && d.job_id && d.status !== 'done' && d.status !== 'error') {
          state = { jobId: d.job_id, stage: d.stage || '', running: true, study };
          emit();
          poll();
        }
      })
      .catch(() => {});
  },
};
