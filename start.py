import asyncio
from collections import OrderedDict
import json
import logging
import re
import tempfile
import threading
import time
import uuid
import wave
from urllib.parse import quote
from flask import Flask, request, render_template, jsonify
import os
import gevent
from gevent.pywsgi import WSGIServer, WSGIHandler
from logging.handlers import RotatingFileHandler
import requests
import tqdm

import vocal
from vocal import cfg, tool
from vocal.cfg import ROOT_DIR
from audio_separator.separator import Separator

_job_local = threading.local()
_jobs = {}
_jobs_lock = threading.Lock()
_sep_exec_lock = threading.Lock()
_separator_cache = OrderedDict()
_whisper_cache = OrderedDict()
_model_states = {}
_model_states_lock = threading.Lock()
_MAX_CACHED_MODELS = 2
_MAX_CACHED_WHISPER = 1
_WHISPER_MODELS = ("turbo", "medium", "small", "base", "tiny", "large-v3")
_WHISPER_DIR = os.path.join(cfg.MODEL_DIR, "whisper")
_orig_tqdm_update = tqdm.tqdm.update
_orig_tqdm_iter = tqdm.tqdm.__iter__


def _emit_tqdm_progress(bar, n, total):
    cb = getattr(_job_local, "progress_cb", None)
    if cb is not None and total and total > 0:
        try:
            cb(n, total, id(bar), getattr(bar, "desc", "") or "")
        except Exception:
            pass


def _tracked_tqdm_update(self, n=1):
    res = _orig_tqdm_update(self, n)
    if not getattr(self, "_in_tracked_iter", False):
        _emit_tqdm_progress(self, self.n, self.total)
    return res


def _tracked_tqdm_iter(self):
    total = self.total
    if total is None and self.iterable is not None:
        try:
            total = len(self.iterable)
        except Exception:
            total = None
    self._in_tracked_iter = True
    count = 0
    try:
        for item in _orig_tqdm_iter(self):
            yield item
            count += 1
            _emit_tqdm_progress(self, count, total)
    finally:
        self._in_tracked_iter = False


tqdm.tqdm.update = _tracked_tqdm_update
tqdm.tqdm.__iter__ = _tracked_tqdm_iter


class CustomRequestHandler(WSGIHandler):
    def log_request(self):
        pass


log = logging.getLogger("werkzeug")
log.handlers[:] = []
log.setLevel(logging.WARNING)

app = Flask(
    __name__,
    static_folder=os.path.join(ROOT_DIR, "static"),
    static_url_path="/static",
    template_folder=os.path.join(ROOT_DIR, "templates"),
)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
root_log = logging.getLogger()
root_log.handlers = []
root_log.setLevel(logging.WARNING)

app.logger.setLevel(logging.WARNING)
file_handler = RotatingFileHandler(
    os.path.join(ROOT_DIR, "vocal.log"), maxBytes=1024 * 1024, backupCount=5
)
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
file_handler.setLevel(logging.WARNING)
file_handler.setFormatter(formatter)
app.logger.addHandler(file_handler)


@app.route("/")
def index():
    return render_template(
        "index.html",
        version=vocal.version_str,
        cuda=cfg.cuda,
        root_dir=ROOT_DIR.replace("\\", "/"),
    )


@app.route("/upload", methods=["POST"])
def upload():
    try:
        audio_file = request.files["audio"]
        noextname, ext = os.path.splitext(audio_file.filename)
        ext = ext.lower()
        wav_file = os.path.join(cfg.TMP_DIR, f"{noextname}.wav")
        if os.path.exists(wav_file) and os.path.getsize(wav_file) > 0:
            return jsonify(
                {
                    "code": 0,
                    "msg": cfg.transobj["lang1"],
                    "data": os.path.basename(wav_file),
                }
            )
        msg = ""
        if ext in [".mp4", ".mov", ".avi", ".mkv", ".mpeg", ".mp3", ".flac"]:
            video_file = os.path.join(cfg.TMP_DIR, f"{noextname}{ext}")
            audio_file.save(video_file)
            params = [
                "-i",
                video_file,
            ]
            if ext not in [".mp3", ".flac"]:
                params.append("-vn")
            params.append(wav_file)
            rs = gevent.get_hub().threadpool.spawn(tool.runffmpeg, params).get()
            if rs != "ok":
                return jsonify({"code": 1, "msg": rs})
            msg = "," + cfg.transobj["lang9"]
        elif ext == ".wav":
            audio_file.save(wav_file)
        else:
            return jsonify({"code": 1, "msg": f"{cfg.transobj['lang3']} {ext}"})

        return jsonify(
            {
                "code": 0,
                "msg": cfg.transobj["lang1"] + msg,
                "data": os.path.basename(wav_file),
            }
        )
    except Exception as e:
        app.logger.error(f"[upload]error: {e}")
        return jsonify({"code": 2, "msg": cfg.transobj["lang2"]})


def _normalize_quality(raw):
    return "fast" if (raw or "").strip().lower() == "fast" else "quality"


def _model_exists_locally(model):
    """Return True if all local files for a model key exist in cfg.MODEL_DIR."""
    filename = cfg.MODEL_MAP.get(model)
    if not filename or not os.path.isdir(cfg.MODEL_DIR):
        return False
    main_path = os.path.join(cfg.MODEL_DIR, filename)
    if not os.path.isfile(main_path) or os.path.getsize(main_path) == 0:
        return False

    if filename.lower().endswith(".ckpt"):
        yaml_path = os.path.splitext(main_path)[0] + ".yaml"
        return os.path.isfile(yaml_path) and os.path.getsize(yaml_path) > 0

    if filename.lower().endswith(".yaml"):
        try:
            with open(main_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            model_ids = re.findall(r"['\"]([0-9a-fA-F]{6,})['\"]", content)
            if model_ids:
                dir_files = os.listdir(cfg.MODEL_DIR)
                for mid in model_ids:
                    if not any(
                        df.startswith(mid)
                        and df.endswith(".th")
                        and os.path.getsize(os.path.join(cfg.MODEL_DIR, df)) > 0
                        for df in dir_files
                    ):
                        return False
        except OSError:
            return False

    return True


def _set_model_state(model, state, progress=0, error=None):
    with _model_states_lock:
        _model_states[model] = {
            "state": state,
            "progress": progress,
            "error": error,
        }


def _get_models_status_snapshot():
    snapshot = {}
    for model in cfg.MODEL_MAP:
        downloaded = _model_exists_locally(model)
        with _model_states_lock:
            entry = dict(_model_states.get(model) or {})
        state = entry.get("state")
        if not state:
            if model in _separator_cache:
                state = "loaded"
            elif downloaded:
                state = "cached_on_disk"
            else:
                state = "not_downloaded"
        snapshot[model] = {
            "state": state,
            "downloaded": downloaded or state == "loaded",
            "progress": entry.get("progress", 100 if state == "loaded" else 0),
            "error": entry.get("error"),
        }
    return snapshot


def _configure_separator(separator, quality, dirname):
    os.makedirs(dirname, exist_ok=True)
    separator.output_dir = dirname
    inst = getattr(separator, "model_instance", None)
    if inst is not None:
        inst.output_dir = dirname
        if hasattr(inst, "shifts"):
            inst.shifts = 1 if quality == "fast" else 2
        elif hasattr(inst, "is_roformer"):
            inst.overlap = 2 if quality == "fast" else 4


def _get_cached_separator(model, quality, dirname, on_load_progress=None):
    """Return a cached, GPU-accelerated Separator (caller must hold _sep_exec_lock).
    If the model is not present locally, audio-separator downloads it on first run.
    """
    sep = _separator_cache.get(model)
    if sep is not None:
        _separator_cache.move_to_end(model)
        _configure_separator(sep, quality, dirname)
        _set_model_state(model, "loaded", progress=100)
        return sep, True

    while len(_separator_cache) >= _MAX_CACHED_MODELS:
        evicted_key, evicted = _separator_cache.popitem(last=False)
        del evicted
        _set_model_state(
            evicted_key,
            "cached_on_disk" if _model_exists_locally(evicted_key) else "not_downloaded",
            progress=0,
        )
        if cfg.cuda:
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:
                pass

    exists_locally = _model_exists_locally(model)
    before_files = (
        set(os.listdir(cfg.MODEL_DIR))
        if (not exists_locally and os.path.isdir(cfg.MODEL_DIR))
        else set()
    )
    _set_model_state(
        model,
        "loading" if exists_locally else "downloading",
        progress=0,
    )

    sep = Separator(
        output_dir=dirname,
        model_file_dir=cfg.MODEL_DIR,
        output_format="WAV",
        use_autocast=cfg.cuda,
        use_soundfile=True,
    )

    def wrapped_load_progress(n, total, bar_id, desc):
        ratio = min(1.0, max(0.0, n / total)) if total else 0.0
        _set_model_state(model, "downloading", progress=int(ratio * 100))
        if on_load_progress is not None:
            on_load_progress(n, total, bar_id, desc)

    _job_local.progress_cb = wrapped_load_progress
    try:
        sep.load_model(model_filename=cfg.MODEL_MAP[model])
    except Exception as exc:
        if not exists_locally and os.path.isdir(cfg.MODEL_DIR):
            for fname in set(os.listdir(cfg.MODEL_DIR)) - before_files:
                if fname == "download_checks.json":
                    continue
                try:
                    os.remove(os.path.join(cfg.MODEL_DIR, fname))
                except OSError:
                    pass
        _set_model_state(
            model,
            "cached_on_disk" if _model_exists_locally(model) else "not_downloaded",
            progress=0,
            error=str(exc),
        )
        raise
    finally:
        _job_local.progress_cb = None

    _configure_separator(sep, quality, dirname)
    _separator_cache[model] = sep
    _set_model_state(model, "loaded", progress=100)
    return sep, False


def _preload_models_async():
    """Preload locally available models into memory on startup without blocking HTTP.
    Models that do not exist locally are skipped and downloaded on first run.
    """
    loaded_count = 0
    for model in cfg.MODEL_MAP:
        if loaded_count >= _MAX_CACHED_MODELS:
            break
        if not _model_exists_locally(model):
            _set_model_state(model, "not_downloaded", progress=0)
            print(f"[preload] {model} not found locally; will download on first run")
            continue
        try:
            t0 = time.perf_counter()
            with _sep_exec_lock:
                _get_cached_separator(model, "quality", cfg.FILES_DIR)
            loaded_count += 1
            print(f"[preload] loaded {model} in {time.perf_counter() - t0:.2f}s")
        except Exception as e:
            app.logger.warning(f"[preload] failed to preload {model}: {e}")
            print(f"[preload] failed to preload {model}: {e}")


@app.route("/models/status", methods=["GET"])
def models_status():
    return jsonify({"code": 0, "models": _get_models_status_snapshot()})


# Separates an uploaded wav into stems and returns their URLs
@app.route("/process", methods=["GET", "POST"])
def process():
    wav_name = request.form.get("wav_name").strip()
    model = request.form.get("model")
    quality = _normalize_quality(request.form.get("quality"))
    wav_file = os.path.join(cfg.TMP_DIR, wav_name)
    noextname = wav_name[:-4]
    if not os.path.exists(wav_file):
        return jsonify({"code": 1, "msg": f"{wav_file} {cfg.transobj['lang5']}"})
    if model not in cfg.MODEL_MAP:
        return jsonify({"code": 1, "msg": f"{model} {cfg.transobj['lang4']}"})
    dirname = os.path.join(cfg.FILES_DIR, noextname)
    try:
        with _sep_exec_lock:
            separator, _ = _get_cached_separator(model, quality, dirname)
            output_files = separator.separate(wav_file, cfg.OUTPUT_NAMES[model])
    except Exception as e:
        return jsonify({"code": 1, "msg": str(e)})
    return jsonify(_build_track_result(noextname, dirname, output_files))


def _build_track_result(noextname, dirname, output_files):
    data = []
    urllist = []
    stems = []
    for path in output_files:
        fname = os.path.basename(path)
        stem_name = fname[:-4]
        rel_url = f"/static/files/{quote(noextname)}/{quote(fname)}"
        data.append(stem_name)
        urllist.append(f"http://{cfg.web_address}{rel_url}")
        stems.append({"name": stem_name, "filename": fname, "url": rel_url})
    return {
        "code": 0,
        "msg": cfg.transobj["lang6"],
        "data": data,
        "urllist": urllist,
        "stems": stems,
        "track_name": noextname,
        "dirname": dirname,
    }


def _update_job(job_id, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _update_batch_item(job_id, idx, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None and "items" in job and 0 <= idx < len(job["items"]):
            job["items"][idx].update(fields)


def _prune_old_jobs():
    if len(_jobs) > 50:
        finished_ids = [
            k for k, v in _jobs.items() if v["status"] in ("done", "error")
        ]
        for old_id in finished_ids[:25]:
            _jobs.pop(old_id, None)


def _format_download_stage(model, n, total):
    ratio = min(1.0, max(0.0, n / total)) if total else 0.0
    if total >= 1_000_000:
        mb_done = n / 1_048_576
        mb_tot = total / 1_048_576
        return f"Downloading {model} model ({int(ratio * 100)}% • {mb_done:.0f}/{mb_tot:.0f} MB)..."
    return f"Downloading {model} model ({int(ratio * 100)}%)..."


def _run_separation_job(job_id, wav_file, noextname, model, quality, dirname):
    try:
        needs_download = not _model_exists_locally(model)
        _update_job(
            job_id,
            status="running",
            step=1,
            progress=5,
            stage=(
                f"Downloading {model} model (first run)..."
                if needs_download
                else f"Loading {model} model..."
            ),
        )

        def on_load_progress(n, total, bar_id, desc):
            ratio = min(1.0, max(0.0, n / total))
            pct = 5 + int(ratio * 10)
            _update_job(
                job_id,
                step=1,
                progress=pct,
                stage=_format_download_stage(model, n, total),
            )

        with _sep_exec_lock:
            separator, was_cached = _get_cached_separator(
                model, quality, dirname, on_load_progress=on_load_progress
            )

            _update_job(
                job_id,
                step=2,
                progress=15,
                stage=(
                    "Model cached — separating stems..."
                    if was_cached
                    else "Separating stems..."
                ),
            )

            seen_bars = []

            def on_separate_progress(n, total, bar_id, desc):
                if bar_id not in seen_bars:
                    seen_bars.append(bar_id)
                pass_idx = seen_bars.index(bar_id) + 1
                ratio = min(1.0, max(0.0, n / total))
                pct = 15 + int(ratio * 80)
                if n >= total:
                    _update_job(
                        job_id,
                        step=3,
                        progress=96,
                        stage="Writing output WAV files...",
                    )
                else:
                    prefix = (
                        f"Separating stems (pass {pass_idx}, "
                        if pass_idx > 1
                        else "Separating stems ("
                    )
                    _update_job(
                        job_id,
                        step=2,
                        progress=pct,
                        stage=f"{prefix}{int(n)}/{int(total)})",
                    )

            _job_local.progress_cb = on_separate_progress
            try:
                output_files = separator.separate(wav_file, cfg.OUTPUT_NAMES[model])
            finally:
                _job_local.progress_cb = None

        _update_job(
            job_id,
            status="done",
            step=3,
            progress=100,
            stage="Separation complete",
            finished_at=time.time(),
            result=_build_track_result(noextname, dirname, output_files),
        )
    except Exception as e:
        _job_local.progress_cb = None
        app.logger.error(f"[job:{job_id}] error: {e}")
        _update_job(
            job_id,
            status="error",
            stage="Separation failed",
            finished_at=time.time(),
            error=str(e),
        )


def _run_batch_job(job_id, entries, model, quality):
    total_files = len(entries)
    completed = 0
    failed = 0
    try:
        needs_download = not _model_exists_locally(model)
        _update_job(
            job_id,
            status="running",
            step=1,
            progress=3,
            stage=(
                f"Downloading {model} model (first run)..."
                if needs_download
                else f"Loading {model} model for {total_files} files..."
            ),
        )

        def on_load_progress(n, total, bar_id, desc):
            ratio = min(1.0, max(0.0, n / total))
            pct = 3 + int(ratio * 7)
            _update_job(
                job_id,
                step=1,
                progress=pct,
                stage=_format_download_stage(model, n, total),
            )

        with _sep_exec_lock:
            separator, _ = _get_cached_separator(
                model, quality, cfg.FILES_DIR, on_load_progress=on_load_progress
            )

            for idx, (wav_file, wav_name, noextname, dirname) in enumerate(entries):
                file_start = 10.0 + (idx / total_files) * 90.0
                file_span = 90.0 / total_files
                _update_batch_item(
                    job_id, idx, status="running", progress=2, stage="Separating..."
                )
                _update_job(
                    job_id,
                    step=2,
                    progress=int(file_start),
                    stage=f"File {idx + 1}/{total_files}: {noextname}",
                )

                seen_bars = []

                def make_cb(
                    i=idx, name=noextname, start=file_start, span=file_span, bars=seen_bars
                ):
                    def on_file_progress(n, total, bar_id, desc):
                        if bar_id not in bars:
                            bars.append(bar_id)
                        pass_idx = bars.index(bar_id) + 1
                        ratio = min(1.0, max(0.0, n / total))
                        file_pct = min(98, max(2, int(ratio * 95)))
                        overall_pct = min(99, int(start + ratio * span * 0.95))
                        if n >= total:
                            item_stage = "Writing WAVs..."
                            job_stage = f"File {i + 1}/{total_files}: {name} — Writing WAVs..."
                        else:
                            pass_txt = f"pass {pass_idx}, " if pass_idx > 1 else ""
                            item_stage = f"{pass_txt}{int(n)}/{int(total)}"
                            job_stage = f"File {i + 1}/{total_files}: {name} ({item_stage})"
                        _update_batch_item(job_id, i, progress=file_pct, stage=item_stage)
                        _update_job(job_id, step=2, progress=overall_pct, stage=job_stage)

                    return on_file_progress

                try:
                    _configure_separator(separator, quality, dirname)
                    _job_local.progress_cb = make_cb()
                    try:
                        output_files = separator.separate(wav_file, cfg.OUTPUT_NAMES[model])
                    finally:
                        _job_local.progress_cb = None

                    result = _build_track_result(noextname, dirname, output_files)
                    completed += 1
                    _update_batch_item(
                        job_id,
                        idx,
                        status="done",
                        progress=100,
                        stage="Done",
                        result=result,
                    )
                except Exception as file_err:
                    _job_local.progress_cb = None
                    failed += 1
                    app.logger.error(f"[batch:{job_id}:{wav_name}] error: {file_err}")
                    _update_batch_item(
                        job_id,
                        idx,
                        status="error",
                        stage="Failed",
                        error=str(file_err),
                    )

                _update_job(
                    job_id,
                    completed_count=completed,
                    failed_count=failed,
                    progress=min(99, int(file_start + file_span)),
                )

        final_status = "error" if (completed == 0 and failed > 0) else "done"
        if failed == 0:
            final_stage = f"Batch complete ({completed}/{total_files} files separated)"
        elif completed == 0:
            final_stage = f"Batch failed ({failed} of {total_files} files failed)"
        else:
            final_stage = f"Batch complete ({completed} succeeded, {failed} failed)"

        _update_job(
            job_id,
            status=final_status,
            step=3,
            progress=100,
            stage=final_stage,
            completed_count=completed,
            failed_count=failed,
            finished_at=time.time(),
            error=(f"{failed} file(s) failed" if final_status == "error" else None),
        )
    except Exception as e:
        _job_local.progress_cb = None
        app.logger.error(f"[batch:{job_id}] error: {e}")
        _update_job(
            job_id,
            status="error",
            stage="Batch separation failed",
            finished_at=time.time(),
            error=str(e),
        )


@app.route("/jobs", methods=["POST"])
def create_job():
    wav_name = (request.form.get("wav_name") or "").strip()
    model = request.form.get("model")
    quality = _normalize_quality(request.form.get("quality"))
    wav_file = os.path.join(cfg.TMP_DIR, wav_name)
    noextname = wav_name[:-4] if wav_name.lower().endswith(".wav") else wav_name
    if not wav_name or not os.path.exists(wav_file):
        return jsonify({"code": 1, "msg": f"{wav_file} {cfg.transobj['lang5']}"})
    if model not in cfg.MODEL_MAP:
        return jsonify({"code": 1, "msg": f"{model} {cfg.transobj['lang4']}"})

    dirname = os.path.join(cfg.FILES_DIR, noextname)
    job_id = uuid.uuid4().hex
    now = time.time()
    with _jobs_lock:
        _prune_old_jobs()
        _jobs[job_id] = {
            "job_id": job_id,
            "mode": "single",
            "status": "queued",
            "step": 1,
            "progress": 2,
            "stage": "Starting separation job...",
            "started_at": now,
            "finished_at": None,
            "result": None,
            "error": None,
        }

    threading.Thread(
        target=_run_separation_job,
        args=(job_id, wav_file, noextname, model, quality, dirname),
        daemon=True,
    ).start()
    return jsonify({"code": 0, "job_id": job_id})


@app.route("/jobs/batch", methods=["POST"])
def create_batch_job():
    payload = request.get_json(silent=True) or {}
    wav_names = payload.get("wav_names")
    if wav_names is None:
        wav_names = request.form.getlist("wav_names")
    model = payload.get("model") or request.form.get("model")
    quality = _normalize_quality(payload.get("quality") or request.form.get("quality"))

    if model not in cfg.MODEL_MAP:
        return jsonify({"code": 1, "msg": f"{model} {cfg.transobj['lang4']}"})
    if not isinstance(wav_names, list) or not wav_names:
        return jsonify({"code": 1, "msg": "No files provided for batch separation"})

    entries = []
    seen_names = set()
    for raw_name in wav_names:
        wn = (raw_name or "").strip()
        if not wn or wn in seen_names:
            continue
        wav_file = os.path.join(cfg.TMP_DIR, wn)
        if not os.path.exists(wav_file):
            return jsonify({"code": 1, "msg": f"{wav_file} {cfg.transobj['lang5']}"})
        noextname = wn[:-4] if wn.lower().endswith(".wav") else wn
        dirname = os.path.join(cfg.FILES_DIR, noextname)
        entries.append((wav_file, wn, noextname, dirname))
        seen_names.add(wn)

    if not entries:
        return jsonify({"code": 1, "msg": "No valid files provided for batch separation"})

    job_id = uuid.uuid4().hex
    now = time.time()
    items = [
        {
            "wav_name": wn,
            "track_name": noextname,
            "status": "queued",
            "progress": 0,
            "stage": "Queued",
            "result": None,
            "error": None,
        }
        for (_, wn, noextname, _) in entries
    ]
    with _jobs_lock:
        _prune_old_jobs()
        _jobs[job_id] = {
            "job_id": job_id,
            "mode": "batch",
            "status": "queued",
            "step": 1,
            "progress": 2,
            "stage": f"Starting batch ({len(entries)} files)...",
            "started_at": now,
            "finished_at": None,
            "items": items,
            "completed_count": 0,
            "failed_count": 0,
            "total_count": len(entries),
            "result": None,
            "error": None,
        }

    threading.Thread(
        target=_run_batch_job,
        args=(job_id, entries, model, quality),
        daemon=True,
    ).start()
    return jsonify({"code": 0, "job_id": job_id})


@app.route("/jobs/<job_id>", methods=["GET"])
def get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return jsonify({"code": 1, "msg": "Job not found"}), 404
        end_ts = job["finished_at"] or time.time()
        payload = {
            "code": 0,
            "job_id": job["job_id"],
            "mode": job.get("mode", "single"),
            "status": job["status"],
            "step": job["step"],
            "progress": job["progress"],
            "stage": job["stage"],
            "elapsed": round(end_ts - job["started_at"], 1),
            "result": job["result"],
            "error": job["error"],
        }
        if "items" in job:
            payload["items"] = [dict(it) for it in job["items"]]
            payload["completed_count"] = job.get("completed_count", 0)
            payload["failed_count"] = job.get("failed_count", 0)
            payload["total_count"] = job.get("total_count", len(job["items"]))
    return jsonify(payload)


@app.route("/history", methods=["GET"])
def history():
    tracks = []
    if os.path.isdir(cfg.FILES_DIR):
        for entry in os.listdir(cfg.FILES_DIR):
            track_dir = os.path.join(cfg.FILES_DIR, entry)
            if not os.path.isdir(track_dir):
                continue
            wav_files = sorted(
                f for f in os.listdir(track_dir) if f.lower().endswith(".wav")
            )
            if not wav_files:
                continue
            mtime = max(
                os.path.getmtime(os.path.join(track_dir, f)) for f in wav_files
            )
            stems = [
                {
                    "name": f[:-4],
                    "filename": f,
                    "url": f"/static/files/{quote(entry)}/{quote(f)}",
                }
                for f in wav_files
            ]
            tracks.append(
                {
                    "name": entry,
                    "dirname": track_dir,
                    "mtime": mtime,
                    "stems": stems,
                }
            )
    tracks.sort(key=lambda t: t["mtime"], reverse=True)
    return jsonify({"code": 0, "tracks": tracks})


_LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"
_LRCLIB_HEADERS = {
    "User-Agent": f"VocalSeparate/{vocal.version_str} (https://github.com/jianchang512/vocal-separate)"
}


def _safe_track_dir(track_name):
    if (
        not track_name
        or "/" in track_name
        or "\\" in track_name
        or track_name in (".", "..")
    ):
        return None
    base = os.path.abspath(cfg.FILES_DIR)
    full = os.path.abspath(os.path.join(base, track_name))
    if not full.startswith(base + os.sep) or not os.path.isdir(full):
        return None
    return full


def _get_track_duration(track_dir):
    try:
        for fname in os.listdir(track_dir):
            if fname.lower().endswith(".wav"):
                with wave.open(os.path.join(track_dir, fname), "rb") as wf:
                    rate = wf.getframerate()
                    if rate > 0:
                        return round(wf.getnframes() / float(rate), 2)
    except Exception:
        pass
    return None


def _clean_track_query(track_name):
    s = (track_name or "").strip()
    s = re.sub(r"^YTDown\.com_YouTube_Media_[A-Za-z0-9_-]{8,15}_", "", s, flags=re.IGNORECASE)
    s = re.sub(r"_\d{2,4}_\d{2,4}k$", "", s, flags=re.IGNORECASE)
    s = re.sub(
        r"[\(\[\{]\s*(?:official\s*(?:music\s*)?(?:video|mv|audio|lyric(?:s)?)|lyric(?:s)?|hd|4k|hq|mv|audio)\s*[\)\]\}]",
        " ",
        s,
        flags=re.IGNORECASE,
    )
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or (track_name or "").strip()


def _query_lrclib(query, duration=None):
    resp = requests.get(
        _LRCLIB_SEARCH_URL,
        params={"q": query},
        headers=_LRCLIB_HEADERS,
        timeout=10,
    )
    resp.raise_for_status()
    raw_items = resp.json()
    if not isinstance(raw_items, list):
        return []

    candidates = []
    for item in raw_items:
        synced = (item.get("syncedLyrics") or "").strip() or None
        plain = (item.get("plainLyrics") or "").strip() or None
        if not synced and not plain:
            continue
        item_dur = item.get("duration")
        dur_diff = (
            abs(float(item_dur) - float(duration))
            if (duration is not None and item_dur is not None)
            else 999.0
        )
        candidates.append(
            {
                "id": item.get("id"),
                "trackName": item.get("trackName") or "",
                "artistName": item.get("artistName") or "",
                "albumName": item.get("albumName") or "",
                "duration": item_dur,
                "syncedLyrics": synced,
                "plainLyrics": plain,
                "source": "LRCLIB",
                "_score": (
                    0 if synced else 1,
                    0 if dur_diff <= 5.0 else (1 if dur_diff <= 15.0 else 2),
                    dur_diff,
                ),
            }
        )

    candidates.sort(key=lambda c: c["_score"])
    for c in candidates:
        c.pop("_score", None)
    return candidates


@app.route("/lyrics", methods=["GET"])
def get_lyrics():
    track = (request.args.get("track") or "").strip()
    track_dir = _safe_track_dir(track)
    suggested_query = _clean_track_query(track)
    duration = _get_track_duration(track_dir) if track_dir else None

    if track_dir:
        lyrics_path = os.path.join(track_dir, "lyrics.json")
        if os.path.isfile(lyrics_path):
            try:
                with open(lyrics_path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                return jsonify(
                    {
                        "code": 0,
                        "cached": True,
                        "lyrics": saved,
                        "suggested_query": suggested_query,
                        "duration": duration,
                    }
                )
            except Exception as e:
                app.logger.warning(f"[lyrics] failed to read cache for {track}: {e}")

    return jsonify(
        {
            "code": 0,
            "cached": False,
            "lyrics": None,
            "suggested_query": suggested_query,
            "duration": duration,
        }
    )


@app.route("/lyrics/search", methods=["GET"])
def search_lyrics():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"code": 1, "msg": "Search query is required", "results": []})
    dur_raw = request.args.get("duration")
    try:
        duration = float(dur_raw) if dur_raw not in (None, "", "null") else None
    except ValueError:
        duration = None

    try:
        results = gevent.get_hub().threadpool.spawn(
            _query_lrclib, query, duration
        ).get()
        return jsonify({"code": 0, "results": results})
    except Exception as e:
        app.logger.warning(f"[lyrics/search] error for {query!r}: {e}")
        return jsonify({"code": 1, "msg": f"Lyrics lookup failed: {e}", "results": []})


def _write_lyrics_cache(track_dir, lyrics):
    record = {
        "id": lyrics.get("id"),
        "trackName": lyrics.get("trackName") or "",
        "artistName": lyrics.get("artistName") or "",
        "albumName": lyrics.get("albumName") or "",
        "duration": lyrics.get("duration"),
        "syncedLyrics": lyrics.get("syncedLyrics"),
        "plainLyrics": lyrics.get("plainLyrics"),
        "source": lyrics.get("source") or "LRCLIB",
        "offset": float(lyrics.get("offset") or 0.0),
    }
    lyrics_path = os.path.join(track_dir, "lyrics.json")
    with open(lyrics_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return record


@app.route("/lyrics/save", methods=["POST"])
def save_lyrics():
    payload = request.get_json(silent=True) or {}
    track = (payload.get("track") or "").strip()
    lyrics = payload.get("lyrics")
    track_dir = _safe_track_dir(track)
    if not track_dir:
        return jsonify({"code": 1, "msg": "Track folder not found"}), 404
    if not isinstance(lyrics, dict):
        return jsonify({"code": 1, "msg": "Invalid lyrics payload"}), 400

    try:
        record = _write_lyrics_cache(track_dir, lyrics)
        return jsonify({"code": 0, "lyrics": record})
    except Exception as e:
        app.logger.error(f"[lyrics/save] error for {track}: {e}")
        return jsonify({"code": 1, "msg": str(e)}), 500


def _prepare_fingerprint_audio(track_name, track_dir):
    """Return (audio_path, temp_path_to_cleanup) for Shazam fingerprinting."""
    for ext in (".wav", ".mp3", ".flac", ".m4a", ".mp4", ".mov", ".mkv"):
        cand = os.path.join(cfg.TMP_DIR, f"{track_name}{ext}")
        if os.path.isfile(cand) and os.path.getsize(cand) > 0:
            return cand, None

    # Fallback: mix stems from track_dir into a temporary 25s clip
    wavs = sorted(
        os.path.join(track_dir, f)
        for f in os.listdir(track_dir)
        if f.lower().endswith(".wav")
    )
    if not wavs:
        return None, None
    if len(wavs) == 1:
        return wavs[0], None

    import numpy as np
    import soundfile as sf

    info = sf.info(wavs[0])
    sr = info.samplerate
    total_frames = info.frames
    clip_frames = min(total_frames, int(sr * 25))
    start_frame = min(max(0, total_frames - clip_frames), int(total_frames * 0.25))

    mixed = None
    for wp in wavs:
        data, _ = sf.read(wp, start=start_frame, frames=clip_frames, dtype="float32", always_2d=True)
        if mixed is None:
            mixed = data
        else:
            n = min(len(mixed), len(data))
            mixed = mixed[:n] + data[:n]

    peak = float(np.max(np.abs(mixed))) if mixed is not None and len(mixed) else 0.0
    if peak > 1.0:
        mixed = mixed / peak

    fd, tmp_wav = tempfile.mkstemp(prefix="vs_fp_", suffix=".wav")
    os.close(fd)
    sf.write(tmp_wav, mixed, sr)
    return tmp_wav, tmp_wav


def _fingerprint_and_lookup(track_name, track_dir, duration):
    audio_path, cleanup_path = _prepare_fingerprint_audio(track_name, track_dir)
    if not audio_path:
        return {"code": 1, "msg": "No audio file available to fingerprint", "results": []}

    async def _recognize(path):
        from shazamio import Shazam

        async with Shazam() as shazam:
            return await shazam.recognize(path)

    try:
        out = asyncio.run(_recognize(audio_path))
    finally:
        if cleanup_path and os.path.exists(cleanup_path):
            try:
                os.remove(cleanup_path)
            except OSError:
                pass

    track_info = (out or {}).get("track") or {}
    title = (track_info.get("title") or "").strip()
    artist = (track_info.get("subtitle") or "").strip()
    if not title:
        return {
            "code": 1,
            "msg": "Audio fingerprint did not match any known song. Try Local Whisper instead.",
            "results": [],
        }

    shazam_plain = None
    for sec in track_info.get("sections") or []:
        if sec.get("type") == "LYRICS" and sec.get("text"):
            shazam_plain = "\n".join(sec["text"]).strip()
            break

    query = f"{title} {artist}".strip()
    results = []
    try:
        results = _query_lrclib(query, duration)
        if not results and artist:
            results = _query_lrclib(title, duration)
        for item in results:
            item["source"] = "Shazam + LRCLIB"
    except Exception as e:
        app.logger.warning(f"[lyrics/fingerprint] LRCLIB lookup failed for {query!r}: {e}")

    if shazam_plain:
        results.append(
            {
                "id": f"shazam:{track_info.get('key', title)}",
                "trackName": title,
                "artistName": artist,
                "albumName": "",
                "duration": duration,
                "syncedLyrics": None,
                "plainLyrics": shazam_plain,
                "source": "Shazam",
            }
        )

    return {
        "code": 0,
        "identified": {"title": title, "artist": artist},
        "query": query,
        "results": results,
    }


@app.route("/lyrics/fingerprint", methods=["POST"])
def fingerprint_lyrics():
    payload = request.get_json(silent=True) or {}
    track = (payload.get("track") or "").strip()
    track_dir = _safe_track_dir(track)
    if not track_dir:
        return jsonify({"code": 1, "msg": "Track folder not found", "results": []}), 404
    duration = _get_track_duration(track_dir)
    try:
        res = gevent.get_hub().threadpool.spawn(
            _fingerprint_and_lookup, track, track_dir, duration
        ).get()
        return jsonify(res)
    except Exception as e:
        app.logger.error(f"[lyrics/fingerprint] error for {track}: {e}")
        return jsonify({"code": 1, "msg": f"Audio fingerprinting failed: {e}", "results": []})


def _format_lrc_timestamp(seconds):
    sec = max(0.0, float(seconds))
    mins = int(sec // 60)
    rem = sec - mins * 60
    return f"[{mins:02d}:{rem:05.2f}]"


def _get_cached_whisper(model_name, on_load_progress=None):
    """Return a cached Whisper model (caller must hold _sep_exec_lock)."""
    cached = _whisper_cache.get(model_name)
    if cached is not None:
        _whisper_cache.move_to_end(model_name)
        return cached, True

    while len(_whisper_cache) >= _MAX_CACHED_WHISPER:
        _, evicted = _whisper_cache.popitem(last=False)
        del evicted
        if cfg.cuda:
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:
                pass

    import whisper

    os.makedirs(_WHISPER_DIR, exist_ok=True)
    device = "cuda" if cfg.cuda else "cpu"
    _job_local.progress_cb = on_load_progress
    try:
        model = whisper.load_model(model_name, device=device, download_root=_WHISPER_DIR)
    finally:
        _job_local.progress_cb = None

    _whisper_cache[model_name] = model
    return model, False


def _pick_whisper_audio(track_name, track_dir):
    vocals = os.path.join(track_dir, "vocals.wav")
    if os.path.isfile(vocals) and os.path.getsize(vocals) > 0:
        return vocals, "vocals.wav"
    tmp_wav = os.path.join(cfg.TMP_DIR, f"{track_name}.wav")
    if os.path.isfile(tmp_wav) and os.path.getsize(tmp_wav) > 0:
        return tmp_wav, os.path.basename(tmp_wav)
    wavs = sorted(f for f in os.listdir(track_dir) if f.lower().endswith(".wav"))
    if wavs:
        return os.path.join(track_dir, wavs[0]), wavs[0]
    return None, None


def _run_whisper_job(job_id, track_name, track_dir, model_name, language):
    try:
        audio_path, audio_label = _pick_whisper_audio(track_name, track_dir)
        if not audio_path:
            raise FileNotFoundError("No audio stem found to transcribe.")

        _update_job(
            job_id,
            status="running",
            step=1,
            progress=8,
            stage=f"Loading Whisper ({model_name})...",
        )

        def on_download(n, total, bar_id, desc):
            ratio = min(1.0, max(0.0, n / total)) if total else 0.0
            pct = 8 + int(ratio * 22)
            _update_job(
                job_id,
                step=1,
                progress=pct,
                stage=_format_download_stage(f"Whisper {model_name}", n, total),
            )

        with _sep_exec_lock:
            whisper_model, was_cached = _get_cached_whisper(
                model_name, on_load_progress=on_download
            )
            _update_job(
                job_id,
                step=2,
                progress=35,
                stage=(
                    f"Transcribing {audio_label} with Whisper ({model_name})..."
                    if not was_cached
                    else f"Whisper cached — transcribing {audio_label}..."
                ),
            )

            transcribe_opts = {
                "fp16": bool(cfg.cuda),
                "condition_on_previous_text": False,
                "verbose": False,
            }
            if language:
                transcribe_opts["language"] = language

            result = whisper_model.transcribe(audio_path, **transcribe_opts)

        _update_job(
            job_id,
            step=3,
            progress=92,
            stage="Formatting synced LRC lyrics...",
        )

        lrc_lines = []
        plain_lines = []
        for seg in result.get("segments") or []:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            ts = _format_lrc_timestamp(seg.get("start", 0.0))
            lrc_lines.append(f"{ts} {text}")
            plain_lines.append(text)

        if not lrc_lines:
            raise RuntimeError("Whisper did not detect any sung vocals in this track.")

        detected_lang = (result.get("language") or language or "").upper()
        lang_suffix = f", {detected_lang}" if detected_lang else ""
        duration = _get_track_duration(track_dir)
        record = _write_lyrics_cache(
            track_dir,
            {
                "id": f"whisper:{model_name}:{int(time.time())}",
                "trackName": _clean_track_query(track_name),
                "artistName": f"Transcribed ({audio_label}{lang_suffix})",
                "albumName": "",
                "duration": duration,
                "syncedLyrics": "\n".join(lrc_lines),
                "plainLyrics": "\n".join(plain_lines),
                "source": f"Whisper ({model_name})",
                "offset": 0.0,
            },
        )

        _update_job(
            job_id,
            status="done",
            step=3,
            progress=100,
            stage=f"Transcribed {len(lrc_lines)} lines",
            finished_at=time.time(),
            result=record,
        )
    except Exception as e:
        _job_local.progress_cb = None
        app.logger.error(f"[whisper:{job_id}] error: {e}")
        _update_job(
            job_id,
            status="error",
            stage="Whisper transcription failed",
            finished_at=time.time(),
            error=str(e),
        )


@app.route("/lyrics/whisper", methods=["POST"])
def whisper_lyrics():
    payload = request.get_json(silent=True) or {}
    track = (payload.get("track") or "").strip()
    model_name = (payload.get("model") or "turbo").strip().lower()
    language = (payload.get("language") or "").strip().lower()

    track_dir = _safe_track_dir(track)
    if not track_dir:
        return jsonify({"code": 1, "msg": "Track folder not found"}), 404
    if model_name not in _WHISPER_MODELS:
        return jsonify({"code": 1, "msg": f"Unsupported Whisper model: {model_name}"}), 400

    job_id = uuid.uuid4().hex
    now = time.time()
    with _jobs_lock:
        _prune_old_jobs()
        _jobs[job_id] = {
            "job_id": job_id,
            "mode": "whisper",
            "status": "queued",
            "step": 1,
            "progress": 4,
            "stage": f"Starting Whisper ({model_name})...",
            "started_at": now,
            "finished_at": None,
            "result": None,
            "error": None,
        }

    threading.Thread(
        target=_run_whisper_job,
        args=(job_id, track, track_dir, model_name, language),
        daemon=True,
    ).start()
    return jsonify({"code": 0, "job_id": job_id})


@app.route("/api", methods=["POST"])
def api():
    try:
        audio_file = request.files["file"]
        model = request.form.get("model")
        noextname, ext = os.path.splitext(audio_file.filename)
        ext = ext.lower()
        wav_file = os.path.join(cfg.TMP_DIR, f"{noextname}.wav")
        if not os.path.exists(wav_file) or os.path.getsize(wav_file) == 0:
            if ext in [".mp4", ".mov", ".avi", ".mkv", ".mpeg", ".mp3", ".flac"]:
                video_file = os.path.join(cfg.TMP_DIR, f"{noextname}{ext}")
                audio_file.save(video_file)
                params = [
                    "-i",
                    video_file,
                ]
                if ext not in [".mp3", ".flac"]:
                    params.append("-vn")
                params.append(wav_file)
                rs = gevent.get_hub().threadpool.spawn(tool.runffmpeg, params).get()
                if rs != "ok":
                    return jsonify({"code": 1, "msg": rs})
            elif ext == ".wav":
                audio_file.save(wav_file)
            else:
                return jsonify({"code": 1, "msg": f"{cfg.transobj['lang3']} {ext}"})

        if not os.path.exists(wav_file):
            return jsonify({"code": 1, "msg": f"{wav_file} {cfg.transobj['lang5']}"})
        if model not in cfg.MODEL_MAP:
            return jsonify({"code": 1, "msg": f"{model} {cfg.transobj['lang4']}"})
        quality = _normalize_quality(request.form.get("quality"))
        dirname = os.path.join(cfg.FILES_DIR, noextname)
        try:
            with _sep_exec_lock:
                separator, _ = _get_cached_separator(model, quality, dirname)
                output_files = separator.separate(wav_file, cfg.OUTPUT_NAMES[model])
        except Exception as e:
            return jsonify({"code": 1, "msg": str(e)})
        status = {
            "accompaniment.wav": "accompaniment audio",
            "bass.wav": "bass audio",
            "drums.wav": "drums audio",
            "piano.wav": "piano audio",
            "guitar.wav": "guitar audio",
            "vocals.wav": "vocals audio",
            "other.wav": "other audio",
        }
        urllist = [
            f"http://{cfg.web_address}/static/files/{noextname}/{os.path.basename(path)}"
            for path in output_files
        ]

        return jsonify(
            {
                "code": 0,
                "msg": cfg.transobj["lang6"],
                "data": urllist,
                "status_text": status,
            }
        )
    except Exception as e:
        app.logger.error(f"[upload]error: {e}")
        return jsonify({"code": 2, "msg": cfg.transobj["lang2"]})


@app.route("/checkupdate", methods=["GET", "POST"])
def checkupdate():
    return jsonify({"code": 0, "msg": cfg.updatetips})


if __name__ == "__main__":
    http_server = None
    try:
        threading.Thread(target=tool.checkupdate, daemon=True).start()
        threading.Thread(target=_preload_models_async, daemon=True).start()
        try:
            host = cfg.web_address.split(":")
            http_server = WSGIServer(
                (host[0], int(host[1])), app, handler_class=CustomRequestHandler
            )
            threading.Thread(target=tool.openweb, args=(cfg.web_address,), daemon=True).start()
            http_server.serve_forever()
        finally:
            if http_server:
                http_server.stop()
    except Exception as e:
        if http_server:
            http_server.stop()
        print("error:" + str(e))
        app.logger.error(f"[app]start error:{str(e)}")
