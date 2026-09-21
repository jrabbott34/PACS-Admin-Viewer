export type SeriesKind = 'dicom' | 'image' | 'pdf';

export interface InstanceInfo {
  imageId: string;
  sop: string;
  fileName: string;
  instanceNumber?: number;
  sliceLocation?: number;
  thickness?: number;
  /** ImagePositionPatient */
  position?: number[];
  /** Unit normal from ImageOrientationPatient */
  normal?: number[];
  /** 1-based frame number for multi-frame objects */
  frame?: number;
}

export interface Series {
  uid: string;
  studyUid: string;
  kind: SeriesKind;
  modality: string;
  seriesNumber?: number;
  seriesDescription: string;
  studyDescription: string;
  studyDate: string;
  patientName: string;
  patientId: string;
  institution: string;
  /** true when W/L does not apply (RGB, palette colour) */
  isColor: boolean;
  instances: InstanceInfo[];
}

export interface IngestReport {
  touched: Series[];
  instancesAdded: number;
  duplicates: number;
  skipped: { name: string; reason: string }[];
}
