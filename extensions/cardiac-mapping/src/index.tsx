import { id } from './id';
import getHangingProtocolModule from './getHangingProtocolModule';
import getPanelModule from './getPanelModule';

// Comando nativo "Analizza T2*": chiama l'orchestrator (/api), sostituira' il widget iniettato.
function makeAnalyzeCommand(servicesManager) {
  const { uiNotificationService } = servicesManager.services;
  const notify = (message, type = 'info') =>
    uiNotificationService.show({ title: 'Cardiac Mapping', message, type, duration: 5000 });

  const studyUID = () => {
    const u = new URL(window.location.href);
    const s = u.searchParams.get('StudyInstanceUIDs');
    return s ? s.split(',')[0] : null;
  };

  const poll = jobId =>
    fetch(`/api/jobs/${jobId}`)
      .then(r => r.json())
      .then(job => {
        if (job.status === 'done') {
          notify('Analisi T2* completata', 'success');
          window.open(`/api/jobs/${jobId}/report`, '_blank');
        } else if (job.status === 'error') {
          notify('Errore: ' + (job.error || 'sconosciuto'), 'error');
        } else {
          notify('Analisi in corso: ' + (job.stage || job.status), 'info');
          setTimeout(() => poll(jobId), 3000);
        }
      })
      .catch(e => notify('Errore rete: ' + e, 'error'));

  return async () => {
    const uid = studyUID();
    if (!uid) {
      notify('Nessuno studio aperto', 'error');
      return;
    }
    // Idempotenza: se un'analisi esiste gia' (statistiche in Orthanc), rifarla SOVRASCRIVE la
    // precedente -> chiedi conferma prima di procedere.
    try {
      const existing = await fetch(`/api/studies/${uid}/segments`);
      if (existing.ok && !window.confirm(
        'Esiste gia\' un\'analisi per questo studio.\n\n' +
        'Rifarla SOVRASCRIVE i risultati precedenti (mappe, segmentazione, referto e statistiche).\n\n' +
        'Procedere?')) {
        return;
      }
    } catch (e) {
      /* se il controllo fallisce (rete), si procede comunque con l'analisi */
    }
    notify('Avvio analisi T2*…', 'info');
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ study_instance_uid: uid }),
      });
      const j = await res.json();
      if (j.job_id) {
        poll(j.job_id);
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
