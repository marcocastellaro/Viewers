// Ripristino della serie SORGENTE dopo il reload di fine analisi. Il mode ricarica la pagina per
// caricare le nuove serie CardioMap (mappe/SEG); l'hanging protocol rimetterebbe nel viewport 1 la
// T2* di default, perdendo la serie che l'utente stava analizzando (es. una T1 MOLLI, o una
// seconda T2*). Prima del reload si salva (study, series) in sessionStorage; dopo il reload la si
// rimette nel viewport 1 appena il suo displaySet e' disponibile. Il viewport 2 si riaggancia da
// solo ai risultati di QUELLA serie (syncMapViewport).

import { getActiveSource } from './activeSource';

const KEY = 'cardiomap:restore-source';
const MAX_AGE_MS = 2 * 60 * 1000;   // vale solo per il reload immediato dopo l'analisi

export function rememberActiveSource(servicesManager: any): void {
  try {
    const src = getActiveSource(servicesManager);
    if (src) sessionStorage.setItem(KEY, JSON.stringify({ study: src.study, series: src.series, t: Date.now() }));
  } catch (e) { /* storage non disponibile: si ricade sull'hanging protocol */ }
}

export function installSourceRestore(servicesManager: any): () => void {
  const { viewportGridService, displaySetService } = servicesManager?.services || {};
  let pending: { study: string; series: string } | null = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (p && p.series && Date.now() - (p.t || 0) < MAX_AGE_MS) pending = p;
  } catch (e) { pending = null; }
  if (!pending || !viewportGridService || !displaySetService) return () => {};

  const subs: any[] = [];
  let t: any = null;
  const tryRestore = () => {
    if (!pending) return;
    const ds = (displaySetService.getActiveDisplaySets?.() || []).find(
      (d: any) => d?.SeriesInstanceUID === pending!.series && d?.StudyInstanceUID === pending!.study);
    const ids = [...(viewportGridService.getState()?.viewports?.keys?.() || [])];
    if (!ds || !ids[0]) return;                       // displaySet o viewport non ancora pronti
    const vp1 = viewportGridService.getState().viewports.get(ids[0]);
    pending = null;
    if ((vp1?.displaySetInstanceUIDs || []).includes(ds.displaySetInstanceUID)) return; // gia' li'
    try {
      viewportGridService.setDisplaySetsForViewport({
        viewportId: ids[0], displaySetInstanceUIDs: [ds.displaySetInstanceUID],
      });
    } catch (e) { /* best-effort */ }
  };
  // dopo l'hanging protocol: attende che viewport e displaySet siano pronti (debounce)
  const schedule = () => { if (t) clearTimeout(t); t = setTimeout(tryRestore, 400); };
  try {
    const vg = viewportGridService;
    [vg?.EVENTS?.GRID_STATE_CHANGED, vg?.EVENTS?.VIEWPORTS_READY]
      .filter(Boolean).forEach((ev: string) => subs.push(vg.subscribe(ev, schedule)));
    const ds = displaySetService;
    [ds?.EVENTS?.DISPLAY_SETS_ADDED].filter(Boolean).forEach((ev: string) => subs.push(ds.subscribe(ev, schedule)));
  } catch (e) { /* */ }
  return () => { if (t) clearTimeout(t); subs.forEach(s => s?.unsubscribe?.()); };
}
