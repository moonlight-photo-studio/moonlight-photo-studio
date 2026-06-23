require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const path = require('path');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Cache images safely in memory
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

// ---- Google Drive API Setup ----
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  SCOPES
);
const drive = google.drive({ version: 'v3', auth });

// ---- Dual-Stage Automated Cleanup Background Worker ----
async function runStudioMaintenance() {
  console.log('🧹 Running system maintenance checks...');
  try {
    const now = new Date().toISOString();

    // STAGE 1: Sever Google Drive access permissions after 12 Hours
    const { data: cutAccessAlbums } = await supabase
      .from('albums')
      .select('*')
      .lt('expires_at', now)
      .eq('permission_severed', false);

    if (cutAccessAlbums && cutAccessAlbums.length > 0) {
      for (const album of cutAccessAlbums) {
        try {
          if (album.google_permission_id && album.google_folder_id) {
            await drive.permissions.delete({
              fileId: album.google_folder_id,
              permissionId: album.google_permission_id,
              supportsAllDrives: true // Force bypass quota rules on deletion
            });
          }
          await supabase.from('albums').update({ permission_severed: true }).eq('id', album.id);
          console.log(`🔒 Severed public access link for client album: ${album.client_name}`);
        } catch (err) {
          console.error(`Failed to sever access for album ${album.id}:`, err.message);
        }
      }
    }

    // STAGE 2: Permanently Delete the Folder from Drive after 3 Days (72 Hours)
    const { data: purgeAlbums } = await supabase
      .from('albums')
      .select('*')
      .lt('delete_at', now);

    if (purgeAlbums && purgeAlbums.length > 0) {
      for (const album of purgeAlbums) {
        try {
          if (album.google_folder_id) {
            await drive.files.delete({ 
              fileId: album.google_folder_id,
              supportsAllDrives: true // Force bypass quota rules on deletion
            });
            console.log(`🗑️ Permanently deleted Google Drive folder for: ${album.client_name}`);
          }
          await supabase.from('albums').delete().eq('id', album.id);
        } catch (err) {
          console.error(`Failed to delete folder for album ${album.id}:`, err.message);
        }
      }
    }
  } catch (globalCronErr) {
    console.error('Maintenance background loop error:', globalCronErr.message);
  }
}

cron.schedule('0 * * * *', runStudioMaintenance);
setTimeout(runStudioMaintenance, 5000);

// ---- Routes ----

// 1. Fully Automated Multi-File Uploader Route
app.post('/upload', upload.array('photos'), async (req, res) => {
  try {
    const { client_name } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos uploaded' });

    const albumId = nanoid(8);

    // Step A: Auto-Create the folder inside your shared Moonlight Master Folder
    const folderMetadata = {
      name: `${client_name} - ${albumId}`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_MASTER_FOLDER_ID] 
    };

    // FIXED: Added supportsAllDrives to leverage your main account's 15GB storage quota
    const folder = await drive.files.create({
      requestBody: folderMetadata,
      fields: 'id, webViewLink',
      supportsAllDrives: true
    });
    const folderId = folder.data.id;

    // Step B: Loop and upload files safely using a plain data payload stream
    for (const file of req.files) {
      const fileMetadata = {
        name: `${Date.now()}-${file.originalname}`,
        parents: [folderId]
      };

      const media = {
        mimeType: file.mimetype,
        body: require('stream').Readable.from(file.buffer)
      };

      // FIXED: Added supportsAllDrives here as well to inherit your primary storage account limits
      await drive.files.create({ 
        requestBody: fileMetadata, 
        media: media,
        supportsAllDrives: true
      });
    }

    // Step C: Open up sharing properties so public links can resolve the view
    const permission = await drive.permissions.create({
      fileId: folderId,
      requestBody: { role: 'reader', type: 'anyone' },
      fields: 'id',
      supportsAllDrives: true // Force inherit main permissions rule layout
    });

    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 Hours
    const deleteAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 Days

    // Step D: Write reference records to Supabase text fields
    const { error: dbError } = await supabase.from('albums').insert({
      id: albumId,
      client_name,
      expires_at: expiresAt,
      delete_at: deleteAt,
      google_folder_id: folderId,
      google_permission_id: permission.data.id,
      permission_severed: false,
      photos: [folder.data.webViewLink]
    });

    if (dbError) throw dbError;

    const albumUrl = `${process.env.BASE_URL}/album/${albumId}`;
    const qrDataURL = await QRCode.toDataURL(albumUrl, { width: 300, margin: 2 });

    res.json({ albumId, albumUrl, qrCode: qrDataURL });
  } catch (err) {
    console.error("🔥 CRITICAL BACKEND UPLOAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Client QR Scan Router
app.get('/album/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: album, error } = await supabase.from('albums').select('*').eq('id', id).single();

    if (error || !album) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

    const now = new Date();
    if (now > new Date(album.expires_at)) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

    res.redirect(album.photos[0]);
  } catch (err) {
    res.sendFile(path.join(__dirname, 'public', 'expired.html'));
  }
});

// 3. Fallback database endpoint logic
app.get('/api/album/:id', async (req, res) => {
  const { id } = req.params;
  const { data: album, error } = await supabase.from('albums').select('*').eq('id', id).single();

  if (error || !album) return res.status(404).json({ error: 'Album not found' });

  const now = new Date();
  if (now > new Date(album.expires_at)) return res.status(410).json({ error: 'Expired' });

  res.json(album);
});

// ---- Start Server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌙 Full-Auto Dual Timeline Engine active on port ${PORT}`));
