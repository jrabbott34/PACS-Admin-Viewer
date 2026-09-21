export interface WindowPreset {
  label: string;
  width: number;
  center: number;
}

/** Common CT presets (Hounsfield units). */
export const CT_PRESETS: WindowPreset[] = [
  { label: 'Brain', width: 80, center: 40 },
  { label: 'Subdural', width: 300, center: 100 },
  { label: 'Stroke', width: 40, center: 40 },
  { label: 'Soft tissue', width: 400, center: 40 },
  { label: 'Liver', width: 150, center: 60 },
  { label: 'Mediastinum', width: 350, center: 50 },
  { label: 'Lung', width: 1500, center: -600 },
  { label: 'Bone', width: 2000, center: 500 },
];
