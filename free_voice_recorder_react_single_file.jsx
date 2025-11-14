import React, { useEffect, useRef, useState } from "react";

// Free Voice Recorder - Single-file React component
// Usage: paste into a Vite/CRA project (e.g. src/App.jsx) and ensure Tailwind is available.

export default function FreeVoiceRecorder() {
  const [permission, setPermission] = useState(false);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [sampleRate, setSampleRate] = useState(44100);
  const [qualityMode, setQualityMode] = useState("pcm"); // 'pcm' (high quality) or 'mediarec' (simple)
  const [timeline, setTimeline] = useState(0);
  const [recordedBlobUrl, setRecordedBlobUrl] = useState(null);
  const [statusText, setStatusText] = useState("Ready");

  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const pcmDataRef = useRef([]);
  const startTimeRef = useRef(null);
  const rafRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  useEffect(() => {
    // get devices
    navigator.mediaDevices && navigator.mediaDevices.enumerateDevices()
      .then((list) => {
        const inputs = list.filter((d) => d.kind === "audioinput");
        setDevices(inputs);
        if (inputs.length && !selectedDeviceId) setSelectedDeviceId(inputs[0].deviceId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureMic(deviceId) {
    // ask for permission and open stream
    try {
      const constraints = {
        audio: deviceId
          ? { deviceId: { exact: deviceId } }
          : { echoCancellation: true, noiseSuppression: true },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      setPermission(true);
      return stream;
    } catch (e) {
      setStatusText("Microphone permission denied or not available.");
      setPermission(false);
      throw e;
    }
  }

  async function startRecording() {
    setStatusText("Starting...");
    setRecordedBlobUrl(null);
    pcmDataRef.current = [];
    recordedChunksRef.current = [];

    try {
      const stream = await ensureMic(selectedDeviceId || undefined);

      if (qualityMode === "mediarec") {
        // Simple path using MediaRecorder (smaller code, good compatibility)
        const options = { mimeType: "audio/webm;codecs=opus" };
        try {
          const mr = new MediaRecorder(stream, options);
          mediaRecorderRef.current = mr;
          mr.ondataavailable = (ev) => {
            if (ev.data && ev.data.size) recordedChunksRef.current.push(ev.data);
          };
          mr.onstop = handleMediaRecorderStop;
          mr.start();
        } catch (err) {
          // Fallback without specifying mimeType
          const mr = new MediaRecorder(stream);
          mediaRecorderRef.current = mr;
          mr.ondataavailable = (ev) => {
            if (ev.data && ev.data.size) recordedChunksRef.current.push(ev.data);
          };
          mr.onstop = handleMediaRecorderStop;
          mr.start();
        }
      } else {
        // High-quality PCM capture: capture raw floats via AudioContext + ScriptProcessor
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const ac = new AudioContextClass({ sampleRate });
        audioContextRef.current = ac;
        const src = ac.createMediaStreamSource(stream);

        // ScriptProcessor is deprecated but widely supported; AudioWorklet would be ideal but longer to include.
        const bufferSize = 4096; // small buffer = lower latency
        const processor = ac.createScriptProcessor(bufferSize, src.channelCount || 1, 1);

        processor.onaudioprocess = (e) => {
          const channelData = [];
          for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
            channelData.push(new Float32Array(e.inputBuffer.getChannelData(c)));
          }
          // interleave to stereo/mono float32
          if (channelData.length === 1) {
            pcmDataRef.current.push(channelData[0]);
          } else {
            // interleave channels
            const len = channelData[0].length;
            const interleaved = new Float32Array(len * channelData.length);
            for (let i = 0; i < len; i++) {
              for (let ch = 0; ch < channelData.length; ch++) {
                interleaved[i * channelData.length + ch] = channelData[ch][i];
              }
            }
            pcmDataRef.current.push(interleaved);
          }
        };

        src.connect(processor);
        processor.connect(ac.destination); // to keep the processor running

        // save references to stop later
        audioContextRef.current._processor = processor;
      }

      setRecording(true);
      setPaused(false);
      startTimeRef.current = performance.now();
      tickTimer();
      setStatusText("Recording");
    } catch (e) {
      console.error(e);
      setStatusText("Could not start recording: " + (e && e.message ? e.message : e));
    }
  }

  function tickTimer() {
    const update = () => {
      if (!startTimeRef.current) return;
      setTimeline((prev) => {
        const t = (performance.now() - startTimeRef.current) / 1000;
        return t;
      });
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
  }

  function stopTimer() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startTimeRef.current = null;
  }

  function pauseRecording() {
    if (!recording) return;
    setPaused(true);
    setStatusText("Paused");
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
    }
    // For PCM path we can't pause easily; stop timer only
    stopTimer();
  }

  function resumeRecording() {
    if (!recording) return;
    setPaused(false);
    setStatusText("Recording");
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
    }
    startTimeRef.current = performance.now() - timeline * 1000;
    tickTimer();
  }

  async function stopAll() {
    setRecording(false);
    setPaused(false);
    stopTimer();
    setTimeline(0);

    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {}
      mediaRecorderRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        // disconnect processor
        const proc = audioContextRef.current._processor;
        if (proc) {
          proc.disconnect();
        }
        audioContextRef.current.close();
      } catch (e) {}
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }

  async function handleMediaRecorderStop() {
    // assemble webm/ogg/opus
    const blob = new Blob(recordedChunksRef.current, { type: recordedChunksRef.current[0]?.type || "audio/webm" });
    const url = URL.createObjectURL(blob);
    setRecordedBlobUrl(url);
    setStatusText("Stopped — ready to play/download");
    recordedChunksRef.current = [];
  }

  // Called when user clicks Stop in PCM mode
  async function finalizePcmRecording() {
    // merge Float32 arrays into one
    const buffers = pcmDataRef.current;
    if (!buffers.length) {
      setStatusText("No audio recorded");
      return;
    }
    let length = 0;
    for (const b of buffers) length += b.length;
    const result = new Float32Array(length);
    let offset = 0;
    for (const b of buffers) {
      result.set(b, offset);
      offset += b.length;
    }

    // convert float32 to 16-bit PCM
    const wavBuffer = encodeWAV(result, sampleRate, 1);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setRecordedBlobUrl(url);
    setStatusText("Stopped — WAV ready");
    pcmDataRef.current = [];
  }

  function encodeWAV(samples, sampleRate, numChannels) {
    // 16-bit PCM WAV header
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    /* RIFF identifier */ writeString(view, 0, "RIFF");
    /* file length */ view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    /* RIFF type */ writeString(view, 8, "WAVE");
    /* format chunk identifier */ writeString(view, 12, "fmt ");
    /* format chunk length */ view.setUint32(16, 16, true);
    /* sample format (raw) */ view.setUint16(20, 1, true);
    /* channel count */ view.setUint16(22, numChannels, true);
    /* sample rate */ view.setUint32(24, sampleRate, true);
    /* byte rate (sampleRate * blockAlign) */ view.setUint32(28, sampleRate * blockAlign, true);
    /* block align (channel count * bytes per sample) */ view.setUint16(32, blockAlign, true);
    /* bits per sample */ view.setUint16(34, 8 * bytesPerSample, true);
    /* data chunk identifier */ writeString(view, 36, "data");
    /* data chunk length */ view.setUint32(40, samples.length * bytesPerSample, true);

    // write samples
    floatTo16BitPCM(view, 44, samples);

    return view;
  }

  function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      output.setInt16(offset, s, true);
    }
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  async function stopRecording() {
    setRecording(false);
    setPaused(false);
    stopTimer();

    if (qualityMode === "mediarec") {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      // mediaRecorder.onstop will handle blob
    } else {
      // finalize PCM WAV
      finalizePcmRecording();
      // close audio context and stop tracks
      if (audioContextRef.current) {
        try {
          const proc = audioContextRef.current._processor;
          if (proc) proc.disconnect();
          audioContextRef.current.close();
        } catch (e) {}
        audioContextRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    }
  }

  function formatTime(sec) {
    if (!sec) return "0:00";
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="max-w-3xl mx-auto p-6 bg-white rounded-2xl shadow-md mt-8">
      <h1 className="text-2xl font-bold mb-3">Free Voice Recorder</h1>
      <p className="text-sm text-gray-600 mb-4">Record high-quality voice audio for videos and download as WAV or WebM.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium">Input device</label>
          <select
            className="mt-1 w-full rounded-md border p-2"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
          >
            {devices.length ? (
              devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone (${d.deviceId.slice(0, 8)})`}
                </option>
              ))
            ) : (
              <option value="">Default microphone</option>
            )}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium">Sample rate</label>
          <select
            className="mt-1 w-full rounded-md border p-2"
            value={sampleRate}
            onChange={(e) => setSampleRate(Number(e.target.value))}
          >
            <option value={44100}>44.1 kHz (CD)</option>
            <option value={48000}>48 kHz (Video standard)</option>
            <option value={96000}>96 kHz (Pro)</option>
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium">Quality mode</label>
          <div className="mt-1 flex gap-3">
            <label className="inline-flex items-center">
              <input
                type="radio"
                name="quality"
                value="pcm"
                checked={qualityMode === "pcm"}
                onChange={() => setQualityMode("pcm")}
              />
              <span className="ml-2">High-quality WAV (PCM capture)</span>
            </label>
            <label className="inline-flex items-center">
              <input
                type="radio"
                name="quality"
                value="mediarec"
                checked={qualityMode === "mediarec"}
                onChange={() => setQualityMode("mediarec")}
              />
              <span className="ml-2">Compatibility mode (WebM/Opus)</span>
            </label>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        {!recording ? (
          <button onClick={startRecording} className="px-4 py-2 bg-green-600 text-white rounded-lg">
            Start Recording
          </button>
        ) : (
          <>
            {!paused ? (
              <button onClick={pauseRecording} className="px-4 py-2 bg-yellow-500 text-white rounded-lg">
                Pause
              </button>
            ) : (
              <button onClick={resumeRecording} className="px-4 py-2 bg-blue-600 text-white rounded-lg">
                Resume
              </button>
            )}
            <button onClick={stopRecording} className="px-4 py-2 bg-red-600 text-white rounded-lg">
              Stop
            </button>
          </>
        )}

        <div className="ml-auto text-sm text-gray-700">{statusText}</div>
      </div>

      <div className="mb-4">
        <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
          <div
            style={{ width: `${Math.min(100, (timeline / 60) * 100)}%` }}
            className="h-full bg-gradient-to-r from-green-400 to-blue-500"
          />
        </div>
        <div className="text-xs text-gray-600 mt-1">Duration: {formatTime(timeline)}</div>
      </div>

      <div className="mt-4">
        {recordedBlobUrl ? (
          <div className="space-y-2">
            <audio controls src={recordedBlobUrl} className="w-full" />
            <div className="flex gap-2">
              <a href={recordedBlobUrl} download={`recording_${Date.now()}.${qualityMode === "pcm" ? "wav" : "webm"}`} className="px-3 py-2 bg-indigo-600 text-white rounded-md">
                Download
              </a>
              <button
                onClick={() => {
                  URL.revokeObjectURL(recordedBlobUrl);
                  setRecordedBlobUrl(null);
                }}
                className="px-3 py-2 bg-gray-200 rounded-md"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">No recording yet.</div>
        )}
      </div>

      <div className="mt-6 text-xs text-gray-500">
        <strong>Notes:</strong>
        <ul className="list-disc ml-5">
          <li>High-quality WAV uses browser audio capture to produce 16-bit PCM WAV files (larger files).</li>
          <li>Compatibility mode uses MediaRecorder (Opus) which produces much smaller files and is widely supported for web playback.</li>
          <li>For best results use an external USB microphone and 48 kHz sample rate for video workflows.</li>
        </ul>
      </div>
    </div>
  );
}
