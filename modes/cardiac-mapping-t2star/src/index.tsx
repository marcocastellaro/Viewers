import { Enums as csEnums } from '@cornerstonejs/core';
import { id } from './id';
import initWorkflowSteps from './initWorkflowSteps';
import initToolGroups from './initToolGroups';
import toolbarButtons from './toolbarButtons';

const extensionDependencies = {
  '@ohif/extension-default': '3.7.0-beta.76',
  '@ohif/extension-cornerstone': '3.7.0-beta.76',
  '@ohif/extension-cornerstone-dynamic-volume': '3.7.0-beta.76',
  '@ohif/extension-cornerstone-dicom-seg': '3.7.0-beta.76',
  '@ohif/extension-cornerstone-dicom-pmap': '3.7.0-beta.76',
  '@ohif/extension-tmtv': '3.7.0-beta.76',
  '@cardiomap/extension-cardiac-mapping': '0.1.0',
};

const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  defaultSopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  chartSopClassHandler: '@ohif/extension-default.sopClassHandlerModule.chart',
  hangingProtocol: '@ohif/extension-default.hangingProtocolModule.default',
  leftPanel: '@ohif/extension-default.panelModule.seriesList',
  chartViewport: '@ohif/extension-default.viewportModule.chartViewport',
};

const dynamicVolume = {
  leftPanel: '@ohif/extension-cornerstone-dynamic-volume.panelModule.dynamic-volume',
};

const cornerstone = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
  activeViewportWindowLevel: '@ohif/extension-cornerstone.panelModule.activeViewportWindowLevel',
};

const dicomSeg = {
  sopClassHandler: '@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg',
};

const dicomPmap = {
  sopClassHandler: '@ohif/extension-cornerstone-dicom-pmap.sopClassHandlerModule.dicom-pmap',
};

function modeFactory({ modeConfiguration }) {
  return {
    id,
    routeName: 'cardiac-mapping-t2star',
    displayName: 'Cardiac Mapping - T2star',
    onModeEnter: function ({ servicesManager, extensionManager, commandsManager }: withAppTypes) {
      const {
        measurementService,
        toolbarService,
        cineService,
        cornerstoneViewportService,
        toolGroupService,
        customizationService,
        viewportGridService,
        displaySetService,
        colorbarService,
        segmentationService,
      } = servicesManager.services;

      const utilityModule = extensionManager.getModuleEntry(
        '@ohif/extension-cornerstone.utilityModule.tools'
      );

      const { toolNames, Enums } = utilityModule.exports;

      // Segmentazione: solo riempimento, NIENTE contorno (evita il "doppio cerchio" col bordo
      // della mappa miocardio). Stile di default per tutti i labelmap del mode.
      try {
        segmentationService.setStyle(
          { type: Enums.SegmentationRepresentations.Labelmap },
          { renderOutline: false, renderOutlineInactive: false }
        );
      } catch (e) {
        /* stile best-effort */
      }

      measurementService.clearMeasurements();
      initToolGroups({ toolNames, Enums, toolGroupService, commandsManager, servicesManager });

      toolbarService.register(toolbarButtons);

      toolbarService.updateSection(toolbarService.sections.secondary, ['ProgressDropdown']);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.topLeft, [
        'orientationMenu',
        'dataOverlayMenu',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.topLeft, [
        'orientationMenu',
        'dataOverlayMenu',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.bottomMiddle, [
        'AdvancedRenderingControls',
      ]);

      toolbarService.updateSection('AdvancedRenderingControls', [
        'windowLevelMenuEmbedded',
        'voiManualControlMenu',
        'Colorbar',
        'opacityMenu',
        'thresholdMenu',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.topRight, [
        'modalityLoadBadge',
        'trackingStatus',
        'navigationComponent',
      ]);

      toolbarService.updateSection(toolbarService.sections.viewportActionMenu.bottomLeft, [
        'windowLevelMenu',
      ]);

      // the primary button section is created in the workflow steps
      // specific to the step
      customizationService.setCustomizations({
        'panelSegmentation.tableMode': {
          $set: 'expanded',
        },
        'panelSegmentation.onSegmentationAdd': {
          $set: () => {
            commandsManager.run('createNewLabelMapForDynamicVolume');
          },
        },
        'panelSegmentation.showAddSegment': {
          $set: false,
        },
      });

      // CardioMap: niente auto-play del cine (la navigazione echi resta manuale).

      // Post-load: rendering nearest su tutti i viewport + colorbar (ms) sul viewport mappa.
      const onViewportsReady = () => {
        // 1) nessuna interpolazione (pixel netti) su TUTTI i volumi del viewport
        //    (base + overlay colore): setProperties senza volumeId tocca solo il primo,
        //    quindi iteriamo gli actor e impostiamo NEAREST per ciascun volumeId.
        cornerstoneViewportService.getViewportIds().forEach(vpId => {
          const vp = cornerstoneViewportService.getCornerstoneViewport(vpId);
          try {
            const actors = vp?.getActors?.() || [];
            actors.forEach((entry: any) => {
              // 1) via API cornerstone (per-volume)
              if (entry?.uid) {
                try {
                  vp.setProperties({ interpolationType: csEnums.InterpolationType.NEAREST }, entry.uid);
                } catch (e) { /* */ }
              }
              // 2) diretto sul vtkVolumeProperty (robusto per i layer in fusione):
              //    l'interpolazione lineare sul myo map mascherato creava un bordo sfumato.
              try {
                entry?.actor?.getProperty?.().setInterpolationTypeToNearest?.();
              } catch (e) { /* actor non-volume */ }
            });
            if (!actors.length) {
              vp?.setProperties?.({ interpolationType: csEnums.InterpolationType.NEAREST });
            }
            vp?.render?.();
          } catch (e) {
            /* viewport non ancora pronto */
          }
        });
        // 2) colorbar sul viewport che mostra la mappa T2* (SeriesDescription "CardioMap T2map")
        try {
          const { viewports } = viewportGridService.getState();
          viewports.forEach((vp, vpId) => {
            const uids = vp.displaySetInstanceUIDs || [];
            const mapUID = uids.find(uid => {
              const ds = displaySetService.getDisplaySetByUID(uid);
              return ds && (ds.SeriesDescription || '').includes('T2map myo');
            });
            if (mapUID && colorbarService && !colorbarService.hasColorbar(vpId)) {
              commandsManager.run('toggleViewportColorbar', {
                viewportId: vpId,
                displaySetInstanceUIDs: [mapUID],
              });
            }
          });
        } catch (e) {
          /* colorbar best-effort */
        }
      };
      [
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        cornerstoneViewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
      ].forEach(ev =>
        cornerstoneViewportService.subscribe(ev, () => setTimeout(onViewportsReady, 100))
      );
    },
    onSetupRouteComplete: () => {
      // CardioMap: niente workflow-steps PET (forzavano l'HP default4D). Usiamo il nostro HP.
    },
    onModeExit: ({ servicesManager }: withAppTypes) => {
      const {
        toolGroupService,
        syncGroupService,
        segmentationService,
        cornerstoneViewportService,
      } = servicesManager.services;

      toolGroupService.destroy();
      syncGroupService.destroy();
      segmentationService.destroy();
      cornerstoneViewportService.destroy();
    },
    get validationTags() {
      return {
        study: [],
        series: [],
      };
    },
    isValidMode: ({ modalities }) => {
      // CardioMap: studi con MR (mapping T2* multi-echo).
      const list = (modalities || '').split('\\');
      return {
        valid: list.includes('MR'),
        description: 'Disponibile per studi MR (mapping T2* multi-echo).',
      };
    },

    /**
     * Mode Routes are used to define the mode's behavior. A list of Mode Route
     * that includes the mode's path and the layout to be used. The layout will
     * include the components that are used in the layout. For instance, if the
     * default layoutTemplate is used (id: '@ohif/extension-default.layoutTemplateModule.viewerLayout')
     * it will include the leftPanels, rightPanels, and viewports. However, if
     * you define another layoutTemplate that includes a Footer for instance,
     * you should provide the Footer component here too. Note: We use Strings
     * to reference the component's ID as they are registered in the internal
     * ExtensionManager. The template for the string is:
     * `${extensionId}.{moduleType}.${componentId}`.
     */
    routes: [
      {
        path: 'cardiac-mapping-t2star',
        layoutTemplate: ({ location, servicesManager }) => {
          return {
            id: ohif.layout,
            props: {
              // pannello PET dynamic-volume rimosso (crashava): lista serie standard
              leftPanels: [ohif.leftPanel],
              leftPanelResizable: true,
              // pannelli: segmentazione (opacita'/visibilita'), bull's eye, voxel
              rightPanels: [
                '@ohif/extension-cornerstone.panelModule.panelSegmentation',
                '@cardiomap/extension-cardiac-mapping.panelModule.cardiomapBullseye',
                '@cardiomap/extension-cardiac-mapping.panelModule.cardiomapVoxel',
              ],
              rightPanelResizable: true,
              rightPanelClosed: false,
              viewports: [
                {
                  namespace: cornerstone.viewport,
                  displaySetsToDisplay: [ohif.defaultSopClassHandler],
                },
                {
                  namespace: cornerstone.viewport,
                  displaySetsToDisplay: [dicomSeg.sopClassHandler, ohif.defaultSopClassHandler],
                },
              ],
            },
          };
        },
      },
    ],
    extensions: extensionDependencies,
    // HP CardioMap: seleziona la serie T2* e la mostra come volume 4D.
    hangingProtocol: 'cardiacMappingT2star',
    // Order is important in sop class handlers when two handlers both use
    // the same sop class under different situations.  In that case, the more
    // general handler needs to come last.  For this case, the dicomvideo must
    // come first to remove video transfer syntax before ohif uses images
    sopClassHandlers: [
      ohif.chartSopClassHandler,
      dicomPmap.sopClassHandler,
      dicomSeg.sopClassHandler,
      ohif.defaultSopClassHandler,
    ],
  };
}

const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export default mode;
