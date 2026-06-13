import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const residentUploadRoot = path.resolve(__dirname, '../../uploads/resident-ids');
const announcementUploadRoot = path.resolve(__dirname, '../../uploads/announcements');

fs.mkdirSync(residentUploadRoot, { recursive: true });
fs.mkdirSync(announcementUploadRoot, { recursive: true });

const createImageStorage = (destination) => multer.diskStorage({
  destination,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    callback(null, safeName);
  }
});

const imageFileFilter = (label) => (req, file, callback) => {
  if (!file.mimetype.startsWith('image/')) {
    return callback(Object.assign(new Error(`${label} must be an image file`), { statusCode: 400 }));
  }

  return callback(null, true);
};

export const uploadResidentId = multer({
  storage: createImageStorage(residentUploadRoot),
  fileFilter: imageFileFilter('Selfie with ID'),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

export const uploadAnnouncementPoster = multer({
  storage: createImageStorage(announcementUploadRoot),
  fileFilter: imageFileFilter('Announcement poster'),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});
