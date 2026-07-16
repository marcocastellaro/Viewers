// Determina la serie T2* SORGENTE "attiva" (quella mostrata nel viewport) e il suo studio.
// Serve per: (a) analizzare ESATTAMENTE la serie che si sta guardando (non il primo studio
// dell'URL, che con piu' studi del soggetto sarebbe ambiguo); (b) leggere/salvare i risultati
// LEGATI a quella sequenza (piu' sequenze multi-echo nello stesso studio -> risultati separati,
// scoped via ?source_series=<SeriesInstanceUID> lato backend).

export type ActiveSource = { study: string; series: string; description: string };

// Una serie T2* SORGENTE = MR multi-echo (>=20 immagini: ~10 echi x 3 slice), descrizione da
// sequenza T2*/GRE multi-echo, NON generata da CardioMap. Stesso criterio usato per leggere la
// curva di decadimento (probe), cosi' analisi/statistiche/click puntano alla STESSA serie.
function isT2starSource(ds: any): boolean {
  const desc = String(ds?.SeriesDescription || '');
  const n = (ds?.imageIds?.length || 0) || (ds?.images?.length || 0) || (ds?.numImageFrames || 0);
  return !!ds && ds.Modality === 'MR' && !desc.startsWith('CardioMap')
    && /t2star|t2\*|r2\*|gre.*me|multi.?echo/i.test(desc) && n >= 20;
}

function toSource(ds: any): ActiveSource {
  return { study: ds.StudyInstanceUID, series: ds.SeriesInstanceUID, description: ds.SeriesDescription || '' };
}

// Il displaySet della serie T2* sorgente mostrata nel VIEWPORT 1 (il viewport della sequenza
// nativa multi-echo). NON si usa il viewport ATTIVO: dopo l'analisi l'utente puo' avere attivo il
// viewport 2 (mappa T2* + SEG), che non contiene i dati multi-echo -> l'analisi e le letture
// devono restare ancorate alla sequenza sorgente del viewport 1.
export function getSourceDisplaySet(servicesManager: any): any | null {
  const { viewportGridService, displaySetService } = servicesManager?.services || {};
  if (!viewportGridService || !displaySetService) return null;
  // 1) serie T2* sorgente nel primo viewport (viewport 1)
  try {
    const state = viewportGridService.getState();
    const ids = [...(state?.viewports?.keys?.() || [])];
    const vp1 = state?.viewports?.get?.(ids[0]);
    for (const uid of vp1?.displaySetInstanceUIDs || []) {
      const ds = displaySetService.getDisplaySetByUID(uid);
      if (isT2starSource(ds)) return ds;
    }
  } catch (e) { /* viewport non pronto */ }
  // 2) fallback: prima serie T2* sorgente fra i displaySet attivi
  try {
    return (displaySetService.getActiveDisplaySets?.() || []).find(isT2starSource) || null;
  } catch (e) { return null; }
}

export function getActiveSource(servicesManager: any): ActiveSource | null {
  const ds = getSourceDisplaySet(servicesManager);
  return ds ? toSource(ds) : null;
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
