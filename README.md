# Vocal Separate

A local web application for AI-powered music source separation, synchronized multi-stem mixing, and karaoke lyrics playback.

## Features

- **Stem Separation (`audio-separator`)**
  - **2 Stems (Recommended):** Vocals + Accompaniment (`BS-RoFormer`)
  - **4 Stems:** Vocals, Drums, Bass, Other (`HTDemucs`)
  - **6 Stems:** Vocals, Drums, Bass, Guitar, Piano, Other (`HTDemucs 6s`)
  - Supports audio & video inputs (`WAV`, `MP3`, `FLAC`, `MP4`, `MOV`, `MKV`, `AVI`, `MPEG`) with automatic `ffmpeg` conversion to WAV.
  - **YouTube Link Import (`yt-dlp`):** Paste any YouTube URL to extract a 192 kbps MP3 (with one-click MP3 download) and automatically prepare WAV audio for Single or Batch separation.
- **Fast GPU Inference**
  - Automatic CUDA FP16 autocast and direct `soundfile` WAV export (~2× faster than FP32/`pydub`).
  - **High Quality / Fast (2×)** toggle (`overlap=4`/`2` for BS-RoFormer, `shifts=2`/`1` for HTDemucs).
  - Asynchronous startup model preloading for locally downloaded models, in-memory LRU model cache, and automatic first-run download with live progress for missing models.
- **Single & Batch Mode**
  - Separate one track or queue multiple files at once (dropping multiple files switches to Batch Mode automatically).
  - Parallel batch uploads and `ffmpeg` conversions (4 concurrent workers), single model load reused across the entire batch, and live per-file + overall progress bars with ETA.
- **Synchronized Multi-Stem Mixer & Library**
  - Play/Pause, Restart, ±5s Seek, Loop, synchronized timeline scrubbing, Master Volume, per-stem Mute (`M`) / Solo (`S`) / Volume sliders, and one-click WAV downloads.
  - One-click **All Stems**, **Karaoke** (vocals muted), and **Vocals Only** presets, plus keyboard shortcuts (`Space`, `←`/`→`, `R`, `1`–`6`).
  - Searchable **Library** sidebar listing all previously separated tracks from `static/files/`.
- **Synced Lyrics & Karaoke Viewer**
  - **Title Match:** Searches [LRCLIB](https://lrclib.net) using cleaned track names + WAV duration ranking.
  - **Audio Fingerprint:** Identifies songs directly from audio via Shazam (`shazamio`), then fetches synced lyrics from LRCLIB (with Shazam plain-lyrics fallback).
  - **Local Whisper:** Transcribes the isolated `vocals.wav` stem locally on GPU/CPU (`turbo`, `medium`, `small`, `base`) into synced `.lrc` lyrics.
  - Real-time active-line highlighting, auto-scroll, click-to-seek, `-0.5s`/`+0.5s` timing offset, double-click inline or full raw editing, `.lrc`/`.txt` export, and per-track local caching (`static/files/<track>/lyrics.json`).

## Requirements

- **Python** 3.10+
- **[uv](https://docs.astral.sh/uv/)** (recommended)
- **FFmpeg** installed on `PATH` (or placed in `./ffmpeg/`)
- **NVIDIA GPU + CUDA** (optional; falls back to CPU automatically)

## Quick Start

```bash
# Install dependencies
uv sync

# Start the web server
uv run start.py
```

Open **http://127.0.0.1:23332** in your browser.

> Locally present models in `pretrained_models/` preload asynchronously on startup. Any model not yet on disk downloads automatically on its first run.

## Project Structure

```text
vocal-separate/
├── start.py              # Flask + gevent server, async jobs, model cache, lyrics endpoints
├── vocal/
│   ├── cfg.py            # Paths, CUDA detection, model mappings
│   └── tool.py           # FFmpeg wrapper and helpers
├── templates/
│   └── index.html        # Main UI template
├── static/
│   ├── css/app.css       # Studio dark/light theme styles
│   ├── js/app.js         # Upload, batch queue, stem mixer, lyrics & editor logic
│   ├── tmp/              # Uploaded & converted WAV cache (gitignored)
│   └── files/            # Separated stems & cached lyrics.json per track (gitignored)
├── pretrained_models/    # Separation & Whisper weights (gitignored)
├── pyproject.toml
└── uv.lock
```

## HTTP API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | `GET` | Web UI |
| `/upload` | `POST` | Upload audio/video file (`audio` form field); converts to WAV in `static/tmp/` |
| `/youtube` | `POST` | Start async YouTube download to 192 kbps MP3 + WAV (`{"url": "https://..."}`) |
| `/jobs` | `POST` | Start async single-file separation (`wav_name`, `model`, `quality`) |
| `/jobs/batch` | `POST` | Start async batch separation (`{"wav_names": [...], "model": "2stems", "quality": "quality"}`) |
| `/jobs/<job_id>` | `GET` | Poll separation or Whisper transcription job progress & results |
| `/models/status` | `GET` | Check local download & in-memory preload status for each model |
| `/history` | `GET` | List previously separated tracks and stems in `static/files/` |
| `/lyrics` | `GET` | Fetch cached `lyrics.json` or suggested query + duration (`?track=<name>`) |
| `/lyrics/search` | `GET` | Search LRCLIB (`?q=<query>&duration=<sec>`) |
| `/lyrics/fingerprint` | `POST` | Identify song via Shazam fingerprint and fetch lyrics (`{"track": "<name>"}`) |
| `/lyrics/whisper` | `POST` | Start async local Whisper transcription on `vocals.wav` (`{"track", "model", "language"}`) |
| `/lyrics/save` | `POST` | Save edited/selected lyrics & offset to `static/files/<track>/lyrics.json` |
| `/api` | `POST` | Synchronous upload + separate (`file`, `model`, optional `quality`) |

### Synchronous `/api` Example

```python
import requests

url = "http://127.0.0.1:23332/api"
with open("song.mp3", "rb") as f:
    resp = requests.post(url, files={"file": f}, data={"model": "2stems", "quality": "quality"}, timeout=600)
print(resp.json())
```

## Acknowledgments

- [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) (BS-RoFormer & HTDemucs)
- [OpenAI Whisper](https://github.com/openai/whisper)
- [LRCLIB](https://lrclib.net) & [ShazamIO](https://github.com/shazamio/ShazamIO)
- [Flask](https://flask.palletsprojects.com/), [gevent](https://www.gevent.org/), and [FFmpeg](https://ffmpeg.org/)
