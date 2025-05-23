import { NextRequest, NextResponse } from 'next/server';
import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { OpenAI } from 'openai';

export const config = {
  api: { bodyParser: false }
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

async function parseForm(req: NextRequest): Promise<{ filePath?: string; videoUrl?: string }> {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      uploadDir: os.tmpdir(),
      keepExtensions: true,
    });

    form.parse(req as any, (err, fields, files) => {
      if (err) return reject(err);
      const file = files.file?.[0] || files.file;
      const videoUrl = fields.videoUrl?.[0] || fields.videoUrl;
      if (file) {
        resolve({ filePath: file.filepath });
      } else if (videoUrl) {
        resolve({ videoUrl });
      } else {
        reject('No file or URL provided');
      }
    });
  });
}

async function downloadVideo(url: string): Promise<string> {
  const tempPath = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(tempPath);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(tempPath));
    writer.on('error', reject);
  });
}

export async function POST(req: NextRequest) {
  try {
    const { filePath, videoUrl } = await parseForm(req);

    const videoPath = filePath || await downloadVideo(videoUrl!);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(videoPath),
      model: 'whisper-1',
    });

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

    const result = gpt.choices[0].message.content;

    return NextResponse.json({ transcript: transcription.text, result });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
