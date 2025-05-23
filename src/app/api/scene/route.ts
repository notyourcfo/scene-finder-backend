import { NextRequest, NextResponse } from 'next/server';
import { IncomingForm, Files, Fields } from 'formidable';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { OpenAI } from 'openai';

// Disable Next.js body parser for multipart/form-data
export const config = {
  api: { bodyParser: false },
};

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Download video from URL to temporary file
async function downloadVideo(url: string): Promise<string> {
  try {
    const tempPath = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 10000, // 10-second timeout
    });
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(tempPath));
      writer.on('error', reject);
    });
  } catch (err) {
    throw new Error(`Failed to download video: ${(err as Error).message}`);
  }
}

// Clean up temporary file
async function cleanupFile(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    console.error(`Failed to delete temp file ${filePath}:`, err);
  }
}

// Parse form data with formidable
async function parseForm(req: NextRequest): Promise<{ filePath?: string; videoUrl?: string }> {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      uploadDir: os.tmpdir(),
      keepExtensions: true,
      maxFileSize: 25 * 1024 * 1024, // 25MB limit (Whisper max)
    });

    form.parse(req as any, (err: Error | null, fields: Fields, files: Files) => {
      if (err) return reject(err);

      // Handle fields.videoUrl as string or string[]
      const videoUrl = Array.isArray(fields.videoUrl) ? fields.videoUrl[0] : fields.videoUrl;

      // Handle files.file as File or File[]
      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      if (file && 'filepath' in file) {
        resolve({ filePath: file.filepath });
      } else if (videoUrl) {
        resolve({ videoUrl });
      } else {
        reject(new Error('No file or URL provided'));
      }
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    // Validate environment variable
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    // Parse form data
    const { filePath, videoUrl } = await parseForm(req);

    let videoPath: string | undefined;
    try {
      // Handle URL or uploaded file
      if (videoUrl) {
        videoPath = await downloadVideo(videoUrl);
      } else if (filePath) {
        videoPath = filePath;
      } else {
        throw new Error('No video provided');
      }

      // Validate file size (Whisper limit: 25MB)
      const stats = await fs.stat(videoPath);
      if (stats.size > 25 * 1024 * 1024) {
        throw new Error('Video file exceeds 25MB limit');
      }

      // Transcribe using Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(videoPath),
        model: 'whisper-1',
      });

      // Analyze scene with GPT-4
      const gpt = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: `You are a scene analysis engine. Given a transcript, return JSON with:
- title
- season
- episode
- characters
- timestamp
- short scene description`,
          },
          {
            role: 'user',
            content: transcription.text,
          },
        ],
      });

      const result = JSON.parse(gpt.choices[0].message.content || '{}');

      return NextResponse.json({ transcript: transcription.text, result });
    } finally {
      // Clean up temporary file
      if (videoPath) {
        await cleanupFile(videoPath);
      }
    }
  } catch (err: any) {
    console.error('Error in /api/scene:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
