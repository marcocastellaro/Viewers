// Etichette T1 / T2* sulle miniature della lista serie: indicano SU QUALI serie e' disponibile
// l'analisi (e se e' gia' stata fatta), prima ancora di aprirle. Il giudizio e' del backend
// (/api/studies/{uid}/series-status, stesse regole del pulsante "Analizza"); qui si impostano
// solo i `badges` sui displaySet (vedi Thumbnail in @ohif/ui-next) e si chiede alla lista serie di
// ridisegnarsi (metadata invalidated SENZA invalidare i dati: i viewport non ricaricano nulla).
//   - "T1" / "T2*" a contorno  -> serie analizzabile, analisi non ancora eseguita
//   - "T1 ✓" / "T2* ✓" pieno   -> analisi gia' disponibile per QUESTA serie
//   - nessuna etichetta        -> serie non analizzabile (o generata da CardioMap)

import { modalityLabel } from './activeSource';

type SeriesStatus = { series_instance_uid: string; modality: string | null; reason: string; analyzed: boolean };

function badgeFor(st: SeriesStatus) {
  if (!st?.modality) return undefined;
  const m = modalityLabel(st.modality);
  const seq = st.modality === 't1_molli' ? 'T1 MOLLI' : 'T2* multi-echo';
  return st.analyzed
    ? [{ label: `${m} ✓`, variant: 'filled', tooltip: `Analisi ${m} disponibile per questa serie (${seq})` }]
    : [{ label: m, variant: 'outline', tooltip: `Analizzabile: ${seq} (analisi non ancora eseguita)` }];
}

export function installThumbnailBadges(servicesManager: any): () => void {
  const { displaySetService } = servicesManager?.services || {};
  if (!displaySetService) return () => {};

  const statusByStudy = new Map<string, Map<string, SeriesStatus>>();
  const inFlight = new Set<string>();
  let t: any = null;

  const apply = () => {
    const all = displaySetService.getActiveDisplaySets?.() || [];
    let changed: string | null = null;
    for (const ds of all) {
      const st = statusByStudy.get(ds.StudyInstanceUID)?.get(ds.SeriesInstanceUID);
      if (!st) continue;
      const badges = badgeFor(st);
      if (JSON.stringify(ds.badges) !== JSON.stringify(badges)) {
        ds.badges = badges;
        changed = ds.displaySetInstanceUID;
      }
    }
    // un solo evento basta: la lista serie ricalcola TUTTE le miniature
    if (changed) displaySetService.setDisplaySetMetadataInvalidated(changed, false);
  };

  const fetchStudy = (study: string) => {
    if (inFlight.has(study)) return;
    inFlight.add(study);
    fetch(`/api/studies/${encodeURIComponent(study)}/series-status`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.series) return;
        statusByStudy.set(study, new Map(d.series.map((s: SeriesStatus) => [s.series_instance_uid, s])));
        apply();
      })
      .catch(() => { /* backend non raggiungibile: nessuna etichetta */ })
      .finally(() => inFlight.delete(study));
  };

  const refresh = () => {
    const studies = new Set<string>(
      (displaySetService.getActiveDisplaySets?.() || []).map((ds: any) => ds.StudyInstanceUID).filter(Boolean));
    studies.forEach(s => (statusByStudy.has(s) ? apply() : fetchStudy(s)));
  };
  const schedule = () => { if (t) clearTimeout(t); t = setTimeout(refresh, 300); };

  const subs: any[] = [];
  try {
    const ds = displaySetService;
    [ds?.EVENTS?.DISPLAY_SETS_ADDED, ds?.EVENTS?.DISPLAY_SETS_CHANGED]
      .filter(Boolean).forEach((ev: string) => subs.push(ds.subscribe(ev, schedule)));
  } catch (e) { /* */ }
  schedule();
  return () => { if (t) clearTimeout(t); subs.forEach(s => s?.unsubscribe?.()); };
}
