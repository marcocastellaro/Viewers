// Coerenza multi-serie/multi-studio: quando l'utente carica manualmente una serie T2* multi-echo
// nel VIEWPORT 1, il VIEWPORT 2 (mappa T2* + overlay colore + SEG) e i valori dei pannelli devono
// aggiornarsi alla sequenza selezionata, "come se fosse appena analizzata".
// I pannelli si aggiornano gia' da soli (letture scoped su source_series). Qui aggiorniamo il
// viewport 2 impostando i display set CardioMap che appartengono alla serie sorgente attiva
// (stesso studio + suffisso [T2* s<num> #token] nella SeriesDescription), con le stesse opzioni
// dell'hanging protocol (VOI + colormap Inferno + SEG).

import { getSourceDisplaySet } from './activeSource';

// stesse opzioni dei layer del viewport 2 nell'hanging protocol (getHangingProtocolModule.ts)
const MAP_VOI = { windowCenter: 40, windowWidth: 80 };
const MYO_COLORMAP = {
  name: 'Inferno (matplotlib)',
  opacity: [
    { value: 0, opacity: 0 },
    { value: 0.02, opacity: 1 },
    { value: 1, opacity: 1 },
  ],
};

function desc(ds: any): string { return String(ds?.SeriesDescription || ''); }

export function installMapSync(servicesManager: any): () => void {
  const { viewportGridService, displaySetService, cornerstoneViewportService } =
    servicesManager?.services || {};
  if (!viewportGridService || !displaySetService) return () => {};

  let lastSeries: string | null = null;
  let busy = false;

  const syncNow = () => {
    if (busy) return;
    const src = getSourceDisplaySet(servicesManager);
    if (!src) return;
    if (src.SeriesInstanceUID === lastSeries) return; // la serie del viewport 1 non e' cambiata
    lastSeries = src.SeriesInstanceUID;

    const study = src.StudyInstanceUID;
    const tag = `[T2* s${src.SeriesNumber} #`; // suffisso della serie sorgente (studio univoco)
    const all = displaySetService.getActiveDisplaySets?.() || [];
    const inStudy = (ds: any) => ds?.StudyInstanceUID === study && desc(ds).includes(tag);
    const mapFull = all.find((ds: any) => inStudy(ds) && desc(ds).startsWith('CardioMap T2map full'));
    const myoMap = all.find((ds: any) => inStudy(ds) && desc(ds).startsWith('CardioMap T2map myo'));
    const seg = all.find((ds: any) => inStudy(ds) && ds.Modality === 'SEG');

    // secondo viewport (viewport 2 = mappa/SEG)
    const state = viewportGridService.getState();
    const ids = [...(state?.viewports?.keys?.() || [])];
    const vp2 = ids[1];
    if (!vp2) return;

    let uids: string[];
    let opts: any[];
    if (mapFull) {
      uids = [mapFull.displaySetInstanceUID];
      opts = [{ options: { voi: MAP_VOI } }];
      if (myoMap) { uids.push(myoMap.displaySetInstanceUID); opts.push({ options: { voi: MAP_VOI, colormap: MYO_COLORMAP } }); }
      if (seg) { uids.push(seg.displaySetInstanceUID); opts.push({}); }
    } else {
      // nessuna analisi per QUESTA serie: niente mappa stantia -> mostra la sorgente (coerente col
      // messaggio "nessuna analisi" nei pannelli).
      uids = [src.displaySetInstanceUID];
      opts = [{}];
    }

    busy = true;
    try {
      viewportGridService.setDisplaySetsForViewport({
        viewportId: vp2,
        displaySetInstanceUIDs: uids,
        displaySetOptions: opts,
      });
    } catch (e) { /* best-effort */ }
    setTimeout(() => { busy = false; }, 300);
  };

  // debounce leggero: piu' eventi ravvicinati -> una sola sync
  let t: any = null;
  const schedule = () => { if (t) clearTimeout(t); t = setTimeout(syncNow, 150); };

  const subs: any[] = [];
  try {
    const vg = viewportGridService;
    [vg?.EVENTS?.GRID_STATE_CHANGED, vg?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED]
      .filter(Boolean).forEach((ev: string) => subs.push(vg.subscribe(ev, schedule)));
    const cs = cornerstoneViewportService;
    [cs?.EVENTS?.VIEWPORT_DATA_CHANGED, cs?.EVENTS?.VIEWPORT_VOLUMES_CHANGED]
      .filter(Boolean).forEach((ev: string) => subs.push(cs.subscribe(ev, schedule)));
    const ds = displaySetService;
    [ds?.EVENTS?.DISPLAY_SETS_ADDED, ds?.EVENTS?.DISPLAY_SETS_CHANGED]
      .filter(Boolean).forEach((ev: string) => subs.push(ds.subscribe(ev, schedule)));
  } catch (e) { /* */ }

  return () => { if (t) clearTimeout(t); subs.forEach(s => s?.unsubscribe?.()); };
}
