// Hanging protocol CardioMap: seleziona la serie T2* multi-echo (MR) e la mostra come
// volume 4D (navigazione fra gli echi). default4D era per PET/CT e non matcha l'MR.

const cardiacMappingT2star = {
  id: 'cardiacMappingT2star',
  name: 'Cardiac Mapping T2*',
  // Applica il protocollo se lo studio contiene MR.
  protocolMatchingRules: [
    {
      id: 'hasMR',
      weight: 1,
      attribute: 'ModalitiesInStudy',
      constraint: { contains: 'MR' },
    },
  ],
  imageLoadStrategy: 'default',
  displaySetSelectors: {
    t2starSelector: {
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        // preferisci la serie la cui SeriesDescription contiene "T2Star" (il nostro T2* multi-echo)
        { weight: 5, attribute: 'SeriesDescription', constraint: { contains: 'T2Star' } },
      ],
    },
  },
  stages: [
    {
      id: 'cardiacMappingT2starDefault',
      name: 'default',
      viewportStructure: {
        layoutType: 'grid',
        properties: { rows: 1, columns: 1 },
      },
      viewports: [
        {
          viewportOptions: {
            viewportType: 'volume',
            toolGroupId: 'default',
            allowUnmatchedView: true,
          },
          displaySets: [{ id: 't2starSelector' }],
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
