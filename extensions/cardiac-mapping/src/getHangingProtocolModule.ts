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
  name: 'CMR-QMapping',
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
      // BASE: mappa T2* completa in grayscale ("CardioMap T2map full").
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        { attribute: 'SeriesDescription', constraint: { contains: 'T2map full' }, required: true },
      ],
    },
    myoMapSelector: {
      // OVERLAY colore: mappa T2* del solo miocardio ("CardioMap T2map myo").
      seriesMatchingRules: [
        { attribute: 'Modality', constraint: { equals: 'MR' }, required: true },
        { attribute: 'SeriesDescription', constraint: { contains: 'T2map myo' }, required: true },
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
          displaySets: [
            // LAYER 1 (base): mappa T2* completa in scala di grigi
            {
              id: 'mapSelector',
              options: { voi: { windowCenter: 40, windowWidth: 80 } },
            },
            // LAYER 2 (foreground): mappa del miocardio a colori (inferno), trasparente solo
            // fuori dal miocardio (value 0 -> opacity 0). Nessuna soglia sui valori bassi.
            {
              id: 'myoMapSelector',
              options: {
                voi: { windowCenter: 40, windowWidth: 80 },
                colormap: {
                  name: 'Inferno (matplotlib)',
                  opacity: [
                    { value: 0, opacity: 0 },
                    { value: 0.02, opacity: 1 },
                    { value: 1, opacity: 1 },
                  ],
                },
              },
            },
            // LAYER 3: segmentazione (opacita' regolabile dal pannello Segmentations)
            { id: 'segSelector' },
          ],
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
