require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Use express.json() because we are sending standard JSON text strings now, not files!
app.use(express.json());
app.use(express.static('public'));

// ---- Routes ----

// 1. Save Drive link + create QR entry
app.post('/upload', async (req, res) => {
  const { client_name, drive_url } = req.body;
  
  if (!client_name || !drive_url) {
    return res.status(400).json({ error: 'Missing client name or drive link' });
  }

  const albumId = nanoid(8);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12-hour expiration window

  // Save only the text strings to your free Supabase DB
  const { error: dbError } = await supabase.from('albums').insert({
    id: albumId,
    client_name,
    expires_at: expiresAt,
    photos: [drive_url], // Storing it inside an array so you don't have to rebuild table schemas
  });

  if (dbError) return res.status(500).json({ error: dbError.message });

  const albumUrl = `${process.env.BASE_URL}/album/${albumId}`;
  const qrDataURL = await QRCode.toDataURL(albumUrl, {
    width: 300,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });

  res.json({ albumId, albumUrl, qrCode: qrDataURL });
});

// 2. Scan QR handler (Bounces user to Drive if alive, otherwise blocks them)
app.get('/album/:id', async (req, res) => {
  const { id } = req.params;

  const { data: album, error } = await supabase
    .from('albums')
    .select('*')
    .eq('id', id)
    .single();

  // If missing or deleted, throw the error page
  if (error || !album) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

  // If time run out, throw the error page
  const now = new Date();
  if (now > new Date(album.expires_at)) return res.sendFile(path.join(__dirname, 'public', 'expired.html'));

  // SUCCESS: Directly redirect their mobile phone browser straight into the target Google Drive 
  const targetDriveLink = album.photos[0];
  res.redirect(targetDriveLink);
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌙 Text Redirect Server running on port ${PORT}`));
