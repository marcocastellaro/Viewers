import React from 'react';

// Pannello Voxel: mostrera' la curva dei 10 echi + T2*/CV del voxel selezionato
// (dalla parametric map reinviata). Placeholder in questa prima versione.
export default function VoxelPanel() {
  return (
    <div style={{ padding: 10, color: '#bbb', fontFamily: 'sans-serif', fontSize: 12 }}>
      <div style={{ color: '#9e9e9e', marginBottom: 6 }}>Voxel T2*</div>
      <div>
        Curva di decadimento (10 echi) e T2*/CV del voxel selezionato.
        <br />
        <span style={{ color: '#777' }}>
          Clic sul voxel nel riquadro T2*: in arrivo (legge la parametric map dal write-back).
        </span>
      </div>
    </div>
  );
}
