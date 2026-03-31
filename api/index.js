const express = require('express');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const stream = require('stream');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();

// === UPDATE: CORS को इस तरह इस्तेमाल करें ===
app.options('*', cors()); // OPTIONS pre-flight request को हैंडल करने के लिए
app.use(cors());          // बाकी सभी request के लिए

app.use(express.json());

// --- Firebase Admin SDK Setup ---
try {
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
} catch (e) {
    console.error("CRITICAL: Firebase Admin SDK initialization failed. Check your environment variables.", e);
}
const db = admin.database();

// ... बाकी का कोड बिल्कुल वैसा ही रहेगा जैसा पहले था ...
// (नीचे पूरा कोड है, बस कॉपी पेस्ट कर लें)

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelUsername = process.env.TELEGRAM_CHANNEL_USERNAME;
const bot = new TelegramBot(token);

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 2000 * 1024 * 1024 }
});

const generateThumbnail = (videoBuffer) => {
    return new Promise((resolve, reject) => {
        const tempVideoPath = path.join('/tmp', `video-${Date.now()}.mp4`);
        const tempThumbPath = path.join('/tmp', `thumb-${Date.now()}.jpg`);
        
        fs.writeFile(tempVideoPath, videoBuffer, (err) => {
            if (err) return reject(err);
            const command = `ffmpeg -i ${tempVideoPath} -ss 00:00:01.000 -vframes 1 ${tempThumbPath}`;
            
            exec(command, (error, stdout, stderr) => {
                fs.unlink(tempVideoPath, ()=>{});
                if (error) {
                    console.error("FFMPEG Error:", stderr);
                    return reject(new Error('Failed to generate thumbnail. Is ffmpeg installed?'));
                }
                fs.readFile(tempThumbPath, (thumbErr, thumbBuffer) => {
                    fs.unlink(tempThumbPath, ()=>{});
                    if (thumbErr) return reject(thumbErr);
                    resolve(thumbBuffer);
                });
            });
        });
    });
};

app.post('/api/upload', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, category, description, duration, uploader, uploaderId } = req.body;
    const videoFile = req.files.video ? req.files.video[0] : null;
    let thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

    if (!videoFile) return res.status(400).json({ message: 'Video file is required' });
    if (!uploaderId) return res.status(400).json({ message: 'Uploader ID is required' });
    
    const videoStream = new stream.PassThrough().end(videoFile.buffer);
    const videoMsg = await bot.sendVideo(`@${channelUsername}`, videoStream, { caption: title });
    const videoPostId = videoMsg.message_id;

    let finalThumbnailUrl = "https://placehold.co/600x400?text=No+Thumbnail";
    let thumbBuffer = thumbnailFile ? thumbnailFile.buffer : null;
    
    if (!thumbBuffer) {
        try {
            thumbBuffer = await generateThumbnail(videoFile.buffer);
        } catch (genError) {
            console.error("Could not auto-generate thumbnail:", genError.message);
        }
    }

    if (thumbBuffer) {
        const thumbStream = new stream.PassThrough().end(thumbBuffer);
        const thumbMsg = await bot.sendPhoto(`@${channelUsername}`, thumbStream);
        const fileId = thumbMsg.photo[thumbMsg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        finalThumbnailUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    }

    const newVideoRef = db.ref('videos').push();
    await newVideoRef.set({
        title: title || "Untitled Video", category, description, duration, uploader, uploaderId,
        videoPostId, channelUsername, thumbnail: finalThumbnailUrl, source: 'telegram_direct',
        timestamp: Date.now(), views: 0, status: 'live'
    });
    
    res.status(200).json({ message: 'Upload successful!', videoId: newVideoRef.key });
  } catch (error) {
    console.error('Error during upload process:', error);
    res.status(500).json({ message: `Server error: ${error.message || 'Unknown error'}` });
  }
});

app.post('/api/edit', async (req, res) => {
    try {
        const { videoId, title, description, category, uploaderId } = req.body;
        if (!videoId || !title || !category || !uploaderId) {
            return res.status(400).json({ message: 'Missing required fields for editing.' });
        }
        
        const videoRef = db.ref(`videos/${videoId}`);
        const snapshot = await videoRef.once('value');
        const videoData = snapshot.val();

        if (!videoData) return res.status(404).json({ message: "Video not found." });
        if (videoData.uploaderId !== uploaderId) return res.status(403).json({ message: "You are not authorized to edit this video." });

        await videoRef.update({ title, description, category });
        
        res.status(200).json({ message: "Video details updated successfully!" });
    } catch(error) {
        console.error('Error updating video details:', error);
        res.status(500).json({ message: `Server error: ${error.message}` });
    }
});

module.exports = app;
