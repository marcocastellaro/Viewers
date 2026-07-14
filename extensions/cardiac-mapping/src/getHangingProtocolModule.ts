// Hanging protocol CardioMap: layout 1x2.
//  - viewport sinistro: T2* multi-echo (volume 4D, navigazione echi)
//  - viewport destro: stesso T2* con la SEGMENTAZIONE (DICOM SEG) sovrapposta
// I due viewport sono sincronizzati (posizione camera + window level).
// La SEG compare dopo l'analisi (write-back); se assente, il viewport destro mostra il T2*.

const sync = [
  { type: 'cameraPosition', id: 'cardiacCamera', source: true, target: true },
  { type: 'voi', id: 'cardiacVOI', source: true, target: true },
];

const cardiacMappingT2star = {
  id: 'cardiacMappingT2star',
  name: 'Cardiac Mapping T2*',
  protocolMatchingRules: [
    { id: 'hasMR', weight: 1, attribute: 'ModalitiesInStudy', constraint: { contains: 'MR' } },
  ],
  imageLoadStrategy: 'default',
  displaySetSelectors: {
    t2starSelector: {
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        { weight: 5, attribute: 'SeriesDescription', constraint: { contains: 'T2Star' } },
      ],
    },
    segSelector: {
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'SEG' }, required: true },
      ],
    },
  },
  stages: [
    {
      id: 'cardiacMappingT2starDefault',
      name: 'default',
      viewportStructure: {
        layoutType: 'grid',
        properties: { rows: 1, columns: 2 },
      },
      viewports: [
        {
          viewportOptions: {
            viewportType: 'volume',
            toolGroupId: 'default',
            allowUnmatchedView: true,
            syncGroups: sync,
          },
          displaySets: [{ id: 't2starSelector' }],
        },
        {
          viewportOptions: {
            viewportType: 'volume',
            toolGroupId: 'default',
            allowUnmatchedView: true,
            syncGroups: sync,
          },
          displaySets: [{ id: 't2starSelector' }, { id: 'segSelector' }],
        },
      ],
    },
  ],
  numberOfPriorsReferenced: 0,
};

function getHangingProtocolModule() {
  return [
    {
      name: cardiacMappingT2star.id,
      protocol: cardiacMappingT2star,
    },
  ];
}

export default getHangingProtocolModule;
