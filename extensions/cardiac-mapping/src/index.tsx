import { id } from './id';
import getHangingProtocolModule from './getHangingProtocolModule';
import getPanelModule from './getPanelModule';
import { getActiveSource, checkEligible } from './activeSource';
import { installAnalysisLock } from './analysisLock';

// Lock globale del viewer durante l'analisi (overlay che blocca viewport + selezione serie).
installAnalysisLock();

// Comando nativo "Analizza T2*": analizza la serie T2* SORGENTE attiva nel viewport (non il primo
// studio dell'URL), solo se idonea (cuore + multi-echo GRE, gate lato backend), e apre il referto
// LEGATO a quella serie. Risultati separati per sequenza (scoped via source_series).
function makeAnalyzeCommand(servicesManager) {
  const { uiNotificationService } = servicesManager.services;
  const notify = (message, type = 'info') =>
    uiNotificationService.show({ title: 'Cardiac Mapping', message, type, duration: 5000 });

  const poll = (jobId, src) =>
    fetch(`/api/jobs/${jobId}`)
      .then(r => r.json())
      .then(job => {
        if (job.status === 'done') {
          notify('Analisi T2* completata', 'success');
          window.open(
            `/api/studies/${encodeURIComponent(src.study)}/report` +
            `?source_series=${encodeURIComponent(src.series)}`, '_blank');
        } else if (job.status === 'error') {
          notify('Errore: ' + (job.error || 'sconosciuto'), 'error');
        } else {
          notify('Analisi in corso: ' + (job.stage || job.status), 'info');
          setTimeout(() => poll(jobId, src), 3000);
        }
      })
      .catch(e => notify('Errore rete: ' + e, 'error'));

  return async () => {
    const src = getActiveSource(servicesManager);
    if (!src) {
      notify('Seleziona nel viewport la serie T2* da analizzare', 'error');
      return;
    }
    // GATE: solo cuore + multi-echo gradient (giudizio del backend)
    const el = await checkEligible(src);
    if (!el.eligible) {
      notify('Serie non analizzabile (' + (el.reason || 'non idonea') +
        '). Seleziona una serie T2* cardiaca multi-echo.', 'error');
      return;
    }
    // Idempotenza (scoped): se esiste gia' un'analisi per QUESTA serie, conferma sovrascrittura.
    try {
      const existing = await fetch(
        `/api/studies/${encodeURIComponent(src.study)}/segments` +
        `?source_series=${encodeURIComponent(src.series)}`);
      if (existing.ok && !window.confirm(
        'Esiste gia\' un\'analisi per QUESTA serie T2*.\n\n' +
        'Rifarla SOVRASCRIVE i risultati precedenti di questa sequenza (le altre restano intatte).\n\n' +
        'Procedere?')) {
        return;
      }
    } catch (e) { /* se il controllo fallisce si procede comunque */ }
    notify('Avvio analisi T2* su: ' + (src.description || src.series), 'info');
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          study_instance_uid: src.study,
          series_overrides: { t2star: src.series },
        }),
      });
      const j = await res.json();
      if (j.job_id) {
        poll(j.job_id, src);
      } else {
        notify('Risposta inattesa dall’orchestrator', 'error');
      }
    } catch (e) {
      notify('Errore: ' + e, 'error');
    }
  };
}

const cardiacMappingExtension = {
  id,
  getHangingProtocolModule,
  getPanelModule,
  getCommandsModule({ servicesManager }: withAppTypes) {
    return {
      definitions: {
        analyzeT2star: {
          commandFn: makeAnalyzeCommand(servicesManager),
        },
      },
      defaultContext: 'DEFAULT',
    };
  },
};

export default cardiacMappingExtension;
