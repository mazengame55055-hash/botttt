const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

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
const OWNER_IDS = ['820408813790167041', '1117202633510359070', '1154082560108920963'];

const IPTV = {
    host: 'http://ugeen.live',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    lowend: { width: 640, height: 360, fps: 20, bitrate: '500k', maxrate: '500k', bufsize: '1000k' },
    low: { width: 854, height: 480, fps: 24, bitrate: '800k', maxrate: '800k', bufsize: '1600k' },
    medium: { width: 960, height: 540, fps: 25, bitrate: '2000k', maxrate: '2000k', bufsize: '4000k' },
    high: { width: 1280, height: 720, fps: 30, bitrate: '2500k', maxrate: '2500k', bufsize: '5000k' },
};

let selectedQuality = QUALITY_PRESETS.medium;
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

async function runCommand(cmd, tell) {
    const trim = cmd.startsWith('!') ? cmd : '!' + cmd;
    try {
        if (trim === '!tv') {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) return tell('❌ لا توجد قنوات.');
            const entries = Object.entries(channels);
            const pages = [];
            for (let i = 0; i < entries.length; i += 50) {
                pages.push(entries.slice(i, i + 50).map(([k, v]) => `${k}. ${v.name}`).join('\n'));
            }
            tell(pages.map((p, i) => `صفحة ${i+1}/${pages.length}\n${p}`).join('\n\n---\n'));
            return;
        }

        if (trim.startsWith('!quality ')) {
            const preset = trim.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) return tell('❌ الخيارات: lowend, low, medium, high');
            selectedQuality = QUALITY_PRESETS[preset];
            return tell(`✅ الجودة: ${preset} (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (trim.startsWith('!play ')) {
            if (isPlaying) return tell('❌ يوجد بث. استعمل stop أولاً.');
            const channelKey = trim.split(' ')[1];
            const channels = await fetchChannels();
            if (!channels) return tell('❌ فشل جلب القنوات.');
            const channel = channels[channelKey];
            if (!channel) return tell(`❌ القناة ${channelKey} غير موجودة.`);

            abortController = new AbortController();
            currentChannelName = channel.name;
            isPlaying = true;
            tell(`⏳ جاري تشغيل ${channel.name}...`);

            await streamer.joinVoice(GUILD_ID, VOICE_ID);
            console.log(`Joined voice: ${channel.name}`);

            if (ffmpegPath) {
                const { width, height, fps, bitrate, maxrate, bufsize } = selectedQuality;
                ffmpegProcess = spawn(ffmpegPath, [
                    '-headers', 'User-Agent: VLC/3.0.20 LibVLC/3.0.20\r\n',
                    '-timeout', '30000000',
                    '-re',
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
                    '-s', `${width}x${height}`,
                    '-r', String(fps),
                    '-maxrate', maxrate,
                    '-bufsize', bufsize,
                    '-pix_fmt', 'yuv420p',
                    '-f', 'mpegts',
                    'pipe:1',
                ], { stdio: ['pipe', 'pipe', 'pipe'] });

                let ffmpegStderr = '';
                ffmpegProcess.stderr.on('data', (chunk) => ffmpegStderr += chunk.toString());
                ffmpegProcess.stdout.on('error', () => {});
                ffmpegProcess.on('error', (err) => console.error('FFmpeg error:', err.message));
                ffmpegProcess.on('exit', (code, signal) => {
                    console.log(`FFmpeg exit (code=${code}, signal=${signal})`);
                    if (code !== 0 && code !== null) {
                        console.error(ffmpegStderr.split('\n').slice(-5).join('\n'));
                    }
                    ffmpegProcess = null;
                });
                abortController.signal.addEventListener('abort', () => {
                    if (ffmpegProcess) { ffmpegProcess.kill('SIGKILL'); ffmpegProcess = null; }
                });

                const buf = new PassThrough({ highWaterMark: 1024 * 1024 * 16 });
                ffmpegProcess.stdout.pipe(buf);
                await playStream(buf, streamer, {
                    type: 'go-live', format: 'mpegts',
                    width: selectedQuality.width,
                    height: selectedQuality.height,
                    frameRate: selectedQuality.fps,
                });
            } else {
                const input = Readable.fromWeb(response.body);
                await playStream(input, streamer, {
                    type: 'go-live', format: 'mpegts',
                    width: selectedQuality.width,
                    height: selectedQuality.height,
                    frameRate: selectedQuality.fps,
                });
            }
            isPlaying = false;
            return tell(`✅ ${channel.name} انتهى البث.`);
        }

        if (trim === '!stop') {
            const name = currentChannelName || '';
            if (ffmpegProcess) { ffmpegProcess.kill('SIGKILL'); ffmpegProcess = null; }
            streamer.stopStream();
            streamer.leaveVoice();
            if (abortController) { abortController.abort(); abortController = null; }
            currentChannelName = null;
            isPlaying = false;
            return tell(`🛑 تم إيقاف ${name}.`);
        }

        if (trim === '!txt') {
            const channels = await fetchChannels();
            if (!channels || Object.keys(channels).length === 0) return;
            const lines = Object.entries(channels).map(([num, ch]) => `${num}. ${ch.name}`);
            const fp = path.join(__dirname, 'channels.txt');
            fs.writeFileSync(fp, lines.join('\n'), 'utf8');
            return tell(`✅ ${lines.length} قناة → channels.txt`);
        }

        if (trim === '!status') {
            const s = isPlaying ? `🎥 يشتغل: ${currentChannelName || 'قناة'}` : '🛑 متوقف';
            const q = `📐 ${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`;
            return tell(`${s}\n${q}`);
        }

        if (trim === '!help') {
            return tell([
                'الأوامر:', '',
                'play <رقم> - تشغيل قناة',
                'stop - إيقاف البث',
                'quality <lowend|low|medium|high>',
                'tv - عرض القنوات',
                'status - حالة البث',
                'txt - تصدير القنوات',
                'help - المساعدة',
            ].join('\n'));
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Error:', err.message);
            tell(`❌ ${err.message}`);
        }
        isPlaying = false;
        if (ffmpegProcess) { ffmpegProcess.kill('SIGKILL'); ffmpegProcess = null; }
        streamer.stopStream();
        streamer.leaveVoice();
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!OWNER_IDS.includes(message.author.id)) return;
    const tell = (t) => reply(message, t);
    await runCommand(message.content, tell);
});

const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd) runCommand(cmd, (t) => console.log(t));
    rl.prompt();
});
rl.prompt();

client.login(TOKEN);
