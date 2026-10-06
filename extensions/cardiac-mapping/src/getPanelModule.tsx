import React from 'react';
import BullseyePanel from './panels/BullseyePanel';
import VoxelPanel from './panels/VoxelPanel';

function getPanelModule() {
  return [
    {
      name: 'cardiomapBullseye',
      iconName: 'tab-patient-info',
      iconLabel: 'Analisi',
      label: 'Analisi (T2* / T1)',
      component: () => <BullseyePanel />,
    },
    {
      name: 'cardiomapVoxel',
      iconName: 'tab-patient-info',
      iconLabel: 'Voxel',
      label: 'Voxel (T2* / T1)',
      component: (props: any) => <VoxelPanel {...props} />,
    },
  ];
}

export default getPanelModule;
