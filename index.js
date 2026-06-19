require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

// ---- Setup ----
const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// ---- Auto Delete Expired Albums ----
async function cleanupExpiredAlbums() {
  console.log('🧹 Running cleanup...');

  // Find all expired albums
  const { data: expiredAlbums, error } = await supabase
    .from('albums')
    .select('*')
    .lt('expires_at', new Date().toISOString());

  if (error) return console.error('Cleanup error:', error.message);
  if (!expiredAlbums || expiredAlbums.length === 0) return console.log('✅ No expired albums to clean up.');

  for (const album of expiredAlbums) {
    // Delete each photo from storage
    if (album.photos && album.photos.length > 0) {
      const filePaths = album.photos.map(url => {
        const parts = url.split('/storage/v1/object/public/photos/');
        return parts[1];
      });

      const { error: storageError } = await supabase.storage
        .from('photos')
        .remove(filePaths);

      if (storageError) {
        console.error(`Storage delete error for album ${album.id}:`, storageError.message);
      } else {
        console.log(`🗑️ Deleted photos for album ${album.id}`);
      }
    }

    // Delete album from database
    const { error: dbError } = await supabase
      .from('albums')
      .delete()
      .eq('id', album.id);

    if (dbError) {
      console.error(`DB delete error for album ${album.id}:`, dbError.message);
    } else {
      console.log(`🗑️ Deleted album ${album.id} from database`);
    }
  }

  console.log(`✅ Cleanup done! Removed ${expiredAlbums.length} expired album(s).`);
}

// Run cleanup every hour
cron.schedule('0 * * * *', cleanupExpiredAlbums);

// Also run once on startup
cleanupExpiredAlbums();

// ---- Routes ----

// 1. Upload photos + create album
app.post('/upload', upload.array('photos'), async (req, res) => {
  const { client_name } = req.body;
  const albumId = nanoid(8);
  const photoUrls = [];

  for (const file of req.files) {
    const fileName = `${albumId}/${Date.now()}.jpg`;
    const fileBuffer = fs.readFileSync(file.path);

    const { error } = await supabase.storage
      .from('photos')
      .upload(fileName, fileBuffer, { contentType: file.mimetype });

    if (error) return res.status(500).json({ error: error.message });

    const { data: urlData } = supabase.storage
      .from('photos')
      .getPublicUrl(fileName);

    photoUrls.push(urlData.publicUrl);
    fs.unlinkSync(file.path);
  }

  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const { error: dbError } = await supabase.from('albums').insert({
    id: albumId,
    client_name,
    expires_at: expiresAt,
    photos: photoUrls,
  });

  if (dbError) return res.status(500).json({ error: dbError.message });

  const albumUrl = `${process.env.BASE_URL}/album/${albumId}`;
  const qrDataURL = await QRCode.toDataURL(albumUrl, {
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

  res.json({ albumId, albumUrl, qrCode: qrDataURL });
});

// 2. View album (what client sees when they scan QR)
app.get('/album/:id', async (req, res) => {
  const { id } = req.params;

  const { data: album, error } = await supabase
    .from('albums')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !album) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

  const now = new Date();
  if (now > new Date(album.expires_at)) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

  res.sendFile(path.join(__dirname, 'public', 'album.html'));
});

// 3. Get album data (used by album.html to load photos)
app.get('/api/album/:id', async (req, res) => {
  const { id } = req.params;

  const { data: album, error } = await supabase
    .from('albums')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !album) return res.status(404).json({ error: 'Album not found' });

  const now = new Date();
  if (now > new Date(album.expires_at)) return res.status(410).json({ error: 'Expired' });

  res.json(album);
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌙 Moonlight Photo Studio running on port ${PORT}`));