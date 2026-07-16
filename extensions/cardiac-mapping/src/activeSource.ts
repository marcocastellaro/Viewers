// Determina la serie T2* SORGENTE "attiva" (quella mostrata nel viewport) e il suo studio.
// Serve per: (a) analizzare ESATTAMENTE la serie che si sta guardando (non il primo studio
// dell'URL, che con piu' studi del soggetto sarebbe ambiguo); (b) leggere/salvare i risultati
// LEGATI a quella sequenza (piu' sequenze multi-echo nello stesso studio -> risultati separati,
// scoped via ?source_series=<SeriesInstanceUID> lato backend).

export type ActiveSource = { study: string; series: string; description: string };

// una serie "sorgente" candidata = MR e NON generata da CardioMap (quelle iniziano per "CardioMap").
function isSource(ds: any): boolean {
  return !!ds && ds.Modality === 'MR' &&
    !String(ds.SeriesDescription || '').startsWith('CardioMap');
}

function toSource(ds: any): ActiveSource {
  return { study: ds.StudyInstanceUID, series: ds.SeriesInstanceUID, description: ds.SeriesDescription || '' };
}

export function getActiveSource(servicesManager: any): ActiveSource | null {
  const { viewportGridService, displaySetService } = servicesManager?.services || {};
  if (!viewportGridService || !displaySetService) return null;

  // 1) displaySet non-CardioMap del viewport ATTIVO (la serie che l'utente sta guardando)
  try {
    const state = viewportGridService.getState();
    const vp = state?.viewports?.get?.(state.activeViewportId);
    for (const uid of vp?.displaySetInstanceUIDs || []) {
      const ds = displaySetService.getDisplaySetByUID(uid);
      if (isSource(ds)) return toSource(ds);
    }
  } catch (e) { /* viewport non pronto */ }

  // 2) fallback: prima serie MR non-CardioMap fra i displaySet attivi
  try {
    const ds = (displaySetService.getActiveDisplaySets?.() || []).find(isSource);
    if (ds) return toSource(ds);
  } catch (e) { /* */ }

  return null;
}

// Verifica lato BACKEND se la serie e' analizzabile (cuore + multi-echo GRE). Il backend e'
// l'unico giudice (config data-driven), cosi' UI e pipeline restano coerenti.
export async function checkEligible(src: ActiveSource):
    Promise<{ eligible: boolean; reason?: string }> {
  try {
    const r = await fetch(
      `/api/series-eligible?study_instance_uid=${encodeURIComponent(src.study)}` +
      `&series_instance_uid=${encodeURIComponent(src.series)}`);
    if (!r.ok) return { eligible: false, reason: 'verifica non riuscita' };
    return await r.json();
  } catch (e) {
    return { eligible: false, reason: 'errore rete' };
  }
}
