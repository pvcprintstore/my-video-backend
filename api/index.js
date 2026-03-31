// NEW BACKEND CODE FOR /api/index.js (GitHub)

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
app.use(cors({ origin: true }));
app.use(express.json()); // Important for the new /api/edit endpoint

// --- Firebase Admin SDK Setup ---
try {
    // Make sure your environment variables are set correctly in Vercel
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

// --- Telegram Bot Setup ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const channelUsername = process.env.TELEGRAM_CHANNEL_USERNAME;
const bot = new TelegramBot(token);

// --- Multer (File Upload Handler) ---
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 2000 * 1024 * 1024 } // === UPDATE: Limit increased to 2GB ===
});

// --- Function to generate thumbnail from video ---
const generateThumbnail = (videoBuffer) => {
    return new Promise((resolve, reject) => {
        const tempVideoPath = path.join('/tmp', `video-${Date.now()}.mp4`);
        const tempThumbPath = path.join('/tmp', `thumb-${Date.now()}.jpg`);
        
        fs.writeFile(tempVideoPath, videoBuffer, (err) => {
            if (err) return reject(err);

            // Using ffmpeg to extract a frame after 1 second
            const command = `ffmpeg -i ${tempVideoPath} -ss 00:00:01.000 -vframes 1 ${tempThumbPath}`;
            
            exec(command, (error, stdout, stderr) => {
                fs.unlink(tempVideoPath, ()=>{}); // Clean up video file immediately
                if (error) {
                    console.error("FFMPEG Error:", stderr);
                    return reject(new Error('Failed to generate thumbnail. Is ffmpeg installed?'));
                }
                fs.readFile(tempThumbPath, (thumbErr, thumbBuffer) => {
                    fs.unlink(tempThumbPath, ()=>{}); // Clean up thumbnail file
                    if (thumbErr) return reject(thumbErr);
                    resolve(thumbBuffer);
                });
            });
        });
    });
};

// --- Main Upload Logic ---
app.post('/api/upload', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, category, description, duration, uploader, uploaderId } = req.body;
    const videoFile = req.files.video ? req.files.video[0] : null;
    let thumbnailFile = req.files.thumbnail ? req.files.thumbnail[0] : null;

    if (!videoFile) return res.status(400).json({ message: 'Video file is required' });
    if (!uploaderId) return res.status(400).json({ message: 'Uploader ID is required' });
    
    // 1. Send video to Telegram
    console.log(`Uploading video for ${uploader}...`);
    const videoStream = new stream.PassThrough().end(videoFile.buffer);
    const videoMsg = await bot.sendVideo(`@${channelUsername}`, videoStream, { caption: title });
    const videoPostId = videoMsg.message_id;
    console.log(`Video sent to Telegram. Post ID: ${videoPostId}`);

    // 2. Handle Thumbnail
    let finalThumbnailUrl = "https://placehold.co/600x400?text=No+Thumbnail";
    let thumbBuffer = thumbnailFile ? thumbnailFile.buffer : null;
    
    // === UPDATE: Auto-generate thumbnail if not provided ===
    if (!thumbBuffer) {
        try {
            console.log("No thumbnail provided, attempting to generate one...");
            thumbBuffer = await generateThumbnail(videoFile.buffer);
            console.log("Thumbnail generated successfully.");
        } catch (genError) {
            console.error("Could not auto-generate thumbnail:", genError.message);
        }
    }

    if (thumbBuffer) {
        console.log("Uploading thumbnail to Telegram...");
        const thumbStream = new stream.PassThrough().end(thumbBuffer);
        const thumbMsg = await bot.sendPhoto(`@${channelUsername}`, thumbStream);
        const fileId = thumbMsg.photo[thumbMsg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        finalThumbnailUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        console.log("Thumbnail uploaded.");
    }

    // 3. Save to Firebase
    console.log("Saving video metadata to Firebase...");
    const newVideoRef = db.ref('videos').push();
    await newVideoRef.set({
        title: title || "Untitled Video",
        category, description, duration, uploader, uploaderId,
        videoPostId, channelUsername,
        thumbnail: finalThumbnailUrl,
        source: 'telegram_direct',
        timestamp: Date.now(),
        views: 0,
        status: 'live'
    });
    console.log("Firebase entry created. Key:", newVideoRef.key);
    
    res.status(200).json({ message: 'Upload successful!', videoId: newVideoRef.key });

  } catch (error) {
    console.error('Error during upload process:', error);
    res.status(500).json({ message: `Server error: ${error.message || 'Unknown error'}` });
  }
});

// === UPDATE: New endpoint for editing video details ===
app.post('/api/edit', async (req, res) => {
    try {
        const { videoId, title, description, category, uploaderId } = req.body;

        if (!videoId || !title || !category || !uploaderId) {
            return res.status(400).json({ message: 'Missing required fields for editing.' });
        }
        
        const videoRef = db.ref(`videos/${videoId}`);
        const snapshot = await videoRef.once('value');
        const videoData = snapshot.val();

        if (!videoData) {
            return res.status(404).json({ message: "Video not found." });
        }

        // Security check: Make sure the person editing owns the video
        if (videoData.uploaderId !== uploaderId) {
             return res.status(403).json({ message: "You are not authorized to edit this video." });
        }

        await videoRef.update({ title, description, category });
        
        console.log(`Video ${videoId} updated by ${uploaderId}.`);
        res.status(200).json({ message: "Video details updated successfully!" });

    } catch(error) {
        console.error('Error updating video details:', error);
        res.status(500).json({ message: `Server error: ${error.message}` });
    }
});


// Export the app for Vercel
module.exports = app;
