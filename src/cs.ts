import { init as coreInit } from '@cornerstonejs/core';
import * as tools from '@cornerstonejs/tools';
import { init as dicomLoaderInit } from '@cornerstonejs/dicom-image-loader';

let ready: Promise<void> | null = null;

/** One-time initialisation of Cornerstone3D, its tools and the DICOM image loader. */
export function initCornerstone(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await coreInit();
      dicomLoaderInit({
        maxWebWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
        useLegacyMetadataProvider: true,
      });
      tools.init();
      for (const t of [
        tools.WindowLevelTool,
        tools.PanTool,
        tools.ZoomTool,
        tools.StackScrollTool,
        tools.LengthTool,
        tools.AngleTool,
        tools.RectangleROITool,
        tools.EllipticalROITool,
        tools.ProbeTool,
      ]) {
        tools.addTool(t);
      }
    })();
  }
  return ready;
}
