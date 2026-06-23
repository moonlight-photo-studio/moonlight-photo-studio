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
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

// ---- Google Drive User Account OAuth Setup ----
// FIXED: Hardcoded to use the Playground Client profile matching your exact token!
const oauth2Client = new google.auth.OAuth2(
  '407408718192.apps.googleusercontent.com', // Universal Playground Client ID
  '7991-b33od9b8v659',                       // Universal Playground Client Secret
  'https://developers.google.com/oauthplayground' 
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ---- Dual-Stage Automated Cleanup Background Worker ----
async function runStudioMaintenance() {
  console.log('🧹 Running system maintenance checks...');
  try {
    const now = new Date().toISOString();

    // STAGE 1: Sever access link permissions after 12 Hours
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
            });
          }
          await supabase.from('albums').update({ permission_severed: true }).eq('id', album.id);
          console.log(`🔒 Severed public access link for client album: ${album.client_name}`);
        } catch (err) {
          console.error(`Failed to sever access for album ${album.id}:`, err.message);
        }
      }
    }

    // STAGE 2: Permanently Delete from Drive after 3 Days (72 Hours)
    const { data: purgeAlbums } = await supabase
      .from('albums')
      .select('*')
      .lt('delete_at', now);

    if (purgeAlbums && purgeAlbums.length > 0) {
      for (const album of purgeAlbums) {
        try {
          if (album.google_folder_id) {
            await drive.files.delete({ fileId: album.google_folder_id });
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
setTimeout(runStudioMaintenance, 3000);

// ---- Routes ----

app.post('/upload', upload.array('photos'), async (req, res) => {
  try {
    const { client_name } = req.body;
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos uploaded' });

    const albumId = nanoid(8);

    // Step A: Create folder inside your personal master storage location
    const folderMetadata = {
      name: `${client_name} - ${albumId}`,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_MASTER_FOLDER_ID] 
    };

    const folder = await drive.files.create({
      requestBody: folderMetadata,
      fields: 'id, webViewLink'
    });
    const folderId = folder.data.id;

    // Step B: Direct image upload loops under your true account allocation profile
    for (const file of req.files) {
      const fileMetadata = {
        name: `${Date.now()}-${file.originalname}`,
        parents: [folderId]
      };

      const media = {
        mimeType: file.mimetype,
        body: require('stream').Readable.from(file.buffer)
      };

      await drive.files.create({ 
        requestBody: fileMetadata, 
        media: media 
      });
    }

    // Step C: Set public reading permission rules
    const permission = await drive.permissions.create({
      fileId: folderId,
      requestBody: { role: 'reader', type: 'anyone' },
      fields: 'id'
    });

    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); 
    const deleteAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); 

    // Step D: Record transaction into your database tracking index
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌙 User Quota Engine running safely on port ${PORT}`));
