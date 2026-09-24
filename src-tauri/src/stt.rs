//! Local speech-to-text: Whisper.cpp running fully on-device.
//!
//! The frontend records the microphone, encodes a 16 kHz mono WAV and sends
//! the bytes here; nothing ever leaves the machine. The GGML model lives in
//! the app data directory (`models/ggml-small.bin`) and is downloaded once on
//! first use, with progress streamed to the UI as `stt://progress` events.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const MODEL_FILE: &str = "ggml-small.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
/// Whisper expects exactly this sample rate.
const TARGET_RATE: u32 = 16_000;

/// Loaded model context — loading takes seconds and hundreds of MB of RAM,
/// so it happens once per process and is reused by every transcription.
static CTX: Mutex<Option<WhisperContext>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
struct Progress {
    percent: u8,
    done: bool,
}

fn emit(app: &AppHandle, percent: u8, done: bool) {
    let _ = app.emit("stt://progress", Progress { percent, done });
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create model dir: {e}"))?;
    Ok(dir.join(MODEL_FILE))
}

/// Makes sure the model file exists, downloading it once when missing.
/// A partial download is kept in a `.part` file so an interrupted transfer
/// can never be mistaken for a usable model.
async fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let path = model_path(app)?;
    if is_complete(&path) {
        return Ok(path);
    }

    let part = path.with_extension("bin.part");
    emit(app, 0, false);
    let client = reqwest::Client::new();
    let res = client
        .get(MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("model download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("model download returned {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut stream = res.bytes_stream();
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("cannot write model file: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 255;
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("model download failed: {e}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("cannot write model file: {e}"))?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let percent = ((downloaded * 100) / total).min(99) as u8;
            if percent != last_percent && percent % 5 == 0 {
                last_percent = percent;
                emit(app, percent, false);
            }
        }
    }
    drop(file);
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|e| format!("cannot finalize model file: {e}"))?;
    if !is_complete(&path) {
        return Err("downloaded model is incomplete".into());
    }
    emit(app, 100, true);
    Ok(path)
}

/// The small model is ~465 MB; anything far smaller is a truncated download.
fn is_complete(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.len() > 400_000_000).unwrap_or(false)
}

/* ---------- Audio decoding (WAV → mono f32 @ 16 kHz) ---------- */

/// Decodes the recorded WAV into the sample format Whisper wants.
///
/// The frontend already downsamples to 16 kHz mono, but the decoder stays
/// generic (any rate, any channel count) so odd capture devices cannot break
/// dictation.
fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes.to_vec())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("wav");
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("unsupported audio: {e}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("audio has no tracks")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("cannot decode audio: {e}"))?;
    let track_id = track.id;
    let source_rate = track.codec_params.sample_rate.unwrap_or(TARGET_RATE);

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut mono: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };
        let spec = *decoded.spec();
        let frames = decoded.frames();
        if sample_buf.is_none() {
            sample_buf = Some(SampleBuffer::<f32>::new(frames as u64, spec));
        }
        if let Some(buf) = sample_buf.as_mut() {
            buf.copy_interleaved_ref(decoded);
            let channels = spec.channels.count().max(1);
            let samples = buf.samples();
            for frame in samples.chunks_exact(channels) {
                let sum: f32 = frame.iter().sum();
                mono.push(sum / channels as f32);
            }
        }
    }
    if mono.is_empty() {
        return Err("audio contained no samples".into());
    }
    Ok(resample(&mono, source_rate, TARGET_RATE))
}

/// Linear-interpolation resample — plenty for speech at these rates.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input[idx.min(input.len() - 1)];
        let b = input[(idx + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

/* ---------- Whisper ---------- */

fn run_whisper(model: &Path, samples: &[f32], language: Option<String>) -> Result<String, String> {
    let mut guard = CTX.lock().map_err(|_| "transcriber is busy".to_string())?;
    if guard.is_none() {
        *guard = Some(
            WhisperContext::new_with_params(model, WhisperContextParameters::default())
                .map_err(|e| format!("cannot load the local voice model: {e}"))?);
    }
    let ctx = guard.as_ref().unwrap();

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // "auto" lets Whisper detect the spoken language itself.
    let lang = language.unwrap_or_else(|| "auto".to_string());
    params.set_language(Some(if lang == "auto" { "auto" } else { lang.as_str() }));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("cannot start transcription: {e}"))?;
    state
        .full(params, samples)
        .map_err(|e| format!("transcription failed: {e}"))?;

    let mut text = String::new();
    let segments = state.full_n_segments();
    for i in 0..segments {
        if let Some(part) = state.get_segment(i) {
            if let Ok(part) = part.to_str_lossy() {
                text.push_str(&part);
            }
        }
    }
    Ok(text.trim().to_string())
}

/// Transcribes a recorded WAV (16 kHz mono preferred) entirely offline.
pub async fn transcribe(app: AppHandle, wav: Vec<u8>, language: Option<String>) -> Result<String, String> {
    if wav.is_empty() {
        return Err("empty audio".into());
    }
    let model = ensure_model(&app).await?;
    // Decoding + inference are heavy CPU work — keep them off the async pool.
    tokio::task::spawn_blocking(move || {
        let samples = decode_wav(&wav)?;
        run_whisper(&model, &samples, language)
    })
    .await
    .map_err(|e| format!("transcription crashed: {e}"))?
}
