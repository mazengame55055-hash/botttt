const fs = require('fs');
const path = require('path');

// Auto-patch LibavDemuxer.js for Node v20 compatibility
const libavPath = path.join(__dirname, 'node_modules', '@dank074', 'discord-video-stream', 'dist', 'media', 'LibavDemuxer.js');
if (fs.existsSync(libavPath)) {
    let code = fs.readFileSync(libavPath, 'utf8');
    if (code.includes('const readFrame = pDebounce.promise') && !code.includes('let readFrame')) {
        code = code.replace(
            'export async function demux(input) {',
            'export async function demux(input) {\n    let readFrame;'
        );
        code = code.replace('const readFrame = pDebounce.promise', 'readFrame = pDebounce.promise');
        fs.writeFileSync(libavPath, code);
        console.log('Patched LibavDemuxer.js');
    }
}

const { Client } = require('discord.js-selfbot-v13');
const { Streamer, playStream } = require('@dank074/discord-video-stream');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffmpegPath = process.platform === 'win32' ? ffmpegStatic : '/usr/bin/ffmpeg';

const client = new Client();
const streamer = new Streamer(client);

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1483113341160259806';
const VOICE_ID = '1483120294917963891';
const OWNER_ID = '820408813790167041';

const IPTV = {
    host: 'http://ugeen.live',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    low: { width: 640, height: 360, fps: 15 },
    medium: { width: 854, height: 480, fps: 20 },
    high: { width: 1280, height: 720, fps: 25 },
    hd: { width: 1920, height: 1080, fps: 30 },
};

let selectedQuality = QUALITY_PRESETS.hd;
let currentChannelName = null;
let abortController = null;
let channelsCache = null;
let isPlaying = false;
let ffmpegProcess = null;

function parseM3U(m3uText) {
    const channels = {};
    const lines = m3uText.split('\n');
    let index = 1;
    let currentName = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
            const nameMatch = trimmed.match(/tvg-name="([^"]*)"/) || trimmed.match(/,([^,]+)$/);
            if (nameMatch) {
                currentName = nameMatch[1].trim();
            }
        } else if (trimmed.startsWith('http') && currentName) {
            channels[String(index)] = { name: currentName, url: trimmed };
            index++;
            currentName = null;
        }
    }
    return channels;
}

async function fetchChannels() {
    try {
        const response = await fetch(M3U_URL);
        const text = await response.text();
        channelsCache = parseM3U(text);
        console.log(`Fetched ${Object.keys(channelsCache).length} channels`);
        return channelsCache;
    } catch (err) {
        console.error('Failed to fetch M3U:', err.message);
        if (channelsCache) return channelsCache;
        return null;
    }
}

const PAGE_SIZE = 30;

async function showChannelsPage(message, channels, page) {
    const entries = Object.entries(channels);
    const total = entries.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const validPage = Math.max(1, Math.min(page, totalPages));
    const start = (validPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageEntries = entries.slice(start, end);
    const list = pageEntries.map(([key, ch]) =>
        `\`${String(key).padStart(3)}\` ${ch.name}`
    ).join('\n');
    const reply = [
        `📺 **قنوات IPTV** — الصفحة ${validPage}/${totalPages} (${total} قناة)`,
        '',
        list,
        '',
        validPage > 1 ? '🔹 `!tv ' + (validPage - 1) + '` → الصفحة السابقة' : '',
        validPage < totalPages ? '🔹 `!tv ' + (validPage + 1) + '` → الصفحة التالية' : '',
        '🔹 `!play <رقم>` للتشغيل',
        '🔹 `!stop` للإيقاف',
    ].filter(Boolean).join('\n');
    await message.reply(reply);
}

async function stopPlaying(message) {
    const name = currentChannelName || '';
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;
    }
    streamer.stopStream();
    streamer.leaveVoice();
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    currentChannelName = null;
    isPlaying = false;
    if (message) await message.reply(`🛑 تم إيقاف ${name ? `**${name}**` : 'البث'} ومغادرة الروم.`);
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    console.log(`FFmpeg path: ${ffmpegPath || 'NOT FOUND'}`);
    await fetchChannels();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.author.id !== OWNER_ID) return;

    try {
        if (message.content === '!tv') {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) {
                return message.reply('❌ لا توجد قنوات متاحة.');
            }
            await showChannelsPage(message, channels, 1);
        }

        if (/^!tv\s+\d+$/.test(message.content)) {
            const page = parseInt(message.content.split(' ')[1], 10);
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) {
                return message.reply('❌ لا توجد قنوات متاحة.');
            }
            await showChannelsPage(message, channels, page);
        }

        if (message.content.startsWith('!quality ')) {
            const preset = message.content.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) {
                return message.reply('❌ الخيارات: low, medium, high');
            }
            selectedQuality = QUALITY_PRESETS[preset];
            await message.reply(`✅ تم ضبط الجودة إلى **${preset}** (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (message.content.startsWith('!play ')) {
            if (isPlaying) {
                return message.reply('❌ يوجد بث قيد التشغيل حالياً. استعمل `!stop` أولاً.');
            }

            const channelKey = message.content.split(' ')[1];
            const channels = await fetchChannels();
            if (!channels) {
                return message.reply('❌ تعذر جلب القنوات.');
            }

            const channel = channels[channelKey];
            if (!channel) {
                return message.reply(`❌ القناة رقم ${channelKey} غير موجودة. اكتب \`!tv\` لعرض القنوات.`);
            }

            abortController = new AbortController();
            currentChannelName = channel.name;
            isPlaying = true;

            await message.reply(`⏳ جاري تشغيل **${channel.name}**...`);

            await streamer.joinVoice(GUILD_ID, VOICE_ID);
            console.log(`Joined voice, starting stream: ${channel.name}`);

            const response = await fetch(channel.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            response.body.cancel();

            if (ffmpegPath) {
                console.log('Using FFmpeg to transcode stream');

                try {
                    if (fs.existsSync(ffmpegPath)) {
                        fs.chmodSync(ffmpegPath, 0o777);
                        console.log('FFmpeg permissions set to 0o777');
                    }
                } catch (e) {
                    console.error('Could not change FFmpeg permissions:', e.message);
                }

                const { width, height, fps } = selectedQuality;
                ffmpegProcess = spawn(ffmpegPath, [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-analyzeduration', '500000',
                    '-probesize', '500000',
                    '-i', channel.url,
                    '-preset', 'medium',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
                    '-b:v', '4000k',
                    '-maxrate', '6000k',
                    '-bufsize', '8000k',
                    '-threads', '4',
                    '-c:a', 'libopus',
                    '-ac', '2',
                    '-b:a', '128k',
                    '-max_muxing_queue_size', '1024',
                    '-f', 'mpegts',
                    '-mpegts_flags', '+resend_headers',
                    'pipe:1',
                ], { stdio: ['pipe', 'pipe', 'pipe'] });

                let ffmpegStderr = '';
                ffmpegProcess.stderr.on('data', (chunk) => {
                    ffmpegStderr += chunk.toString();
                });
                ffmpegProcess.stdout.on('error', (err) => {
                    console.error('FFmpeg stdout error:', err.message);
                });
                ffmpegProcess.on('error', (err) => {
                    console.error('FFmpeg process error:', err.message);
                });
                ffmpegProcess.on('exit', (code, signal) => {
                    if (code !== 0 && code !== null) {
                        const lastLines = ffmpegStderr.split('\n').slice(-5).join('\n');
                        console.error(`FFmpeg exited (code=${code}, signal=${signal}):\n${lastLines}`);
                    }
                    ffmpegProcess = null;
                });

                abortController.signal.addEventListener('abort', () => {
                    if (ffmpegProcess) {
                        ffmpegProcess.kill('SIGKILL');
                        ffmpegProcess = null;
                    }
                });

                await playStream(ffmpegProcess.stdout, streamer, {
                    type: 'go-live',
                    format: 'mpegts',
                    width: selectedQuality.width,
                    height: selectedQuality.height,
                    frameRate: selectedQuality.fps,
                });
            } else {
                console.log('FFmpeg not found, using direct mode');
                const input = Readable.fromWeb(response.body);
                await playStream(input, streamer, {
                    type: 'go-live',
                    format: 'mpegts',
                    width: selectedQuality.width,
                    height: selectedQuality.height,
                    frameRate: selectedQuality.fps,
                });
            }

            isPlaying = false;
            await message.reply(`🎥 **${channel.name}** انتهى البث.`);
        }

        if (message.content === '!stop') {
            await stopPlaying(message);
        }

        if (message.content === '!help') {
            const reply = [
                '🤖 **الأوامر:**',
                '',
                '`!tv` - عرض قائمة القنوات',
                '`!play <رقم>` - تشغيل قناة',
                '`!stop` - إيقاف البث',
                '`!quality <low|medium|high>` - ضبط الجودة',
                '`!status` - حالة البث',
                '`!help` - المساعدة',
            ].join('\n');
            await message.reply(reply);
        }

        if (message.content === '!status') {
            const status = isPlaying
                ? `🎥 **يشتغل:** ${currentChannelName || 'قناة'}`
                : '🛑 **متوقف**';
            const quality = `📐 **الجودة:** ${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`;
            await message.reply(`${status}\n${quality}`);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            isPlaying = false;
            return;
        }
        console.error('Error:', err);
        isPlaying = false;
        try {
            await message.reply(`❌ خطأ: ${err.message || 'حدث خطأ غير متوقع'}`);
        } catch (_) {}
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGKILL');
            ffmpegProcess = null;
        }
        streamer.stopStream();
        streamer.leaveVoice();
    }
});

client.login(TOKEN);
