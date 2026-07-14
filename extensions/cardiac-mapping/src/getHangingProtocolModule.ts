// Hanging protocol CardioMap: layout 1x2.
//  - viewport sinistro: T2* multi-echo (volume 4D, navigazione echi)
//  - viewport destro: MAPPA T2* (parametric map 3D) con la SEGMENTAZIONE sovrapposta.
// La SEG referenzia la mappa (3D, posizioni uniche) -> si sovrappone su tutte le slice,
// aggirando il limite di OHIF nel mappare un SEG per-slice su un volume 4D.
// I due viewport sono sincronizzati (posizione camera + window level).
// Mappa e SEG compaiono dopo l'analisi (write-back); se assenti, il viewport destro e' vuoto.

// Solo sync spaziale (camera): scroll/zoom/pan condivisi fra i due viewport.
// NIENTE sync 'voi' -> brightness/contrasto (window/level) indipendenti per viewport.
const sync = [
  { type: 'cameraPosition', id: 'cardiacCamera', source: true, target: true },
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
      // solo la serie T2* multi-echo sorgente (SeriesDescription contiene "T2Star").
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        { attribute: 'SeriesDescription', constraint: { contains: 'T2Star' }, required: true },
      ],
    },
    segSelector: {
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'SEG' }, required: true },
      ],
    },
    mapSelector: {
      // la mappa T2* (serie immagine grayscale reinviata dal write-back).
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        { attribute: 'SeriesDescription', constraint: { contains: 'CardioMap T2map' }, required: true },
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
          displaySets: [{ id: 'mapSelector' }, { id: 'segSelector' }],
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
