/* The microphone. The other half of speech.js: that one is the device's own
   voice going out, this one is your voice coming in.

   Nothing here is Shadowing-specific and nothing here touches the network.
   MediaRecorder and getUserMedia are both browser built-ins, cost nothing and
   need no key — the only thing that ever leaves the machine is the blob this
   hands back, and only when you press Submit.

   Four things in here are the whole reason this is its own file rather than
   twenty lines inside the tab:

     canRecord and micDenied are DIFFERENT states. "This browser cannot record"
     and "this browser will not until you allow it" need different words on
     screen, and a single boolean gives one of them the other's message.

     start() resolves true only once the microphone is really open. A caller
     that shows "recording" on an optimistic guess will show it while nothing
     at all is being captured, and the first the user knows is a silent clip.

     stop() resolves on MediaRecorder's own onstop, never earlier. Chunks are
     not guaranteed flushed before it fires, so resolving on stop() returning
     drops the tail of the sentence — the last word, every time.

     Tracks are released on every stop path and on teardown. A live stream
     keeps the browser's recording indicator lit, which is alarming and fair
     enough: something really is still listening. */

export const SUPPORTED = typeof window !== 'undefined'
  && typeof window.MediaRecorder !== 'undefined'
  && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export function createRecorder({ onChange = () => {} } = {}) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  /* Held as a plain variable rather than read back off the recorder, because
     stop() is sometimes reached from a stale path — a timer, a tab change —
     and reading "not recording" there would leave the microphone open with
     nothing left holding a reference to close it. */
  let recording = false;
  let micDenied = false;

  function releaseStream() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  function state() {
    return { canRecord: SUPPORTED, recording, micDenied };
  }

  function announce() {
    try { onChange(state()); } catch (e) { console.error(e); }
  }

  /* True only once the microphone is genuinely open and capturing. False means
     nothing is being recorded and the caller must say so. */
  async function start() {
    if (recording || !SUPPORTED) return false;
    micDenied = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.start();
      recorder = rec;
      recording = true;
      announce();
      return true;
    } catch (e) {
      /* Refused, or no input device, or the page is not in a secure context.
         All of them mean the same thing to the caller: nothing was captured. */
      recorder = null;
      releaseStream();
      micDenied = true;
      recording = false;
      announce();
      return false;
    }
  }

  /* Resolves with the blob, or null when nothing was captured. */
  function stop() {
    if (!recording) return Promise.resolve(null);
    recording = false;
    const rec = recorder;
    recorder = null;
    announce();
    if (!rec || rec.state === 'inactive') {
      releaseStream();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      rec.onstop = () => {
        releaseStream();
        resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType }) : null);
        chunks = [];
      };
      try {
        rec.stop();
      } catch (e) {
        /* Already inactive between the check and the call. */
        releaseStream();
        resolve(null);
      }
    });
  }

  /* Leaving the tab, or the page going away. Whatever was being recorded is
     abandoned — it was never kept — but the microphone must not stay open. */
  function dispose() {
    recording = false;
    try { if (recorder) recorder.stop(); } catch (e) { /* already inactive */ }
    recorder = null;
    chunks = [];
    releaseStream();
  }

  return { start, stop, dispose, state, get recording() { return recording; } };
}
