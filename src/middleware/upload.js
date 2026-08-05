// Multer upload helpers for resident ID selfies and announcement poster images.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const residentUploadRoot = path.resolve(__dirname, '../../uploads/resident-ids');
const announcementUploadRoot = path.resolve(__dirname, '../../uploads/announcements');

// Make sure upload folders exist before saving files.
fs.mkdirSync(residentUploadRoot, { recursive: true });
fs.mkdirSync(announcementUploadRoot, { recursive: true });

// Save uploads to disk with a unique timestamped filename.
const createImageStorage = (destination) => multer.diskStorage({
  destination,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    callback(null, safeName);
  }
});

// Reject non-image uploads with a clear 400 error.
const imageFileFilter = (label) => (req, file, callback) => {
  if (!file.mimetype.startsWith('image/')) {
    return callback(Object.assign(new Error(`${label} must be an image file`), { statusCode: 400 }));
  }

  return callback(null, true);
};

// Middleware for registration selfie-with-ID (max 5MB).
export const uploadResidentId = multer({
  storage: createImageStorage(residentUploadRoot),
  fileFilter: imageFileFilter('Selfie with ID'),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// Middleware for announcement poster images (max 5MB).
export const uploadAnnouncementPoster = multer({
  storage: createImageStorage(announcementUploadRoot),
  fileFilter: imageFileFilter('Announcement poster'),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});
