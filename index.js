const fs = require('fs');
const path = require('path');

// Auto-patch LibavDemuxer.js for Node v20 compatibility
const libavPath = path.join(__dirname, 'node_modules', '@dank074', 'discord-video-stream', 'dist', 'media', 'LibavDemuxer.js');
if (fs.existsSync(libavPath)) {
    let code = fs.readFileSync(libavPath, 'utf8');
    if (code.includes('const readFrame = pDebounce.promise') && !code.includes('let readFrame')) {
        code = code.replace(
            'async function demux(input, { format }) {',
            'async function demux(input, { format }) {\n    let readFrame;'
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

async function reply(msg, text) {
    try { await msg.reply(text); } catch (e) { console.log('[reply blocked]', e.message); }
}

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1324034047613079574';
const VOICE_ID = '1523292663636295811';
const OWNER_IDS = ['820408813790167041', '1117202633510359070'];

const IPTV = {
    host: 'http://ugeen.live',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    low: { width: 640, height: 360, fps: 15, bitrate: '800k' },
    medium: { width: 854, height: 480, fps: 20, bitrate: '1200k' },
    high: { width: 1280, height: 720, fps: 30, bitrate: '1500k' },
    hd: { width: 1920, height: 1080, fps: 30, bitrate: '4000k' },
};

let selectedQuality = QUALITY_PRESETS.high;
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
    await reply(message, reply);
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
    if (message) await reply(message, `🛑 تم إيقاف ${name ? `**${name}**` : 'البث'} ومغادرة الروم.`);
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    console.log(`FFmpeg path: ${ffmpegPath || 'NOT FOUND'}`);
    await fetchChannels();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!OWNER_IDS.includes(message.author.id)) return;

    try {
        if (message.content === '!tv') {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) {
                return reply(message, '❌ لا توجد قنوات متاحة.');
            }
            await showChannelsPage(message, channels, 1);
        }

        if (/^!tv\s+\d+$/.test(message.content)) {
            const page = parseInt(message.content.split(' ')[1], 10);
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) {
                return reply(message, '❌ لا توجد قنوات متاحة.');
            }
            await showChannelsPage(message, channels, page);
        }

        if (message.content.startsWith('!quality ')) {
            const preset = message.content.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) {
                return reply(message, '❌ الخيارات: low, medium, high');
            }
            selectedQuality = QUALITY_PRESETS[preset];
            await reply(message, `✅ تم ضبط الجودة إلى **${preset}** (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (message.content.startsWith('!play ')) {
            if (isPlaying) {
                return reply(message, '❌ يوجد بث قيد التشغيل حالياً. استعمل `!stop` أولاً.');
            }

            const channelKey = message.content.split(' ')[1];
            const channels = await fetchChannels();
            if (!channels) {
                return reply(message, '❌ تعذر جلب القنوات.');
            }

            const channel = channels[channelKey];
            if (!channel) {
                return reply(message, `❌ القناة رقم ${channelKey} غير موجودة. اكتب \`!tv\` لعرض القنوات.`);
            }

            abortController = new AbortController();
            currentChannelName = channel.name;
            isPlaying = true;

            await reply(message, `⏳ جاري تشغيل **${channel.name}**...`);

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

                ffmpegProcess = spawn(ffmpegPath, [
                    '-headers', 'User-Agent: VLC/3.0.20 LibVLC/3.0.20\r\n',
                    '-timeout', '30000000',
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '10',
                    '-reconnect_at_eof', '1',
                    '-reconnect_on_network_error', '1',
                    '-analyzeduration', '2000000',
                    '-probesize', '2000000',
                    '-thread_queue_size', '512',
                    '-i', channel.url,
                    '-fflags', '+nobuffer+discardcorrupt',
                    '-flags', '+low_delay',
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-ar', '48000',
                    '-c:a', 'libopus',
                    '-b:a', '96k',
                    '-s', '1280x720',
                    '-r', '30',
                    '-maxrate', '2500k',
                    '-bufsize', '5000k',
                    '-pix_fmt', 'yuv420p',
                    '-f', 'mpegts',
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
                width: 1280,
                height: 720,
                frameRate: 30,
            });
            } else {
                console.log('FFmpeg not found, using direct mode');
                const input = Readable.fromWeb(response.body);
                await playStream(input, streamer, {
                    type: 'go-live',
                    format: 'mpegts',
                    width: 854,
                    height: 480,
                    frameRate: 24,
                });
            }

            isPlaying = false;
            await reply(message, `🎥 **${channel.name}** انتهى البث.`);
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
            await reply(message, reply);
        }

        if (message.content === '!status') {
            const status = isPlaying
                ? `🎥 **يشتغل:** ${currentChannelName || 'قناة'}`
                : '🛑 **متوقف**';
            const quality = `📐 **الجودة:** ${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`;
            await reply(message, `${status}\n${quality}`);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            isPlaying = false;
            return;
        }
        console.error('Error:', err);
        isPlaying = false;
        try {
            await reply(message, `❌ خطأ: ${err.message || 'حدث خطأ غير متوقع'}`);
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
