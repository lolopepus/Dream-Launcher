'use strict';
/** Version 2.3: Steam game recording clips (MPEG-DASH playlists and fragmented MP4 pieces). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const {
  listClips, clipManifest, recordingsDirs, parseMpd, fillTemplate, isoDuration, clipTime,
  initTimescale, firstDecodeTime, codecFromInit,
} = require('../src/main/clips');

// ---------------------------------------------------------------- tiny MP4 builder

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const fullBox = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);

function mdhd(timescale) {
  const b = Buffer.alloc(20); // creation, modification, timescale, duration, language, pre_defined
  b.writeUInt32BE(timescale, 8);
  return fullBox('mdhd', 0, b);
}

function initSegment(timescale, sampleEntry) {
  const stsd = fullBox('stsd', 0, Buffer.from([0, 0, 0, 1]), sampleEntry);
  return Buffer.concat([
    box('ftyp', Buffer.from('iso6')),
    box('moov', box('trak', box('mdia', mdhd(timescale), box('minf', box('stbl', stsd))))),
  ]);
}

const avc1 = () => box('avc1', Buffer.alloc(78), box('avcC', Buffer.from([1, 0x64, 0x00, 0x28, 0xff, 0xe1])));
// Main profile, compatibility flags 0x60000000, constraint byte 0x90, level 120.
const hvc1 = () => box('hvc1', Buffer.alloc(78), box('hvcC', Buffer.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120, 0xf0, 0])));

function mediaSegment(decodeTime) {
  const t = Buffer.alloc(8);
  t.writeBigUInt64BE(BigInt(decodeTime));
  return Buffer.concat([box('styp', Buffer.from('msdh')), box('moof', box('traf', fullBox('tfdt', 1, t))), box('mdat', Buffer.alloc(16))]);
}

const MPD = ({ videoT = 0, audioT = 0, videoCodec = 'avc1.640028', extra = '' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="${videoCodec}" bandwidth="1000">
        <SegmentTemplate timescale="15360" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
          <SegmentTimeline><S t="${videoT}" d="30720" r="2" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio">
      <Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000">
        <SegmentTemplate timescale="48000" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
          <SegmentTimeline><S t="${audioT}" d="96000" /><S d="96000" r="1" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>${extra}
  </Period>
</MPD>`;

/** Writes a clip in Steam's layout. Returns the session folder. */
function writeClip(root, name, session, { mpd, videoInit, videoStart = 0, skip = [] }) {
  const dir = path.join(root, 'clips', name, 'video', session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.mpd'), mpd);
  fs.writeFileSync(path.join(dir, 'init-stream0.m4s'), videoInit);
  fs.writeFileSync(path.join(dir, 'init-stream1.m4s'), initSegment(48000, box('mp4a', Buffer.alloc(28))));
  for (let k = 1; k <= 3; k++) {
    const v = `chunk-stream0-${String(k).padStart(5, '0')}.m4s`;
    const a = `chunk-stream1-${String(k).padStart(5, '0')}.m4s`;
    if (!skip.includes(v)) fs.writeFileSync(path.join(dir, v), mediaSegment(videoStart + (k - 1) * 30720));
    if (!skip.includes(a)) fs.writeFileSync(path.join(dir, a), mediaSegment((k - 1) * 96000));
  }
  return dir;
}

// ---------------------------------------------------------------- playlists

test('clips: playlist times, templates and repeats', () => {
  assert.equal(isoDuration('PT1M2.5S'), 62.5);
  assert.equal(isoDuration('PT1H'), 3600);
  assert.equal(isoDuration('nonsense'), 0);
  assert.equal(fillTemplate('chunk-stream$RepresentationID$-$Number%05d$.m4s', { id: '0', number: 7, time: 0 }), 'chunk-stream0-00007.m4s');
  assert.equal(fillTemplate('seg-$Time$-$$.m4s', { id: 'v', number: 1, time: 12345 }), 'seg-12345-$.m4s');

  const m = parseMpd(MPD({ videoT: 9216000 }));
  assert.equal(m.duration, 6);
  const [v, a] = m.tracks;
  assert.equal(v.kind, 'video');
  assert.equal(v.codecs, 'avc1.640028');
  assert.equal(v.timescale, 15360);
  assert.equal(v.init, 'init-stream0.m4s');
  assert.deepEqual(v.segments.map((s) => [s.file, s.t]), [
    ['chunk-stream0-00001.m4s', 9216000], ['chunk-stream0-00002.m4s', 9246720], ['chunk-stream0-00003.m4s', 9277440],
  ]);
  assert.equal(a.kind, 'audio');
  assert.deepEqual(a.segments.map((s) => s.t), [0, 96000, 192000]);

  // Fixed-length pieces without a timeline, and r="-1" (repeat to the end of the period).
  const fixed = parseMpd(`<MPD mediaPresentationDuration="PT5S"><Period><AdaptationSet mimeType="video/mp4">
    <SegmentTemplate timescale="1000" duration="2000" startNumber="0" media="v$Number$.m4s" initialization="vi.m4s"/>
    <Representation id="v" codecs="avc1.4d401f"/></AdaptationSet></Period></MPD>`);
  assert.deepEqual(fixed.tracks[0].segments.map((s) => s.file), ['v0.m4s', 'v1.m4s', 'v2.m4s']);
  assert.deepEqual(fixed.tracks[0].segments.map((s) => s.d), [2000, 2000, 1000], 'the last piece ends with the clip');
  // Steam's own playlist: 3 s pieces, 9.596 s clip.
  const steam = parseMpd(`<MPD type="static" mediaPresentationDuration="PT9.596S"><Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video"><Representation id="0" mimeType="video/mp4" codecs="hev1.2.4.L123.B0">
    <SegmentTemplate timescale="1000000" duration="3000000" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
    </Representation></AdaptationSet></Period></MPD>`);
  const segs = steam.tracks[0].segments;
  assert.deepEqual(segs.map((s) => s.file), ['chunk-stream0-00001.m4s', 'chunk-stream0-00002.m4s', 'chunk-stream0-00003.m4s', 'chunk-stream0-00004.m4s']);
  assert.equal(segs[3].t + segs[3].d, 9596000);
  const open = parseMpd(`<MPD mediaPresentationDuration="PT6S"><Period><AdaptationSet contentType="audio">
    <Representation id="a" mimeType="audio/mp4" codecs="opus"><SegmentTemplate timescale="1" media="a$Number$.m4s" initialization="ai.m4s">
    <SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`);
  assert.equal(open.tracks[0].segments.length, 3);
  assert.equal(parseMpd('not xml'), null);
  assert.equal(clipTime('20261120', '183005'), new Date(2026, 10, 20, 18, 30, 5).getTime());
});

test('clips: MP4 headers give timescale, start time and the full codec name', () => {
  const avcInit = initSegment(15360, avc1());
  assert.equal(initTimescale(avcInit), 15360);
  assert.equal(codecFromInit(avcInit), 'avc1.640028');
  assert.equal(codecFromInit(initSegment(90000, hvc1())), 'hvc1.1.6.L120.90');
  assert.equal(firstDecodeTime(mediaSegment(123456789)), 123456789);
  assert.equal(firstDecodeTime(Buffer.from('nothing here')), null);
  assert.equal(codecFromInit(Buffer.alloc(4)), '');
});

// ---------------------------------------------------------------- clips on disk

test('clips: found in the default and the custom recordings folder, newest first, per game', async () => {
  const steam = tmpDir('steam');
  const user = path.join(steam, 'userdata', '42');
  const custom = tmpDir('recordings');
  fs.mkdirSync(path.join(user, 'config'), { recursive: true });
  // Steam escapes backslashes in its text files.
  fs.writeFileSync(path.join(user, 'config', 'localconfig.vdf'),
    `"UserLocalConfigStore"\n{\n\t"GameRecording"\n\t{\n\t\t"BackgroundRecordPath"\t\t"${custom.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
  const defaults = path.join(user, 'gamerecordings');
  const init = initSegment(15360, avc1());
  writeClip(defaults, 'clip_570_20261120_183000', 'fg_570_20261120_183000', { mpd: MPD(), videoInit: init });
  writeClip(custom, 'clip_570_20261121_090000', 'bg_570_20261121_085500', { mpd: MPD(), videoInit: init });
  writeClip(custom, 'clip_570_20261121_090000', 'bg_570_20261121_085900', { mpd: MPD(), videoInit: init });
  writeClip(custom, 'clip_730_20261122_100000', 'fg_730_20261122_100000', { mpd: MPD(), videoInit: init });
  fs.writeFileSync(path.join(custom, 'clips', 'clip_570_20261121_090000', 'thumbnail.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  fs.mkdirSync(path.join(custom, 'clips', 'clip_570_20261122_120000'), { recursive: true }); // empty: ignored

  const dirs = await recordingsDirs(steam, '42');
  assert.deepEqual(dirs, [custom, defaults]);
  const clips = await listClips({ steamPath: steam, accountId: '42', appId: '570' });
  assert.deepEqual(clips.map((c) => c.name), ['clip_570_20261121_090000', 'clip_570_20261120_183000']);
  assert.equal(clips[0].sessions.length, 2);
  assert.equal(path.basename(clips[0].sessions[0]), 'bg_570_20261121_085500');
  assert.equal(path.basename(clips[0].thumb), 'thumbnail.jpg');
  assert.equal(clips[1].thumb, null);
  assert.equal(clips[0].duration, 12);
  assert.deepEqual(await listClips({ steamPath: steam, accountId: '42', appId: '' }), []);
  assert.deepEqual(await listClips({ steamPath: '', accountId: '42', appId: '570' }), []);
});

test('clips: manifest lists only pieces on disk, trusts the pieces for start times, completes codec names', async () => {
  const root = tmpDir('rec');
  // The playlist says the video starts at 600 s, the pieces themselves start at 0.
  const session = writeClip(root, 'clip_1_20261120_183000', 's1', {
    mpd: MPD({ videoT: 9216000, videoCodec: 'hvc1' }), videoInit: initSegment(15360, hvc1()), skip: ['chunk-stream1-00003.m4s'],
  });
  const clip = { dir: path.dirname(path.dirname(session)), sessions: [session] };
  const m = await clipManifest(clip, (i, f) => `dl://clip/x/${i}/${f}`);
  assert.equal(m.sessions.length, 1);
  const [v, a] = m.sessions[0].tracks;
  assert.equal(v.type, 'video/mp4; codecs="hvc1.1.6.L120.90"');
  assert.equal(v.init, 'dl://clip/x/0/init-stream0.m4s');
  assert.deepEqual(v.segments.map((s) => s.t), [0, 2, 4]);
  assert.deepEqual(v.segments.map((s) => s.d), [2, 2, 2]);
  assert.equal(a.type, 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(a.segments.length, 2, 'the missing audio piece is left out');
  assert.equal(m.duration, 6);

  // A session without its init pieces can't be played and is skipped.
  fs.rmSync(path.join(session, 'init-stream0.m4s'));
  fs.rmSync(path.join(session, 'init-stream1.m4s'));
  const none = await clipManifest(clip, (i, f) => f);
  assert.equal(none.sessions.length, 0);
});

// ---------------------------------------------------------------- player timeline (window side)

function loadClipPlayer() {
  const vm = require('vm');
  // The script expects a browser `window`; the sandbox itself plays that part.
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'clips.js'), 'utf8'), sandbox, { filename: 'clips.js' });
  return sandbox.DL.clips;
}

test('clip player: sessions are laid end to end without holes, times keep A/V in step', () => {
  const clips = loadClipPlayer();
  const seg = (t, d, n) => Array.from({ length: n }, (_, k) => ({ url: `u${t + k * d}`, t: t + k * d, d }));
  const manifest = {
    sessions: [
      { tracks: [
        { kind: 'video', type: 'v', init: 'vi0', segments: seg(0, 2, 3) }, // 0 – 6
        { kind: 'audio', type: 'a', init: 'ai0', segments: seg(0.02, 2, 3) }, // 0.02 – 6.02
      ] },
      { tracks: [
        { kind: 'video', type: 'v', init: 'vi1', segments: seg(100, 2, 2) }, // starts at 100 s in its own time
        { kind: 'audio', type: 'a', init: 'ai1', segments: seg(100, 2, 2) },
      ] },
    ],
  };
  // Arrays from the sandbox have their own prototypes: compare plain copies.
  const plan = JSON.parse(JSON.stringify(clips.layout(manifest)));
  const video = plan.kinds.find((k) => k.kind === 'video');
  const audio = plan.kinds.find((k) => k.kind === 'audio');
  assert.deepEqual(video.pieces.map((p) => [p.start, p.end, p.session]), [[0, 2, 0], [2, 4, 0], [4, 6, 0], [6, 8, 1], [8, 10, 1]]);
  // Session 1 starts where session 0's shorter track (video, 6 s) ends.
  assert.equal(video.inits[1].shift, 6 - 100);
  assert.equal(audio.inits[1].shift, 6 - 100);
  assert.equal(audio.pieces[0].start, 0.02, 'audio keeps its own small offset to the video');
  assert.equal(plan.duration, 10);

  // A kind missing in one session is left out completely (it would stop playback there).
  const noAudio = JSON.parse(JSON.stringify(clips.layout({ sessions: [manifest.sessions[0], { tracks: [manifest.sessions[1].tracks[0]] }] })));
  assert.deepEqual(noAudio.kinds.map((k) => k.kind), ['video']);
  assert.equal(clips.clock(65), '1:05');
  assert.equal(clips.clock(3725), '1:02:05');
});

// ---------------------------------------------------------------- sharp screenshot previews

test('screenshot previews: made at the asked size, kept on disk, shared while being made', async () => {
  const { Thumbs, bucket } = require('../src/main/thumbs');
  assert.equal(bucket(300), 480);
  assert.equal(bucket(700), 960);
  assert.equal(bucket(5000), 1600);
  assert.equal(bucket('x'), 640);

  const fakeImage = (w, h) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: ({ width }) => fakeImage(width, Math.round((h * width) / w)),
    toJPEG: () => Buffer.from(`jpeg ${w}x${h}`),
  });
  const calls = [];
  let shellWidth = null; // what Windows' thumbnail cache returns (null = nothing)
  const nativeImage = {
    createThumbnailFromPath: async (file, size) => { calls.push(['shell', size.width]); return shellWidth ? fakeImage(shellWidth, Math.round(shellWidth * 0.5625)) : fakeImage(0, 0); },
    createFromPath: (file) => { calls.push(['decode', file]); return file.includes('broken') ? { isEmpty: () => true } : fakeImage(3840, 2160); },
  };
  const dir = tmpDir('thumbs');
  const thumbs = new Thumbs({ dir, nativeImage });

  shellWidth = 960;
  const a = await thumbs.get('tok', 'C:\\shots\\a.jpg', 1000, 700);
  assert.equal(String(a), 'jpeg 960x540');
  assert.deepEqual(calls, [['shell', 960]]);

  // Windows only had a tiny preview: the picture itself is decoded and scaled down.
  shellWidth = 256;
  calls.length = 0;
  assert.equal(String(await thumbs.get('tok2', 'C:\\shots\\b.jpg', 1000, 480)), 'jpeg 480x270');
  assert.deepEqual(calls.map((c) => c[0]), ['shell', 'decode']);

  // Bigger than asked: scaled down to the bucket.
  shellWidth = 2560;
  assert.equal(String(await thumbs.get('tok3', 'C:\\shots\\c.jpg', 1000, 1280)), 'jpeg 1280x720');

  // Asked twice at once: made once.
  shellWidth = 640;
  calls.length = 0;
  const [x, y] = await Promise.all([thumbs.get('tok4', 'd.jpg', 5, 640), thumbs.get('tok4', 'd.jpg', 5, 600)]);
  assert.equal(String(x), String(y));
  assert.equal(calls.length, 1);

  // Kept on disk: a new helper (next start) doesn't make it again.
  await new Promise((r) => setTimeout(r, 50));
  shellWidth = 960;
  calls.length = 0;
  const again = new Thumbs({ dir, nativeImage });
  assert.equal(String(await again.get('tok', 'C:\\shots\\a.jpg', 1000, 700)), 'jpeg 960x540');
  assert.equal(calls.length, 0);
  // A changed file (new modification time) gets a new preview.
  await again.get('tok', 'C:\\shots\\a.jpg', 2000, 700);
  assert.deepEqual(calls, [['shell', 960]]);

  // Unreadable pictures give nothing (the app then falls back to Steam's own thumbnail).
  shellWidth = null;
  assert.equal(await thumbs.get('bad', 'broken.jpg', 1, 480), null);
  assert.equal(await new Thumbs({ dir, nativeImage: undefined }).get('none', 'x.jpg', 1, 480), null);

  // Old previews are removed beyond the limit.
  const before = fs.readdirSync(dir).length;
  assert.ok(before >= 5);
  assert.equal(await thumbs.prune(2), before - 2);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('screenshot previews: at most two are made at the same time', async () => {
  const { Thumbs } = require('../src/main/thumbs');
  let active = 0;
  let peak = 0;
  const nativeImage = {
    createThumbnailFromPath: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { isEmpty: () => false, getSize: () => ({ width: 480, height: 270 }), toJPEG: () => Buffer.from('j') };
    },
    createFromPath: () => ({ isEmpty: () => true }),
  };
  const thumbs = new Thumbs({ dir: tmpDir('thumbs2'), nativeImage });
  const all = await Promise.all(Array.from({ length: 9 }, (_, i) => thumbs.get(`t${i}`, `${i}.jpg`, 1, 480)));
  assert.equal(all.filter(Boolean).length, 9);
  assert.equal(peak, 2);
  assert.equal(thumbs.running, 0);
});

test('clips: a piece\'s real length comes from its own sample table', async () => {
  const { pieceLength } = require('../src/main/clips');
  const dir = tmpDir('pieces');
  const u32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32BE(x, i * 4)); return b; };
  // tfhd with a default sample duration (flag 0x8) and a trun without per-sample durations: 30 × 512.
  const a = Buffer.concat([
    box('moof', box('traf', box('tfhd', u32(0x000008, 1, 512)), box('trun', u32(0x000000, 30)))),
    box('mdat', Buffer.alloc(64)),
  ]);
  fs.writeFileSync(path.join(dir, 'a.m4s'), a);
  assert.equal(await pieceLength(path.join(dir, 'a.m4s'), 15360, 0), (30 * 512) / 15360);
  // Two fragments with per-sample durations (flag 0x100) and sizes (0x200).
  const run = (durs) => box('trun', u32(0x000301, durs.length, 0), ...durs.map((d) => u32(d, 100)));
  const b = Buffer.concat([
    box('moof', box('traf', box('tfhd', u32(0, 1)), run([1000, 1000]))), box('mdat', Buffer.alloc(16)),
    box('moof', box('traf', box('tfhd', u32(0, 1)), run([500]))), box('mdat', Buffer.alloc(16)),
  ]);
  fs.writeFileSync(path.join(dir, 'b.m4s'), b);
  assert.equal(await pieceLength(path.join(dir, 'b.m4s'), 1000, 0), 2.5);
  // No sample durations at all: unknown.
  fs.writeFileSync(path.join(dir, 'c.m4s'), box('moof', box('traf', box('trun', u32(0, 3)))));
  assert.equal(await pieceLength(path.join(dir, 'c.m4s'), 1000, 0), null);
  assert.equal(await pieceLength(path.join(dir, 'missing.m4s'), 1000, 0), null);
});
