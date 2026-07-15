import React from 'react';
import type { StudyRow } from '@ohif/ui-next';

// Cancellazione protetta di uno studio dal DB (Orthanc). Doppia protezione: si passa gia' dal
// login del proxy, e in piu' serve la PASSWORD AMMINISTRATORE verificata dall'orchestrator
// (/api/admin/delete-study). Agisce sullo studio selezionato nella lista.
export default function DeleteStudyButton({
  study,
  onDeleted,
}: {
  study: StudyRow | null;
  onDeleted: () => void;
}) {
  const uid = (study?.studyInstanceUid as string) || '';
  const disabled = !uid;

  const onClick = async () => {
    if (!uid) {
      return;
    }
    const label = (study?.patientName as string) || (study?.mrn as string) || uid;
    if (
      !window.confirm(
        `Eliminare DEFINITIVAMENTE lo studio "${label}" dal database?\n` +
          `L'operazione non e' reversibile.`
      )
    ) {
      return;
    }
    const pw = window.prompt("Password amministratore per confermare l'eliminazione:");
    if (!pw) {
      return;
    }
    try {
      const r = await fetch('/api/admin/delete-study', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ study_instance_uid: uid, password: pw }),
      });
      if (r.ok) {
        window.alert('Studio eliminato dal database.');
        onDeleted?.();
      } else if (r.status === 403) {
        window.alert('Password amministratore errata: eliminazione annullata.');
      } else {
        window.alert(`Eliminazione fallita (codice ${r.status}).`);
      }
    } catch (e) {
      window.alert('Errore di rete: ' + e);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? 'Seleziona uno studio per eliminarlo'
          : 'Elimina lo studio selezionato dal DB (richiede password)'
      }
      className="hover:bg-red-500/20 flex items-center gap-1 rounded px-2 py-1 text-sm text-red-400 disabled:opacity-40"
    >
      <span aria-hidden>🗑</span> Elimina
    </button>
  );
}
