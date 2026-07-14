import React from 'react';
import BullseyePanel from './panels/BullseyePanel';
import VoxelPanel from './panels/VoxelPanel';

function getPanelModule() {
  return [
    {
      name: 'cardiomapBullseye',
      iconName: 'tab-patient-info',
      iconLabel: "Bull's eye",
      label: "Bull's eye T2*",
      component: () => <BullseyePanel />,
    },
    {
      name: 'cardiomapVoxel',
      iconName: 'tab-patient-info',
      iconLabel: 'Voxel',
      label: 'Voxel T2*',
      component: (props: any) => <VoxelPanel {...props} />,
    },
  ];
}

export default getPanelModule;
