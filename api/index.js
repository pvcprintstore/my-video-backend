const express = require('express');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const stream = require('stream');

// --- Express ऐप सेटअप ---
const app = express();
app.use(cors({ origin: true }));

// --- Firebase Admin SDK सेटअप ---
// यह जानकारी Vercel के Environment Variables से आएगी
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('ascii')
);
const databaseURL = process.env.FIREBASE_DATABASE_URL;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: databaseURL
  });
}
const db = admin.database();

// --- टेलीग्राम बॉट सेटअप ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const channelUsername = process.env.TELEGRAM_CHANNEL_USERNAME;
const bot = new TelegramBot(token);

// --- Multer (फाइल अपलोड हैंडलर) ---
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB वीडियो लिमिट
});

// --- मुख्य अपलोड लॉजिक ---
app.post('/api', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, category, description, duration, uploader, uploaderId } = req.body;
    const videoFile = req.files.video ? req.files.video[0] : null;
    const thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

    if (!videoFile) {
      return res.status(400).json({ message: 'Video file is required' });
    }
    
    // 1. वीडियो को टेलीग्राम पर भेजें
    const videoStream = new stream.PassThrough();
    videoStream.end(videoFile.buffer);
    const videoMsg = await bot.sendVideo(`@${channelUsername}`, videoStream, { caption: title });
    const videoPostId = videoMsg.message_id;

    // 2. थंबनेल को टेलीग्राम पर भेजें (अगर है तो)
    let finalThumbnailUrl = "https://placehold.co/600x400?text=No+Thumbnail"; // डिफ़ॉल्ट
    if (thumbnailFile) {
        const thumbStream = new stream.PassThrough();
        thumbStream.end(thumbnailFile.buffer);
        const thumbMsg = await bot.sendPhoto(`@${channelUsername}`, thumbStream);
        const fileId = thumbMsg.photo[thumbMsg.photo.length - 1].file_id; // सबसे अच्छी क्वालिटी वाला फोटो
        const file = await bot.getFile(fileId);
        finalThumbnailUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    }

    // 3. Firebase में डेटा सेव करें
    const videosRef = db.ref('videos');
    const newVideoRef = videosRef.push();
    await newVideoRef.set({
        title, category, description, duration, uploader, uploaderId,
        videoPostId, channelUsername,
        thumbnail: finalThumbnailUrl, // डायरेक्ट URL
        source: 'telegram_direct',
        timestamp: Date.now(),
        views: 0,
        status: 'live'
    });
    
    res.status(200).json({ message: 'Upload successful!', videoId: newVideoRef.key });

  } catch (error) {
    console.error('Error during upload:', error);
    res.status(500).json({ message: `Server error: ${error.message}` });
  }
});

// Vercel को बताने के लिए कि यह एक सर्वर है
module.exports = app;
