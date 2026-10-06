import { id } from './id';
import getHangingProtocolModule from './getHangingProtocolModule';
import getPanelModule from './getPanelModule';
import { getActiveSource, checkEligible, modalityLabel } from './activeSource';
import { installAnalysisLock } from './analysisLock';

// Lock globale del viewer durante l'analisi (overlay che blocca viewport + selezione serie).
installAnalysisLock();

// Sync del viewport mappa/SEG quando cambia la serie T2* sorgente nel viewport 1 (usato dal mode).
export { installMapSync } from './syncMapViewport';
// Ripristino della serie sorgente analizzata (T1 MOLLI o T2*) nel viewport 1 dopo il reload.
export { rememberActiveSource, installSourceRestore } from './restoreSource';
// Etichette T1 / T2* sulle miniature della lista serie (analisi disponibile / gia' fatta).
export { installThumbnailBadges } from './thumbnailBadges';

// Comando nativo "Analizza": analizza la serie SORGENTE nel viewport 1 (non il primo studio
// dell'URL), solo se idonea (gate lato backend): T2* cardiaca multi-echo GRE oppure T1 MOLLI. La
// modalita' la decide il backend (/series-eligible). Apre il referto LEGATO a quella serie.
// Risultati separati per sequenza (scoped via source_series). Comando 'analyzeT2star' mantenuto
// come nome per compatibilita' col pulsante toolbar esistente.
function makeAnalyzeCommand(servicesManager) {
  const { uiNotificationService } = servicesManager.services;
  const notify = (message, type = 'info') =>
    uiNotificationService.show({ title: 'CMR-QMapping', message, type, duration: 5000 });

  const poll = (jobId, src, m) =>
    fetch(`/api/jobs/${jobId}`)
      .then(r => r.json())
      .then(job => {
        if (job.status === 'done') {
          notify('Analisi ' + m + ' completata', 'success');
          window.open(
            `/api/studies/${encodeURIComponent(src.study)}/report` +
            `?source_series=${encodeURIComponent(src.series)}`, '_blank');
        } else if (job.status === 'error') {
          notify('Errore: ' + (job.error || 'sconosciuto'), 'error');
        } else {
          notify('Analisi in corso: ' + (job.stage || job.status), 'info');
          setTimeout(() => poll(jobId, src, m), 3000);
        }
      })
      .catch(e => notify('Errore rete: ' + e, 'error'));

  return async () => {
    const src = getActiveSource(servicesManager);
    if (!src) {
      notify('Carica nel viewport 1 la serie da analizzare (T2* multi-echo o T1 MOLLI)', 'error');
      return;
    }
    // GATE: T2* cardiaca multi-echo o T1 MOLLI (giudizio del backend, che sceglie la modalita')
    const el = await checkEligible(src);
    if (!el.eligible || !el.modality) {
      notify('Serie non analizzabile (' + (el.reason || 'non idonea') +
        '). Seleziona una T2* cardiaca multi-echo o una T1 MOLLI.', 'error');
      return;
    }
    const modality = el.modality;
    const m = modalityLabel(modality);
    // Idempotenza (scoped): se esiste gia' un'analisi per QUESTA serie, conferma sovrascrittura.
    try {
      const existing = await fetch(
        `/api/studies/${encodeURIComponent(src.study)}/segments` +
        `?source_series=${encodeURIComponent(src.series)}`);
      if (existing.ok && !window.confirm(
        'Esiste gia\' un\'analisi per QUESTA serie ' + m + '.\n\n' +
        'Rifarla SOVRASCRIVE i risultati precedenti di questa sequenza (le altre restano intatte).\n\n' +
        'Procedere?')) {
        return;
      }
    } catch (e) { /* se il controllo fallisce si procede comunque */ }
    notify('Avvio analisi ' + m + ' su: ' + (src.description || src.series), 'info');
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          study_instance_uid: src.study,
          series_overrides: { [modality]: src.series },
          modality,
        }),
      });
      const j = await res.json();
      if (j.job_id) {
        poll(j.job_id, src, m);
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
