// Doppio clic su una miniatura della lista serie, nel workflow CardioMap.
//
// Il default di OHIF carica la serie nel viewport ATTIVO passando per il controllo dell'hanging
// protocol, che RIFIUTA i viewport definiti con piu' display set ("Cannot update viewport with
// multiple displaySets yet"). Il nostro viewport 2 (mappa + overlay miocardio + SEG) e' fatto cosi':
// se l'utente lo aveva attivo (tipico dopo un'analisi, per guardare la mappa), ogni doppio clic
// falliva con "The selected display sets could not be added to the viewport".
//
// Nel workflow il viewport 1 ospita la sequenza SORGENTE e il viewport 2 si riallinea da solo ai
// risultati di quella sorgente (syncMapViewport). Quindi:
//   - sequenze sorgente (MR non CardioMap)       -> viewport 1 (diventa anche quello attivo)
//   - serie CardioMap (mappe, SEG, referto, SR)  -> viewport 2, come display set singolo
// senza passare dal controllo dell'hanging protocol.

function desc(ds: any): string { return String(ds?.SeriesDescription || ''); }

export function cardiomapThumbnailDoubleClick({ servicesManager, commandsManager, activeViewportId }: any) {
  return async (displaySetInstanceUID: string) => {
    const { viewportGridService, displaySetService } = servicesManager.services;
    const ds = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
    const ids = [...(viewportGridService.getState()?.viewports?.keys?.() || [])];
    const isResult = desc(ds).startsWith('CardioMap') || ['SEG', 'SR', 'DOC'].includes(ds?.Modality);
    const target = (isResult ? ids[1] : ids[0]) || activeViewportId;
    if (!target) return;
    commandsManager.run('setDisplaySetsForViewports', {
      viewportsToUpdate: [{ viewportId: target, displaySetInstanceUIDs: [displaySetInstanceUID] }],
    });
    try { viewportGridService.setActiveViewportId(target); } catch (e) { /* best-effort */ }
  };
}
