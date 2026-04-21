'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_DRIVE_ROOT_ID = process.env.FACEBOOK_PACKS_DRIVE_FOLDER_ID || process.env.DRIVE_FOLDER_ID || '';

function driveFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

async function gogJson(args, options = {}) {
  const { stdout } = await execFileAsync('gog', ['-j', '--results-only', ...args], {
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  return stdout ? JSON.parse(stdout) : null;
}

async function ensureDriveFolder(name, parentId) {
  const query = [
    `name = '${String(name).replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    `'${parentId}' in parents`,
  ].join(' and ');

  const existing = await gogJson(['drive', 'ls', '--parent', parentId, '--query', query, '--max', '5']);
  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }

  return gogJson(['drive', 'mkdir', name, '--parent', parentId]);
}

async function uploadFile(localPath, parentId, name) {
  return gogJson(['drive', 'upload', localPath, '--parent', parentId, '--name', name]);
}

async function shareAnyoneReader(fileId) {
  try {
    await gogJson(['drive', 'share', fileId, '--to', 'anyone', '--role', 'reader']);
  } catch (error) {
    if (!String(error.stderr || error.message || '').includes('already')) throw error;
  }
}

async function uploadDirectoryTree(localDir, parentId) {
  const entries = fs.readdirSync(localDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      const folder = await ensureDriveFolder(entry.name, parentId);
      await uploadDirectoryTree(fullPath, folder.id);
    } else if (entry.isFile()) {
      await uploadFile(fullPath, parentId, entry.name);
    }
  }
}

async function uploadFacebookPackToDrive(packDir, { rootFolderId = DEFAULT_DRIVE_ROOT_ID } = {}) {
  if (!rootFolderId) throw new Error('FACEBOOK_PACKS_DRIVE_FOLDER_ID or DRIVE_FOLDER_ID is required');
  if (!fs.existsSync(packDir)) throw new Error(`Pack directory does not exist: ${packDir}`);

  const dateFolderName = path.basename(packDir);
  const parentFolder = await ensureDriveFolder('facebook-packs', rootFolderId);
  const packFolder = await ensureDriveFolder(dateFolderName, parentFolder.id);

  await uploadDirectoryTree(packDir, packFolder.id);
  await shareAnyoneReader(packFolder.id);

  return {
    rootFolderId,
    parentFolderId: parentFolder.id,
    folderId: packFolder.id,
    folderUrl: driveFolderUrl(packFolder.id),
  };
}

module.exports = {
  uploadFacebookPackToDrive,
  driveFolderUrl,
};
