import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssml, cleanRegion, filterVoices, synthesize, listVoices, AzureError, OUTPUT_FORMAT } from '../js/azure-tts.js';

const VOICES = [
  { ShortName: 'vi-VN-NamMinhNeural', DisplayName: 'NamMinh', Locale: 'vi-VN', Gender: 'Male', VoiceType: 'Neural' },
  { ShortName: 'vi-VN-HoaiMyNeural', DisplayName: 'HoaiMy', Locale: 'vi-VN', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', Locale: 'en-US', Gender: 'Female', VoiceType: 'Neural' },
];

test('SSML escapes the text, so a card cannot break the request', () => {
  const x = ssml('a < b & "c"', 'vi-VN-HoaiMyNeural', 'vi-VN');
  assert.match(x, /<voice name="vi-VN-HoaiMyNeural">a &lt; b &amp; &quot;c&quot;<\/voice>/);
  assert.match(x, /xml:lang="vi-VN"/);
});

test('a region is an id or nothing, since it becomes part of a hostname', () => {
  assert.equal(cleanRegion(' SouthEastAsia '), 'southeastasia');
  assert.equal(cleanRegion('east us'), 'eastus');
  assert.equal(cleanRegion('evil.com/x'), '');
  assert.equal(cleanRegion(''), '');
});

test('voices are narrowed to the language and sorted by name', () => {
  const vi = filterVoices(VOICES, 'vi');
  assert.deepEqual(vi.map((v) => v.name), ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']);
  assert.equal(vi[0].label, 'HoaiMy');
  assert.equal(filterVoices(VOICES, 'vi-VN').length, 2);
  assert.equal(filterVoices(VOICES, '').length, 0);
});

test('synthesize sends the key, SSML and format to the region, and returns the audio', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(new Blob(['mp3']), { status: 200 }); };
  const blob = await synthesize({ region: 'southeastasia', key: 'K', voice: 'vi-VN-HoaiMyNeural', locale: 'vi-VN', text: 'xin chào', fetchImpl });
  assert.equal(seen.url, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Ocp-Apim-Subscription-Key'], 'K');
  assert.equal(seen.init.headers['X-Microsoft-OutputFormat'], OUTPUT_FORMAT);
  assert.match(seen.init.body, /xin chào/);
  assert.equal(await blob.text(), 'mp3');
});

test('a refused key and a spent allowance come back as plain words', async () => {
  const answer = (status) => async () => new Response('', { status });
  await assert.rejects(synthesize({ region: 'eastus', key: 'K', voice: 'v', locale: 'vi-VN', text: 't', fetchImpl: answer(401) }), /refused the key/);
  await assert.rejects(synthesize({ region: 'eastus', key: 'K', voice: 'v', locale: 'vi-VN', text: 't', fetchImpl: answer(429) }), /used up/);
  await assert.rejects(synthesize({ region: 'eastus', key: '', voice: 'v', locale: 'vi-VN', text: 't' }), AzureError);
  await assert.rejects(listVoices({ region: 'bad.host', key: 'K', code: 'vi' }), /region/);
});

test('listVoices reads the voice list with the key', async () => {
  let url;
  const fetchImpl = async (u, init) => { url = u; assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'K'); return new Response(JSON.stringify(VOICES)); };
  const vi = await listVoices({ region: 'southeastasia', key: 'K', code: 'vi', fetchImpl });
  assert.equal(url, 'https://southeastasia.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.equal(vi.length, 2);
});

test('a clip is named by its voice and a fingerprint, the same every time', async () => {
  const { clipName } = await import('../js/azure-tts.js');
  const { dataPath } = await import('../js/storage.js');
  const a = await clipName('vi-VN-HoaiMyNeural', 'biệt thự');
  assert.match(a, /^vi-VN-HoaiMyNeural_[0-9a-f]{20}\.mp3$/);
  assert.equal(await clipName('vi-VN-HoaiMyNeural', 'biệt thự'), a);
  assert.notEqual(await clipName('vi-VN-NamMinhNeural', 'biệt thự'), a);
  assert.notEqual(await clipName('vi-VN-HoaiMyNeural', 'biệt thụ'), a);
  assert.equal(dataPath(`voice/${a}`), `voice/${a}`, 'a saved clip is part of the backup layout');
});

test('text that reads the same shares one clip; different words do not', async () => {
  const { clipName, spokenForm } = await import('../js/azure-tts.js');
  const voice = 'vi-VN-NamMinhNeural';
  const name = (t) => clipName(voice, t);
  const plain = await name('biệt thự');
  assert.equal(await name('biệt thự'.normalize('NFD')), plain, 'the same letters, stored decomposed');
  assert.equal(await name('Biệt Thự'), plain, 'capitals');
  assert.equal(await name('  biệt   thự  '), plain, 'spaces, including those left where a bracketed note was');
  assert.notEqual(await name('biết thự'), plain, 'a different tone is a different word');
  assert.notEqual(await name('biệt thự?'), plain, 'punctuation changes how it is read');
  assert.equal(spokenForm('  Đi  ĐÂU? '), 'đi đâu?');
});
