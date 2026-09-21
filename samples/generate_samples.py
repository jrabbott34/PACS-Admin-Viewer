import numpy as np, pydicom, datetime
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian, CTImageStorage, MRImageStorage, DigitalXRayImageStorageForPresentation
from PIL import Image, ImageDraw
import os

rng = np.random.default_rng(7)
os.makedirs("ct", exist_ok=True); os.makedirs("mr", exist_ok=True); os.makedirs("xr", exist_ok=True)
study_uid = generate_uid()

def base(sop_class, modality, series_uid, num, desc, series_no):
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = sop_class
    fm.MediaStorageSOPInstanceUID = generate_uid()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = fm
    ds.SOPClassUID = sop_class; ds.SOPInstanceUID = fm.MediaStorageSOPInstanceUID
    ds.PatientName = "PHANTOM^SYNTHETIC"; ds.PatientID = "TEST0001"; ds.PatientBirthDate = "19800101"; ds.PatientSex = "O"
    ds.StudyInstanceUID = study_uid; ds.SeriesInstanceUID = series_uid
    ds.StudyDate = "20260921"; ds.StudyDescription = "Synthetic viewer test study"; ds.AccessionNumber = "ACC123"
    ds.Modality = modality; ds.SeriesDescription = desc; ds.SeriesNumber = series_no; ds.InstanceNumber = num
    ds.InstitutionName = "Test Lab"
    return ds

# CT phantom
ct_uid = generate_uid()
N, S = 24, 256
yy, xx = np.mgrid[0:S, 0:S]
for i in range(N):
    z = i * 5.0
    hu = np.full((S, S), -1000.0)
    body = ((xx-128)/100.0)**2 + ((yy-128)/78.0)**2 < 1
    hu[body] = 40
    fat = body & ~(((xx-128)/92.0)**2 + ((yy-128)/70.0)**2 < 1)
    hu[fat] = -90
    # lungs shrink toward ends
    k = 1 - abs(i-N/2)/(N/1.6)
    for cx in (92, 164):
        lung = ((xx-cx)/(26*k+4))**2 + ((yy-118)/(38*k+4))**2 < 1
        hu[lung] = -820
    spine = ((xx-128)/14.0)**2 + ((yy-190)/14.0)**2 < 1
    hu[spine] = 650
    ribs = body & ~(((xx-128)/88.0)**2 + ((yy-128)/66.0)**2 < 1) & (((xx-128)/96.0)**2 + ((yy-128)/74.0)**2 < 1)
    hu[ribs & ((xx//6 + yy//6) % 5 == 0)] = 500
    heart = ((xx-138)/22.0)**2 + ((yy-132)/20.0)**2 < 1
    hu[heart] = 55
    hu += rng.normal(0, 6, hu.shape)
    px = np.clip(hu, -1024, 3000).astype(np.int16)
    ds = base(CTImageStorage, "CT", ct_uid, i+1, "Chest phantom 5mm", 2)
    ds.ImageOrientationPatient = [1,0,0,0,1,0]
    ds.ImagePositionPatient = [-100.0, -100.0, z]
    ds.SliceLocation = z; ds.SliceThickness = 5.0; ds.PixelSpacing = [0.8, 0.8]
    ds.KVP = 120; ds.BodyPartExamined = "CHEST"
    ds.RescaleIntercept = 0; ds.RescaleSlope = 1
    ds.WindowCenter = 40; ds.WindowWidth = 400
    ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = S; ds.Columns = S; ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 1
    ds.PixelData = px.tobytes()
    ds.save_as(f"ct/ct_{i+1:03d}.dcm", enforce_file_format=True)

# MR-ish unsigned 12-bit, out-of-order instance numbers for sort test
mr_uid = generate_uid()
S2 = 192
yy, xx = np.mgrid[0:S2, 0:S2]
for i in range(8):
    img = np.zeros((S2, S2))
    head = ((xx-96)/80.0)**2 + ((yy-96)/90.0)**2 < 1
    img[head] = 900
    brain = ((xx-96)/68.0)**2 + ((yy-96)/78.0)**2 < 1
    img[brain] = (1500 + 200*np.sin(xx/9.0 + i)*np.cos(yy/11.0))[brain]
    vent = ((xx-96)/10.0)**2 + ((yy-90)/24.0)**2 < 1
    img[vent] = 300
    img += rng.normal(0, 40, img.shape)
    px = np.clip(img, 0, 4095).astype(np.uint16)
    ds = base(MRImageStorage, "MR", mr_uid, i+1, "T2 axial phantom", 3)
    ds.ImageOrientationPatient = [1,0,0,0,1,0]
    ds.ImagePositionPatient = [-90.0, -90.0, 30.0 - i*4.0]  # descending z, instance ascending
    ds.SliceThickness = 4.0; ds.PixelSpacing = [1.2, 1.2]
    ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = S2; ds.Columns = S2; ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
    ds.PixelData = px.tobytes()
    ds.save_as(f"mr/mr_{i+1:03d}.dcm", enforce_file_format=True)

# MONOCHROME1 digital x-ray, 16-bit unsigned, no window tags
xr_uid = generate_uid()
S3 = 384
yy, xx = np.mgrid[0:S3, 0:S3]
img = np.full((S3, S3), 200.0)
chest = ((xx-192)/150.0)**2 + ((yy-200)/170.0)**2 < 1
img[chest] = 1800
for cx in (135, 250):
    img[((xx-cx)/48.0)**2 + ((yy-190)/90.0)**2 < 1] = 900
img[((xx-192)/12.0)**2 + ((yy-200)/150.0)**2 < 1] = 3000
img += rng.normal(0, 25, img.shape)
px = (4000 - np.clip(img, 0, 4000)).astype(np.uint16)  # MONOCHROME1: high = dark
ds = base(DigitalXRayImageStorageForPresentation, "DX", xr_uid, 1, "PA chest phantom", 1)
ds.PixelSpacing = [0.5, 0.5]; ds.BodyPartExamined = "CHEST"; ds.ViewPosition = "PA"
ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME1"
ds.Rows = S3; ds.Columns = S3; ds.BitsAllocated = 16; ds.BitsStored = 12; ds.HighBit = 11; ds.PixelRepresentation = 0
ds.PixelData = px.tobytes()
ds.save_as("xr/xr_001.dcm", enforce_file_format=True)

# JPG / PNG
im = Image.new("RGB", (640, 480), (30, 60, 90))
d = ImageDraw.Draw(im)
for k in range(0, 640, 40): d.line([(k,0),(k,480)], fill=(70,110,150))
for k in range(0, 480, 40): d.line([(0,k),(640,k)], fill=(70,110,150))
d.ellipse([200,120,440,360], fill=(220,180,60), outline=(255,255,255), width=4)
d.text((20,20), "JPEG test image", fill=(255,255,255))
im.save("photo.jpg", quality=90)
im2 = im.convert("RGBA"); d2 = ImageDraw.Draw(im2); d2.rectangle([0,0,120,120], fill=(0,0,0,0)); d2.text((20,440),"PNG w/ alpha", fill=(255,255,255,255))
im2.save("scan.png")

# PDF
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
c = canvas.Canvas("report.pdf", pagesize=letter)
for p in range(1, 3):
    c.setFont("Helvetica-Bold", 20); c.drawString(72, 700, f"Synthetic report - page {p}")
    c.setFont("Helvetica", 12); c.drawString(72, 670, "Findings: this is a test PDF for the viewer.")
    c.rect(72, 300, 300, 200); c.showPage()
c.save()
print("done")
