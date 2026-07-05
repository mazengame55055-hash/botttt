const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

if (!global.WebSocket) {
  try { global.WebSocket = require('ws'); } catch (_) {}
}

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

const client = new Client({ intents: 33281 });
const streamer = new Streamer(client);

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1324034047613079574';
const VOICE_ID = '1523292663636295811';
const VOICE_TEXT_ID = '1523292663636295811';
const OWNER_IDS = ['820408813790167041', '1117202633510359070', '1154082560108920963', '1120172313401364572', '742858908774826045'];

const IPTV = {
    host: 'http://ugeen.live',
    ip: 'http://176.123.9.60',
    port: '8080',
    user: 'Ugeen_VIP1pjmEs',
    pass: 'v0CvBh',
};

const M3U_URL = `${IPTV.ip}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u_plus&output=ts`;

const QUALITY_PRESETS = {
    lowend: { width: 640, height: 360, fps: 20, vb: '500k', maxrate: '500k', bufsize: '1000k' },
    low: { width: 854, height: 480, fps: 24, vb: '800k', maxrate: '800k', bufsize: '1600k' },
    medium: { width: 960, height: 540, fps: 25, vb: '2000k', maxrate: '2000k', bufsize: '4000k' },
    high: { width: 1280, height: 720, fps: 30, vb: '2500k', maxrate: '2500k', bufsize: '5000k' },
};

let selectedQuality = QUALITY_PRESETS.lowend;
let currentChannelName = null;
let channelsCache = null;
let isPlaying = false;
let ffmpegProcess = null;

function findFfmpeg() {
    const paths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
    for (const p of paths) { if (fs.existsSync(p)) return p; }
    try { const r = execSync('which ffmpeg', { encoding: 'utf8', timeout: 3000 }); if (r) return r.trim(); } catch (_) {}
    try { const r = execSync('where ffmpeg', { encoding: 'utf8', timeout: 3000 }); if (r) return r.trim().split('\n')[0]; } catch (_) {}
    return null;
}
const ffmpegPath = findFfmpeg();

function parseM3U(text) {
    const channels = {};
    const lines = text.split('\n');
    let idx = 1, name = null;
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('#EXTINF:')) {
            const m = t.match(/tvg-name="([^"]*)"/) || t.match(/,([^,]+)$/);
            if (m) name = m[1].trim();
        } else if (t.startsWith('http') && name) {
            channels[String(idx++)] = { name, url: t.replace('ugeen.live', '176.123.9.60') };
            name = null;
        }
    }
    return channels;
}

async function fetchChannels() {
    if (channelsCache) return channelsCache;
    const urls = [
        M3U_URL, M3U_URL.replace('&output=ts', ''),
        `${IPTV.host}:${IPTV.port}/get.php?username=${IPTV.user}&password=${IPTV.pass}&type=m3u`,
    ];
    for (const url of urls) {
        try {
            const r = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(10000),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const text = await r.text();
            if (!text.startsWith('#EXTM3U')) throw new Error('Not M3U');
            channelsCache = parseM3U(text);
            console.log(`Fetched ${Object.keys(channelsCache).length} channels`);
            return channelsCache;
        } catch (e) {
            console.error(`Fail: ${url.slice(0, 60)}... ${e.message}`);
        }
    }
    throw new Error('Failed to fetch channels');
}

async function playLoop(channel) {
    const tmpDir = '/tmp/iptv';
    fs.mkdirSync(tmpDir, { recursive: true });
    let segNum = 0;

    function produceSeg() {
        const outFile = `${tmpDir}/seg_${++segNum}.ts`;
        const q = selectedQuality;
        const args = [
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
            '-timeout', '30000000',
            '-i', channel.url,
            '-t', '60',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p', '-b:v', q.vb, '-maxrate', q.maxrate,
            '-bufsize', q.bufsize, '-r', String(q.fps), '-vsync', 'cfr',
            '-c:a', 'libopus', '-b:a', '48k', '-ac', '1',
            '-f', 'mpegts', '-y', outFile,
        ];
        const proc = spawn(ffmpegPath, args);
        ffmpegProcess = proc;
        proc.stderr.on('data', () => {});
        const p = new Promise((resolve, reject) => {
            proc.on('exit', code => code === 0 ? resolve(outFile) : reject(new Error(`ffmpeg exit ${code}`)));
            proc.on('error', reject);
        });
        return { file: outFile, promise: p, proc };
    }

    console.log(`Segment 1...`);
    let current = produceSeg();
    let currentFile;
    try { currentFile = await current.promise; } catch (e) { if (!isPlaying) return; throw e; }
    if (!isPlaying) return;

    let next = produceSeg();

    while (isPlaying) {
        const fileStream = fs.createReadStream(currentFile);
        await playStream(fileStream, streamer, {
            type: 'go-live', format: 'mpegts',
            width: selectedQuality.width, height: selectedQuality.height,
            frameRate: selectedQuality.fps,
        });
        if (!isPlaying) break;

        console.log('Waiting for next segment...');
        let nextFile;
        try { nextFile = await next.promise; } catch (e) { if (!isPlaying) break; throw e; }
        if (!isPlaying) break;

        try { fs.unlinkSync(currentFile); } catch (_) {}
        currentFile = nextFile;
        next = produceSeg();
    }
}

client.on('ready', async () => {
    console.log(`Logged in as: ${client.user.tag}`);
    if (ffmpegPath) console.log(`FFmpeg: ${ffmpegPath}`);
    else console.log('FFmpeg NOT FOUND');
    try { await fetchChannels(); } catch (_) {}
    const keep = async () => {
        try { await streamer.joinVoice(GUILD_ID, VOICE_ID).catch(() => {}); console.log('Voice OK'); } catch (_) {}
    };
    await keep();
    setInterval(keep, 300000);
});

async function runCommand(cmd, reply) {
    const trim = cmd.startsWith('!') ? cmd.slice(1) : cmd;
    try {
        if (trim === 'tv' || /^tv \d+$/.test(trim)) {
            const ch = await fetchChannels();
            if (!ch || !Object.keys(ch).length) return reply('No channels.');
            const page = trim === 'tv' ? 1 : parseInt(trim.split(' ')[1], 10);
            const entries = Object.entries(ch);
            const totalPages = Math.ceil(entries.length / 30);
            const p = Math.max(1, Math.min(page, totalPages));
            const list = entries.slice((p - 1) * 30, p * 30).map(([k, v]) => `${k}. ${v.name}`).join('\n');
            return reply(`Page ${p}/${totalPages} (${entries.length} channels)\n${list}`);
        }

        if (trim.startsWith('quality ')) {
            const preset = trim.split(' ')[1];
            if (!QUALITY_PRESETS[preset]) return reply('Options: lowend, low, medium, high');
            selectedQuality = QUALITY_PRESETS[preset];
            return reply(`Quality: ${preset} (${selectedQuality.width}x${selectedQuality.height}, ${selectedQuality.fps}fps)`);
        }

        if (trim.startsWith('play ')) {
            if (isPlaying) return reply('Already playing. Use !stop first.');
            const key = trim.split(' ')[1];
            const channels = await fetchChannels();
            if (!channels) return reply('Failed to fetch channels.');
            const channel = channels[key];
            if (!channel) return reply(`Channel ${key} not found.`);

            currentChannelName = channel.name;
            isPlaying = true;
            reply(`Starting ${channel.name}...`);

            try { await streamer.joinVoice(GUILD_ID, VOICE_ID); } catch (_) {}

            try {
                await playLoop(channel);
                reply(`Finished ${channel.name}.`);
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error('playLoop error:', err.message);
                reply(`Error: ${err.message}`);
            }

            isPlaying = false;
            if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (_) {} ffmpegProcess = null; }
            streamer.stopStream();
            currentChannelName = null;
            return;
        }

        if (trim === 'stop') {
            const name = currentChannelName || '';
            if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (_) {} ffmpegProcess = null; }
            streamer.stopStream();
            currentChannelName = null;
            isPlaying = false;
            return reply(`Stopped ${name}.`);
        }

        if (trim === 'txt') {
            const ch = await fetchChannels();
            if (!ch) return;
            const lines = Object.entries(ch).map(([k, v]) => `${k}. ${v.name}`);
            fs.writeFileSync(path.join(__dirname, 'channels.txt'), lines.join('\n'), 'utf8');
            return reply(`Exported ${lines.length} channels.`);
        }

        if (trim === 'status') {
            return reply(
                (isPlaying ? `Playing: ${currentChannelName || '?'}` : 'Stopped') +
                `\n${selectedQuality.width}x${selectedQuality.height} @ ${selectedQuality.fps}fps`
            );
        }

        if (trim === 'help') {
            return reply([
                'Commands:',
                'play <num>', 'stop', 'quality <lowend|low|medium|high>',
                'tv [page]', 'status', 'txt', 'help',
            ].join('\n'));
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Error:', err.message);
            reply(`Error: ${err.message}`);
        }
        isPlaying = false;
        if (ffmpegProcess) { try { ffmpegProcess.kill('SIGTERM'); } catch (_) {} ffmpegProcess = null; }
        streamer.stopStream();
    }
}

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== VOICE_TEXT_ID) return;
    if (!OWNER_IDS.includes(message.author.id)) return;
    let c = message.content;
    if (c.startsWith('p ')) c = c.slice(2);
    else if (c.startsWith('p')) c = c.slice(1);
    if (/^\d+$/.test(c)) c = 'play ' + c;
    await runCommand(c, async (t) => {
        try { await message.channel.send(t); } catch (e) { console.log('[send fail]', e.message); }
    });
});

const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.on('line', (line) => {
    const cmd = line.trim();
    if (cmd) runCommand(cmd, (t) => console.log(t));
    rl.prompt();
});
rl.prompt();

client.login(TOKEN);
