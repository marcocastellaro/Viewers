// Determina la serie SORGENTE "attiva" (T2* multi-echo o T1 MOLLI, quella mostrata nel viewport 1)
// e il suo studio.
// Serve per: (a) analizzare ESATTAMENTE la serie che si sta guardando (non il primo studio
// dell'URL, che con piu' studi del soggetto sarebbe ambiguo); (b) leggere/salvare i risultati
// LEGATI a quella sequenza (piu' sequenze multi-echo nello stesso studio -> risultati separati,
// scoped via ?source_series=<SeriesInstanceUID> lato backend).

export type Modality = 't2star' | 't1_molli';
export type ActiveSource = { study: string; series: string; description: string; modality: Modality };

// Etichetta breve della modalita' (UI e suffisso delle serie CardioMap: "[T2* s21 #..]", "[T1 s16 #..]").
export function modalityLabel(m?: string | null): string {
  return m === 't1_molli' ? 'T1' : 'T2*';
}

function nImages(ds: any): number {
  return (ds?.imageIds?.length || 0) || (ds?.images?.length || 0) || (ds?.numImageFrames || 0);
}

// Una serie T2* SORGENTE = MR multi-echo (>=20 immagini: ~10 echi x 3 slice), descrizione da
// sequenza T2*/GRE multi-echo, NON generata da CardioMap. Stesso criterio usato per leggere la
// curva di decadimento (probe), cosi' analisi/statistiche/click puntano alla STESSA serie.
function isT2starSource(ds: any): boolean {
  const desc = String(ds?.SeriesDescription || '');
  return !!ds && ds.Modality === 'MR' && !desc.startsWith('CardioMap')
    && /t2star|t2\*|r2\*|gre.*me|multi.?echo/i.test(desc) && nImages(ds) >= 20;
}

// Una serie T1 MOLLI SORGENTE = MR con piu' TI (>=8 immagini: 8 TI x slice), descrizione MOLLI /
// T1 map, NON generata da CardioMap. La mappa T1 dello scanner (1 immagine per slice) ha troppe
// poche immagini; in ogni caso il giudice finale e' il backend (/series-eligible, ImageType).
function isT1Source(ds: any): boolean {
  const desc = String(ds?.SeriesDescription || '');
  return !!ds && ds.Modality === 'MR' && !desc.startsWith('CardioMap')
    && /molli|t1[ _-]?map|myomaps/i.test(desc) && nImages(ds) >= 8;
}

function isSource(ds: any): boolean {
  return isT2starSource(ds) || isT1Source(ds);
}

function toSource(ds: any): ActiveSource {
  return {
    study: ds.StudyInstanceUID, series: ds.SeriesInstanceUID, description: ds.SeriesDescription || '',
    modality: isT2starSource(ds) ? 't2star' : 't1_molli',
  };
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
      if (isSource(ds)) return ds;
    }
  } catch (e) { /* viewport non pronto */ }
  // 2) fallback: prima serie sorgente (T2*, poi T1) fra i displaySet attivi
  try {
    const all = displaySetService.getActiveDisplaySets?.() || [];
    return all.find(isT2starSource) || all.find(isT1Source) || null;
  } catch (e) { return null; }
}

export function getActiveSource(servicesManager: any): ActiveSource | null {
  const ds = getSourceDisplaySet(servicesManager);
  return ds ? toSource(ds) : null;
}

// Verifica lato BACKEND se la serie e' analizzabile e con QUALE analisi: T2* (cuore + multi-echo
// GRE) o T1 MOLLI (sequenza sorgente, non mappa scanner). Il backend e' l'unico giudice (config
// data-driven), cosi' UI e pipeline restano coerenti.
export async function checkEligible(src: ActiveSource):
    Promise<{ eligible: boolean; reason?: string; modality?: Modality | null }> {
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
