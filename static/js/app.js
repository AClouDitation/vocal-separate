(() => {
    const STEM_ORDER = ["vocals", "accompaniment", "instrumental", "drums", "bass", "guitar", "piano", "other"];
    const STEM_COLORS = {
        vocals: "#a855f7",
        accompaniment: "#06b6d4",
        instrumental: "#06b6d4",
        drums: "#f97316",
        bass: "#3b82f6",
        guitar: "#10b981",
        piano: "#eab308",
        other: "#94a3b8"
    };
    const UPLOAD_CONCURRENCY = 4;

    const state = {
        mode: "single", // "single" | "batch"
        quality: localStorage.getItem("vs-quality") || "quality", // "quality" | "fast"
        uploadedWav: "",
        batchItems: [], // { id, origName, wavName, status, progress, stage, result, error }
        selectedModel: "2stems",
        modelStatuses: {},
        isUploading: false,
        isProcessing: false,
        tracks: [],
        activeTrack: null,
        stems: [], // { name, filename, url, audio, volume, muted, solo }
        isPlaying: false,
        loop: false,
        masterVolume: 1,
        duration: 0,
        isSeeking: false,
        rafId: null,
        lastSyncCheck: 0,
        lyrics: null,          // current saved/selected lyrics record
        lyricsLines: [],       // parsed [{ time, text }] for synced LRC
        lyricsOffset: 0,       // seconds added to playback time for highlighting
        lyricsActiveIdx: -1,
        lyricsCandidates: [],
        lyricsReqToken: 0
    };

    const $ = (id) => document.getElementById(id);
    const dropzone = $("dropzone");
    const fileInput = $("fileInput");

    // Theme
    const savedTheme = localStorage.getItem("vs-theme") || "dark";
    applyTheme(savedTheme);
    $("themeToggle").addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        localStorage.setItem("vs-theme", next);
        applyTheme(next);
    });

    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        $("themeIcon").innerHTML = theme === "dark"
            ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
            : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    }

    // Alerts & Toast
    let toastTimer = null;
    function showToast(msg) {
        const el = $("toast");
        el.textContent = msg;
        el.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
    }

    function showAlert(msg, type = "error") {
        const el = $("alertBanner");
        $("alertText").textContent = msg;
        el.className = `alert show ${type}`;
    }

    function hideAlert() {
        $("alertBanner").classList.remove("show");
    }
    $("alertClose").addEventListener("click", hideAlert);

    // Format helpers
    function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return "0:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    function formatDate(mtime) {
        const d = new Date(mtime * 1000);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // Quality / Speed Preset
    function applyQuality(nextQuality) {
        state.quality = nextQuality === "fast" ? "fast" : "quality";
        localStorage.setItem("vs-quality", state.quality);
        document.querySelectorAll(".quality-btn").forEach((b) => {
            const active = b.dataset.quality === state.quality;
            b.classList.toggle("active", active);
            b.setAttribute("aria-pressed", String(active));
        });
        $("qualityHint").textContent = state.quality === "fast"
            ? "~2× faster (overlap 2 / 1 shift)"
            : "Max quality (overlap 4 / 2 shifts)";
    }

    applyQuality(state.quality);
    document.querySelectorAll(".quality-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (state.isProcessing) return;
            applyQuality(btn.dataset.quality);
        });
    });

    // Mode Switching (Single vs Batch)
    function setMode(nextMode) {
        if (state.isProcessing || state.isUploading) return;
        state.mode = nextMode;
        fileInput.multiple = nextMode === "batch";
        document.querySelectorAll(".mode-btn[data-mode]").forEach((b) => {
            const active = b.dataset.mode === nextMode;
            b.classList.toggle("active", active);
            b.setAttribute("aria-selected", String(active));
        });
        if (nextMode === "batch") {
            $("dropzoneTitle").textContent = "Drop multiple audio or video files here, or click to add files";
            $("dropzoneSub").textContent = "Uploads convert in parallel and the model loads once for the whole batch";
            $("uploadedFile").classList.remove("show");
            if (state.uploadedWav && !state.batchItems.some((it) => it.wavName === state.uploadedWav)) {
                state.batchItems.push({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    origName: state.uploadedWav,
                    wavName: state.uploadedWav,
                    status: "ready",
                    progress: 100,
                    stage: "Ready",
                    result: null,
                    error: null
                });
            }
            renderBatchQueue();
        } else {
            $("dropzoneTitle").textContent = "Drop an audio or video file here, or click to browse";
            $("dropzoneSub").textContent = "Drop multiple files at once to switch to Batch Mode automatically";
            $("batchQueue").classList.remove("show");
            $("uploadedFile").classList.toggle("show", Boolean(state.uploadedWav));
        }
        updateActionState();
    }

    document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    // Dropzone & Upload
    dropzone.addEventListener("click", () => {
        if (!state.isUploading && !state.isProcessing) fileInput.click();
    });
    dropzone.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !state.isUploading && !state.isProcessing) {
            e.preventDefault();
            fileInput.click();
        }
    });
    $("changeFileBtn").addEventListener("click", () => {
        if (!state.isUploading && !state.isProcessing) fileInput.click();
    });
    $("batchAddMoreBtn").addEventListener("click", () => {
        if (!state.isUploading && !state.isProcessing) fileInput.click();
    });
    $("batchClearBtn").addEventListener("click", () => {
        if (state.isUploading || state.isProcessing) return;
        state.batchItems = [];
        renderBatchQueue();
        updateActionState();
    });

    ["dragenter", "dragover"].forEach((ev) => {
        dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add("dragover");
        });
    });
    ["dragleave", "drop"].forEach((ev) => {
        dropzone.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove("dragover");
        });
    });
    dropzone.addEventListener("drop", (e) => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) handleSelectedFiles(files);
    });
    fileInput.addEventListener("change", () => {
        const files = Array.from(fileInput.files || []);
        if (files.length) handleSelectedFiles(files);
        fileInput.value = "";
    });

    function handleSelectedFiles(files) {
        if (state.isUploading || state.isProcessing) return;
        if (files.length > 1 && state.mode === "single") {
            setMode("batch");
            showToast(`Switched to Batch Mode (${files.length} files)`);
        }
        if (state.mode === "batch") {
            uploadBatchFiles(files);
        } else {
            uploadSingleFile(files[0]);
        }
    }

    function sendUploadXhr(file, onProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append("audio", file);
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/upload");
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            };
            xhr.onload = () => {
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.code !== 0) reject(new Error(res.msg || "Upload failed"));
                    else resolve(res);
                } catch {
                    reject(new Error("Unexpected server response while uploading."));
                }
            };
            xhr.onerror = () => reject(new Error("Network error during upload."));
            xhr.send(formData);
        });
    }

    async function uploadSingleFile(file) {
        if (state.isUploading || state.isProcessing) return;
        hideAlert();
        state.isUploading = true;
        updateActionState();

        const progWrap = $("uploadProgress");
        const progFill = $("uploadProgressFill");
        const statusText = $("uploadStatusText");
        const pctText = $("uploadPctText");

        progWrap.classList.add("show");
        progFill.classList.remove("indeterminate");
        progFill.style.width = "0%";
        statusText.textContent = `Uploading ${file.name}...`;
        pctText.textContent = "0%";

        try {
            const res = await sendUploadXhr(file, (pct) => {
                progFill.style.width = `${pct}%`;
                pctText.textContent = `${pct}%`;
                if (pct >= 100) {
                    statusText.textContent = "Preparing WAV audio...";
                    pctText.textContent = "";
                    progFill.classList.add("indeterminate");
                }
            });
            state.uploadedWav = res.data;
            $("uploadedFileName").textContent = res.data;
            $("uploadedFileMsg").textContent = res.msg || "Ready to separate";
            $("previewAudio").src = `/static/tmp/${encodeURIComponent(res.data)}`;
            $("uploadedFile").classList.add("show");
            $("processStatus").textContent = "Ready to separate";
            showToast("File uploaded");
        } catch (err) {
            showAlert(err.message || "Upload failed");
        } finally {
            state.isUploading = false;
            progWrap.classList.remove("show");
            progFill.classList.remove("indeterminate");
            updateActionState();
        }
    }

    async function uploadBatchFiles(files) {
        hideAlert();
        state.isUploading = true;
        updateActionState();

        const queued = [];
        for (const file of files) {
            if (state.batchItems.some((it) => it.origName === file.name && it.status !== "error")) {
                continue;
            }
            const item = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                origName: file.name,
                wavName: "",
                status: "uploading",
                progress: 0,
                stage: "Queued to upload...",
                result: null,
                error: null
            };
            state.batchItems.push(item);
            queued.push({ item, file });
        }
        renderBatchQueue();

        let uploadedCount = 0;
        let cursor = 0;

        async function worker() {
            while (cursor < queued.length) {
                const { item, file } = queued[cursor++];
                item.stage = "Uploading 0%";
                renderBatchQueue();
                try {
                    const res = await sendUploadXhr(file, (pct) => {
                        item.progress = pct;
                        item.stage = pct >= 100 ? "Converting to WAV..." : `Uploading ${pct}%`;
                        renderBatchQueue();
                    });
                    item.wavName = res.data;
                    item.status = "ready";
                    item.progress = 100;
                    item.stage = "Ready";
                    uploadedCount++;
                } catch (err) {
                    item.status = "error";
                    item.stage = "Upload failed";
                    item.error = err.message || "Upload failed";
                }
                renderBatchQueue();
            }
        }

        const workerCount = Math.min(UPLOAD_CONCURRENCY, queued.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        state.isUploading = false;
        updateActionState();
        if (uploadedCount > 0) {
            showToast(`Added ${uploadedCount} file${uploadedCount > 1 ? "s" : ""} to batch`);
        }
    }

    function renderBatchQueue() {
        const container = $("batchQueue");
        if (state.mode !== "batch" || state.batchItems.length === 0) {
            container.classList.remove("show");
            return;
        }
        container.classList.add("show");

        const readyCount = state.batchItems.filter((it) => it.status === "ready").length;
        const doneCount = state.batchItems.filter((it) => it.status === "done").length;
        const parts = [`${state.batchItems.length} file${state.batchItems.length === 1 ? "" : "s"}`];
        if (doneCount > 0) parts.push(`${doneCount} done`);
        else if (readyCount > 0) parts.push(`${readyCount} ready`);
        $("batchQueueSummary").textContent = parts.join(" • ");

        $("batchAddMoreBtn").disabled = state.isUploading || state.isProcessing;
        $("batchClearBtn").disabled = state.isUploading || state.isProcessing;

        $("batchList").innerHTML = state.batchItems.map((it) => {
            const pillClass = it.status === "done" ? "done"
                : it.status === "error" ? "error"
                : (it.status === "running" || it.status === "uploading") ? "running"
                : it.status === "ready" ? "ready" : "";
            const showBar = it.status === "uploading" || it.status === "running" || it.status === "done" || it.status === "error";
            const fillClass = it.status === "done" ? "done" : it.status === "error" ? "error" : "";
            const titleText = it.error ? `${it.origName} — ${it.error}` : it.origName;
            return `
                <div class="batch-row" data-item-id="${it.id}">
                    <div class="batch-row-top">
                        <span class="batch-file-name" title="${escapeHtml(titleText)}">${escapeHtml(it.wavName || it.origName)}</span>
                        <div class="batch-row-right">
                            <span class="batch-pill ${pillClass}">${escapeHtml(it.stage)}</span>
                            ${it.result ? `<button type="button" class="batch-mini-btn play" data-batch-action="load">Open in Mixer</button>` : ""}
                            ${(!state.isProcessing && !state.isUploading) ? `<button type="button" class="batch-mini-btn" data-batch-action="remove" title="Remove">&times;</button>` : ""}
                        </div>
                    </div>
                    ${showBar ? `<div class="batch-mini-bar"><div class="batch-mini-fill ${fillClass}" style="width:${Math.max(0, Math.min(100, it.progress))}%"></div></div>` : ""}
                </div>
            `;
        }).join("");
    }

    $("batchList").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-batch-action]");
        if (!btn) return;
        const row = btn.closest(".batch-row");
        const item = state.batchItems.find((it) => it.id === row.dataset.itemId);
        if (!item) return;

        if (btn.dataset.batchAction === "remove" && !state.isProcessing && !state.isUploading) {
            state.batchItems = state.batchItems.filter((it) => it.id !== item.id);
            renderBatchQueue();
            updateActionState();
        } else if (btn.dataset.batchAction === "load" && item.result) {
            const res = item.result;
            loadTrackIntoMixer({
                name: res.track_name || item.wavName.replace(/\.wav$/i, ""),
                dirname: res.dirname,
                stems: res.stems
            });
            $("mixerCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    });

    // Model Status (async startup preload + first-run download indicator)
    let modelStatusTimer = null;

    async function fetchModelStatuses() {
        try {
            const resp = await fetch("/models/status");
            const res = await resp.json();
            if (res.code !== 0 || !res.models) return;
            state.modelStatuses = res.models;
            renderModelStatuses();
            const anyBusy = Object.values(res.models).some(
                (m) => m.state === "loading" || m.state === "downloading"
            );
            clearTimeout(modelStatusTimer);
            if (anyBusy) {
                modelStatusTimer = setTimeout(fetchModelStatuses, 1000);
            }
        } catch {
            // ignore transient network errors
        }
    }

    function renderModelStatuses() {
        document.querySelectorAll("[data-model-status]").forEach((el) => {
            const key = el.dataset.modelStatus;
            const info = state.modelStatuses[key];
            if (!info) return;
            el.className = `model-status ${info.state}`;
            if (info.state === "loaded") {
                el.textContent = "Ready in memory";
            } else if (info.state === "loading") {
                el.textContent = "Preloading...";
            } else if (info.state === "downloading") {
                el.textContent = info.progress > 0 ? `Downloading ${info.progress}%...` : "Downloading...";
            } else if (info.state === "cached_on_disk") {
                el.textContent = "Downloaded";
            } else {
                el.textContent = "Downloads on first run";
            }
        });
        updateActionState();
    }

    // Model Selection
    document.querySelectorAll(".model-option").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (state.isProcessing) return;
            state.selectedModel = btn.dataset.model;
            document.querySelectorAll(".model-option").forEach((b) => {
                const active = b === btn;
                b.classList.toggle("selected", active);
                b.setAttribute("aria-checked", String(active));
            });
            updateActionState();
        });
    });

    function getRunnableBatchItems() {
        return state.batchItems.filter((it) => it.wavName && (it.status === "ready" || it.status === "done" || it.status === "error"));
    }

    function getSelectedModelHint(baseText) {
        const info = state.modelStatuses[state.selectedModel];
        if (info && info.state === "not_downloaded") {
            return `${baseText} • ${state.selectedModel} will download on first run`;
        }
        return baseText;
    }

    function updateActionState() {
        const btn = $("separateBtn");
        if (state.mode === "batch") {
            const runnable = getRunnableBatchItems();
            btn.disabled = runnable.length === 0 || state.isUploading || state.isProcessing;
            if (!state.isProcessing) {
                $("separateBtnText").textContent = runnable.length > 0
                    ? `Separate ${runnable.length} File${runnable.length === 1 ? "" : "s"}`
                    : "Start Batch Separation";
                if (!state.isUploading) {
                    const base = runnable.length > 0
                        ? `${runnable.length} file${runnable.length === 1 ? "" : "s"} ready`
                        : "Add files to begin batch separation";
                    $("processStatus").textContent = getSelectedModelHint(base);
                }
            }
        } else {
            btn.disabled = !state.uploadedWav || state.isUploading || state.isProcessing;
            if (!state.isProcessing) {
                $("separateBtnText").textContent = "Start Separation";
                if (!state.isUploading) {
                    const base = state.uploadedWav ? "Ready to separate" : "Upload a file to begin";
                    $("processStatus").textContent = getSelectedModelHint(base);
                }
            }
        }
        btn.classList.toggle("loading", state.isProcessing);
    }

    function renderJobProgress({ stage, progress, step, status, elapsedSec }) {
        const pct = Math.max(0, Math.min(100, Math.round(progress)));
        $("jobProgress").classList.add("show");
        $("jobStage").textContent = stage;
        $("jobPct").textContent = `${pct}%`;
        $("jobElapsed").textContent = formatTime(elapsedSec);

        const bar = $("jobBarFill");
        bar.style.width = `${pct}%`;
        bar.classList.toggle("active", status === "queued" || status === "running");
        bar.classList.toggle("done", status === "done");
        bar.classList.toggle("error", status === "error");
        $("jobProgressBar").setAttribute("aria-valuenow", String(pct));

        if (status === "running" && pct >= 14 && pct < 96 && elapsedSec >= 2) {
            const estTotal = elapsedSec / (pct / 100);
            const remaining = Math.max(1, Math.round(estTotal - elapsedSec));
            $("jobEta").textContent = `• ~${formatTime(remaining)} left`;
        } else {
            $("jobEta").textContent = "";
        }

        document.querySelectorAll(".job-step").forEach((el) => {
            const s = Number(el.dataset.step);
            el.classList.toggle("done", status === "done" || s < step);
            el.classList.toggle("active", status !== "done" && status !== "error" && s === step);
        });
    }

    // Separation Request (Single or Batch Async Job with Live Progress)
    $("separateBtn").addEventListener("click", async () => {
        if (state.isProcessing || state.isUploading) return;
        const isBatch = state.mode === "batch";
        const runnableBatch = isBatch ? getRunnableBatchItems() : [];
        if (isBatch && runnableBatch.length === 0) return;
        if (!isBatch && !state.uploadedWav) return;

        hideAlert();
        state.isProcessing = true;
        updateActionState();
        $("separateBtnText").textContent = isBatch
            ? `Separating (${runnableBatch.length} files)...`
            : "Separating...";

        if (isBatch) {
            runnableBatch.forEach((it) => {
                it.status = "queued";
                it.progress = 0;
                it.stage = "Queued";
                it.result = null;
                it.error = null;
            });
            renderBatchQueue();
        }

        const startTs = Date.now();
        let lastJobState = {
            stage: isBatch ? `Starting batch (${runnableBatch.length} files)...` : "Starting separation job...",
            progress: 2,
            step: 1,
            status: "queued"
        };

        const syncDisplay = () => {
            const elapsedSec = Math.floor((Date.now() - startTs) / 1000);
            $("processStatus").textContent = `${lastJobState.stage} (${formatTime(elapsedSec)})`;
            renderJobProgress({ ...lastJobState, elapsedSec });
        };

        syncDisplay();
        const timerId = setInterval(syncDisplay, 500);

        try {
            let createResp;
            if (isBatch) {
                createResp = await fetch("/jobs/batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        wav_names: runnableBatch.map((it) => it.wavName),
                        model: state.selectedModel,
                        quality: state.quality
                    })
                });
            } else {
                const body = new URLSearchParams({
                    wav_name: state.uploadedWav,
                    model: state.selectedModel,
                    quality: state.quality
                });
                createResp = await fetch("/jobs", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body
                });
            }

            const created = await createResp.json();
            if (created.code !== 0) {
                throw new Error(created.msg || "Could not start separation job.");
            }

            const jobId = created.job_id;
            let lastCompletedCount = 0;

            while (true) {
                await new Promise((r) => setTimeout(r, 350));
                const pollResp = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
                const job = await pollResp.json();
                if (job.code !== 0) {
                    throw new Error(job.msg || "Lost connection to job.");
                }

                lastJobState = {
                    stage: job.stage || "Separating...",
                    progress: job.progress ?? lastJobState.progress,
                    step: job.step || lastJobState.step,
                    status: job.status
                };

                if (isBatch && Array.isArray(job.items)) {
                    job.items.forEach((srvItem) => {
                        const localItem = state.batchItems.find((it) => it.wavName === srvItem.wav_name);
                        if (localItem) {
                            localItem.status = srvItem.status;
                            localItem.progress = srvItem.progress;
                            localItem.stage = srvItem.stage;
                            localItem.result = srvItem.result;
                            localItem.error = srvItem.error;
                        }
                    });
                    renderBatchQueue();
                    if ((job.completed_count || 0) > lastCompletedCount) {
                        lastCompletedCount = job.completed_count;
                        fetchLibrary();
                    }
                }

                syncDisplay();

                if (job.status === "error") {
                    throw new Error(job.error || "Separation failed.");
                }
                if (job.status === "done") {
                    const elapsed = Math.floor((Date.now() - startTs) / 1000);
                    if (isBatch) {
                        const ok = job.completed_count || 0;
                        const fail = job.failed_count || 0;
                        const msg = fail > 0
                            ? `Batch finished in ${formatTime(elapsed)}: ${ok} succeeded, ${fail} failed.`
                            : `Batch complete: separated ${ok} file${ok === 1 ? "" : "s"} in ${formatTime(elapsed)}.`;
                        $("processStatus").textContent = msg;
                        showAlert(msg, fail > 0 ? "error" : "success");
                        const firstDone = state.batchItems.find((it) => it.status === "done" && it.result);
                        if (firstDone && !state.isPlaying) {
                            loadTrackIntoMixer({
                                name: firstDone.result.track_name,
                                dirname: firstDone.result.dirname,
                                stems: firstDone.result.stems
                            });
                        }
                        await fetchLibrary();
                    } else {
                        const res = job.result;
                        const stems = res.stems || res.urllist.map((url, i) => ({
                            name: res.data[i],
                            filename: `${res.data[i]}.wav`,
                            url
                        }));
                        const track = {
                            name: res.track_name || state.uploadedWav.replace(/\.wav$/i, ""),
                            dirname: res.dirname,
                            stems
                        };
                        $("processStatus").textContent = `Completed in ${formatTime(elapsed)}`;
                        showAlert(`Separated "${track.name}" into ${stems.length} stems.`, "success");
                        loadTrackIntoMixer(track);
                        await fetchLibrary();
                    }
                    break;
                }
            }
        } catch (err) {
            const elapsedSec = Math.floor((Date.now() - startTs) / 1000);
            lastJobState = {
                stage: err.message || "Separation failed",
                progress: lastJobState.progress,
                step: lastJobState.step,
                status: "error"
            };
            renderJobProgress({ ...lastJobState, elapsedSec });
            showAlert(err.message || "Separation failed.");
            $("processStatus").textContent = "Separation failed";
        } finally {
            clearInterval(timerId);
            state.isProcessing = false;
            updateActionState();
            fetchModelStatuses();
            if (isBatch) renderBatchQueue();
        }
    });

    // Library
    async function fetchLibrary() {
        try {
            const resp = await fetch("/history");
            const res = await resp.json();
            if (res.code === 0) {
                state.tracks = res.tracks || [];
                renderLibrary();
            }
        } catch {
            $("libraryList").innerHTML = '<div class="library-empty">Could not load library.</div>';
        }
    }

    function renderLibrary() {
        const q = $("librarySearch").value.trim().toLowerCase();
        const filtered = q
            ? state.tracks.filter((t) => t.name.toLowerCase().includes(q))
            : state.tracks;

        $("libraryCount").textContent = String(state.tracks.length);

        if (!filtered.length) {
            $("libraryList").innerHTML = `<div class="library-empty">${q ? "No matching tracks" : "No separated tracks yet"}</div>`;
            return;
        }

        const activeName = state.activeTrack?.name;
        $("libraryList").innerHTML = filtered.map((t) => `
            <button type="button" class="library-item ${t.name === activeName ? "active" : ""}" data-track="${escapeHtml(t.name)}">
                <div class="library-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
                <div class="library-meta">
                    <span class="stem-count-pill">${t.stems.length} stems</span>
                    <span>${formatDate(t.mtime)}</span>
                </div>
            </button>
        `).join("");
    }

    $("librarySearch").addEventListener("input", renderLibrary);
    $("libraryList").addEventListener("click", (e) => {
        const item = e.target.closest(".library-item");
        if (!item) return;
        const track = state.tracks.find((t) => t.name === item.dataset.track);
        if (track) {
            loadTrackIntoMixer(track);
            renderLibrary();
        }
    });

    // Synchronized Stem Mixer
    function cleanupAudio() {
        cancelAnimationFrame(state.rafId);
        state.isPlaying = false;
        state.stems.forEach((s) => {
            s.audio.pause();
            s.audio.removeAttribute("src");
            s.audio.load();
        });
        state.stems = [];
        state.duration = 0;
        updatePlayIcon();
    }

    function sortStems(stems) {
        return [...stems].sort((a, b) => {
            const ia = STEM_ORDER.indexOf(a.name.toLowerCase());
            const ib = STEM_ORDER.indexOf(b.name.toLowerCase());
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
    }

    function loadTrackIntoMixer(track) {
        cleanupAudio();
        state.activeTrack = track;

        const sorted = sortStems(track.stems);
        state.stems = sorted.map((s) => {
            const audio = new Audio();
            audio.preload = "auto";
            audio.src = s.url;
            audio.addEventListener("loadedmetadata", () => {
                if (Number.isFinite(audio.duration) && audio.duration > state.duration) {
                    state.duration = audio.duration;
                    $("seekBar").max = String(state.duration);
                    $("totalTime").textContent = formatTime(state.duration);
                }
            });
            return {
                ...s,
                audio,
                volume: 1,
                muted: false,
                solo: false
            };
        });

        if (state.stems[0]) {
            state.stems[0].audio.addEventListener("ended", () => {
                if (state.loop) {
                    seekAll(0);
                    playAll();
                } else {
                    pauseAll();
                    seekAll(0);
                }
            });
        }

        $("mixerEmpty").style.display = "none";
        $("mixerActive").classList.add("show");
        $("presetBar").classList.add("show");
        $("mixerTrackTitle").textContent = track.name;
        $("mixerTrackPath").textContent = track.dirname || "";
        $("mixerTrackPath").title = track.dirname || "";
        $("seekBar").value = "0";
        $("seekBar").max = "100";
        $("currentTime").textContent = "0:00";
        $("totalTime").textContent = "0:00";

        const hasVocals = state.stems.some((s) => s.name.toLowerCase() === "vocals");
        document.querySelector('[data-preset="karaoke"]').style.display = hasVocals ? "" : "none";
        document.querySelector('[data-preset="vocals"]').style.display = hasVocals ? "" : "none";

        renderStems();
        applyMixVolumes();
        renderLibrary();
        loadLyricsForTrack(track.name);
    }

    function renderStems() {
        const list = $("stemsList");
        list.innerHTML = state.stems.map((s, idx) => {
            const color = STEM_COLORS[s.name.toLowerCase()] || "#6366f1";
            return `
                <div class="stem-row" data-idx="${idx}" style="--stem-color: ${color}">
                    <div class="stem-label">
                        <span class="stem-swatch"></span>
                        <span class="stem-name-text" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
                    </div>
                    <div class="ms-group">
                        <button type="button" class="ms-btn mute" data-action="mute" title="Mute ${escapeHtml(s.name)}">M</button>
                        <button type="button" class="ms-btn solo" data-action="solo" title="Solo ${escapeHtml(s.name)} (${idx + 1})">S</button>
                    </div>
                    <input type="range" class="stem-vol" min="0" max="100" value="${Math.round(s.volume * 100)}" aria-label="${escapeHtml(s.name)} volume">
                    <span class="vol-pct">${Math.round(s.volume * 100)}%</span>
                    <a class="dl-btn" href="${s.url}" download="${escapeHtml(state.activeTrack.name + "_" + s.filename)}" title="Download ${escapeHtml(s.filename)}" aria-label="Download ${escapeHtml(s.name)}">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </a>
                </div>
            `;
        }).join("");
    }

    function applyMixVolumes() {
        const anySolo = state.stems.some((s) => s.solo);
        const rows = $("stemsList").querySelectorAll(".stem-row");

        state.stems.forEach((s, idx) => {
            const audible = !s.muted && (!anySolo || s.solo);
            s.audio.volume = audible ? Math.max(0, Math.min(1, s.volume * state.masterVolume)) : 0;
            const row = rows[idx];
            if (row) {
                row.classList.toggle("silenced", !audible);
                row.querySelector('[data-action="mute"]').classList.toggle("active", s.muted);
                row.querySelector('[data-action="solo"]').classList.toggle("active", s.solo);
                row.querySelector(".stem-vol").value = String(Math.round(s.volume * 100));
                row.querySelector(".vol-pct").textContent = `${Math.round(s.volume * 100)}%`;
            }
        });

        updatePresetHighlight();
    }

    function updatePresetHighlight() {
        const allBtn = document.querySelector('[data-preset="all"]');
        const karaokeBtn = document.querySelector('[data-preset="karaoke"]');
        const vocalsBtn = document.querySelector('[data-preset="vocals"]');
        if (!state.stems.length) return;

        const noneMutedOrSolo = state.stems.every((s) => !s.muted && !s.solo);
        const isKaraoke = state.stems.every((s) =>
            s.name.toLowerCase() === "vocals" ? (s.muted && !s.solo) : (!s.muted && !s.solo)
        );
        const isVocalsOnly = state.stems.every((s) =>
            s.name.toLowerCase() === "vocals" ? (!s.muted && s.solo) : (!s.solo)
        );

        allBtn.classList.toggle("active", noneMutedOrSolo);
        karaokeBtn.classList.toggle("active", isKaraoke);
        vocalsBtn.classList.toggle("active", isVocalsOnly);
    }

    $("stemsList").addEventListener("click", (e) => {
        const btn = e.target.closest(".ms-btn");
        if (!btn) return;
        const idx = Number(btn.closest(".stem-row").dataset.idx);
        const stem = state.stems[idx];
        if (!stem) return;
        if (btn.dataset.action === "mute") {
            stem.muted = !stem.muted;
        } else if (btn.dataset.action === "solo") {
            stem.solo = !stem.solo;
            if (stem.solo) stem.muted = false;
        }
        applyMixVolumes();
    });

    $("stemsList").addEventListener("input", (e) => {
        if (!e.target.classList.contains("stem-vol")) return;
        const idx = Number(e.target.closest(".stem-row").dataset.idx);
        const stem = state.stems[idx];
        if (!stem) return;
        stem.volume = Number(e.target.value) / 100;
        applyMixVolumes();
    });

    // Presets
    $("presetBar").addEventListener("click", (e) => {
        const btn = e.target.closest(".chip-btn");
        if (!btn || !state.stems.length) return;
        const preset = btn.dataset.preset;
        state.stems.forEach((s) => {
            const isVocals = s.name.toLowerCase() === "vocals";
            if (preset === "all") {
                s.muted = false;
                s.solo = false;
            } else if (preset === "karaoke") {
                s.solo = false;
                s.muted = isVocals;
            } else if (preset === "vocals") {
                s.muted = false;
                s.solo = isVocals;
            }
        });
        applyMixVolumes();
    });

    $("copyPathBtn").addEventListener("click", async () => {
        const path = state.activeTrack?.dirname;
        if (!path) return;
        try {
            await navigator.clipboard.writeText(path);
            showToast("Output path copied");
        } catch {
            showToast(path);
        }
    });

    // Transport Controls
    function updatePlayIcon() {
        $("playIcon").innerHTML = state.isPlaying
            ? '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'
            : '<polygon points="6 4 20 12 6 20 6 4"/>';
    }

    function getMasterTime() {
        return state.stems[0]?.audio.currentTime || 0;
    }

    function seekAll(time) {
        const clamped = Math.max(0, Math.min(state.duration || 0, time));
        state.stems.forEach((s) => {
            if (Number.isFinite(s.audio.duration)) {
                s.audio.currentTime = Math.min(clamped, s.audio.duration);
            } else {
                s.audio.currentTime = clamped;
            }
        });
        $("seekBar").value = String(clamped);
        $("currentTime").textContent = formatTime(clamped);
        updateSyncedLyricsHighlight(clamped, true);
    }

    async function playAll() {
        if (!state.stems.length) return;
        const t = getMasterTime();
        state.stems.forEach((s) => {
            if (Math.abs(s.audio.currentTime - t) > 0.04) {
                s.audio.currentTime = t;
            }
        });
        try {
            await Promise.all(state.stems.map((s) => s.audio.play()));
            state.isPlaying = true;
            updatePlayIcon();
            tickPlayback();
        } catch {
            pauseAll();
        }
    }

    function pauseAll() {
        state.stems.forEach((s) => s.audio.pause());
        state.isPlaying = false;
        cancelAnimationFrame(state.rafId);
        updatePlayIcon();
    }

    function tickPlayback(now = performance.now()) {
        if (!state.isPlaying || !state.stems.length) return;
        const refTime = getMasterTime();

        if (!state.isSeeking) {
            $("seekBar").value = String(refTime);
            $("currentTime").textContent = formatTime(refTime);
        }
        updateSyncedLyricsHighlight(refTime, false);

        if (now - state.lastSyncCheck > 500) {
            state.lastSyncCheck = now;
            for (let i = 1; i < state.stems.length; i++) {
                const a = state.stems[i].audio;
                if (!a.paused && Math.abs(a.currentTime - refTime) > 0.08) {
                    a.currentTime = refTime;
                }
            }
        }
        state.rafId = requestAnimationFrame(tickPlayback);
    }

    $("playPauseBtn").addEventListener("click", () => {
        if (state.isPlaying) pauseAll();
        else playAll();
    });
    $("restartBtn").addEventListener("click", () => seekAll(0));
    $("backBtn").addEventListener("click", () => seekAll(getMasterTime() - 5));
    $("fwdBtn").addEventListener("click", () => seekAll(getMasterTime() + 5));
    $("loopBtn").addEventListener("click", () => {
        state.loop = !state.loop;
        $("loopBtn").classList.toggle("active", state.loop);
    });
    $("masterVolume").addEventListener("input", (e) => {
        state.masterVolume = Number(e.target.value) / 100;
        applyMixVolumes();
    });

    const seekBar = $("seekBar");
    seekBar.addEventListener("pointerdown", () => { state.isSeeking = true; });
    seekBar.addEventListener("input", () => {
        $("currentTime").textContent = formatTime(Number(seekBar.value));
    });
    seekBar.addEventListener("change", () => {
        seekAll(Number(seekBar.value));
        state.isSeeking = false;
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (!state.stems.length) return;

        if (e.code === "Space") {
            e.preventDefault();
            if (state.isPlaying) pauseAll();
            else playAll();
        } else if (e.code === "ArrowLeft") {
            e.preventDefault();
            seekAll(getMasterTime() - 5);
        } else if (e.code === "ArrowRight") {
            e.preventDefault();
            seekAll(getMasterTime() + 5);
        } else if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            seekAll(0);
        } else if (e.key >= "1" && e.key <= "6") {
            const idx = Number(e.key) - 1;
            if (state.stems[idx]) {
                state.stems[idx].solo = !state.stems[idx].solo;
                if (state.stems[idx].solo) state.stems[idx].muted = false;
                applyMixVolumes();
            }
        }
    });

    // Synced Lyrics Engine (LRCLIB + Local Track Cache)
    function parseLrc(lrcText) {
        if (!lrcText) return [];
        const lines = [];
        const timeTagRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
        for (const rawLine of lrcText.split(/\r?\n/)) {
            const times = [];
            let match;
            timeTagRe.lastIndex = 0;
            while ((match = timeTagRe.exec(rawLine)) !== null) {
                const min = Number(match[1]);
                const sec = Number(match[2]);
                const fracRaw = match[3] || "0";
                const frac = Number(fracRaw) / Math.pow(10, fracRaw.length);
                times.push(min * 60 + sec + frac);
            }
            if (!times.length) continue;
            const text = rawLine.replace(timeTagRe, "").trim();
            if (!text) continue;
            for (const t of times) {
                lines.push({ time: t, text });
            }
        }
        lines.sort((a, b) => a.time - b.time);
        return lines;
    }

    function applyLyricsRecord(record) {
        state.lyrics = record || null;
        state.lyricsOffset = Number(record?.offset || 0);
        state.lyricsActiveIdx = -1;
        state.lyricsLines = record?.syncedLyrics ? parseLrc(record.syncedLyrics) : [];

        const hasSynced = state.lyricsLines.length > 0;
        const hasPlain = Boolean(record?.plainLyrics);
        const badge = $("lyricsBadge");

        if (record && (hasSynced || hasPlain)) {
            const label = [record.trackName, record.artistName].filter(Boolean).join(" — ");
            $("lyricsMeta").textContent = label;
            $("lyricsMeta").title = label;
            badge.style.display = "";
            badge.className = `lyrics-badge ${hasSynced ? "" : "plain"}`;
            const modeLabel = hasSynced ? "Synced" : "Plain";
            badge.textContent = record.source ? `${modeLabel} • ${record.source}` : modeLabel;
            $("lyricsOffsetCtrl").style.display = hasSynced ? "inline-flex" : "none";
            $("lyricsOffsetVal").textContent = `${state.lyricsOffset >= 0 ? "+" : ""}${state.lyricsOffset.toFixed(1)}s`;
            $("lyricsCopyBtn").style.display = "";
            $("lyricsDownloadBtn").style.display = "";
            $("lyricsDownloadBtn").textContent = hasSynced ? "Save .lrc" : "Save .txt";
        } else {
            $("lyricsMeta").textContent = "";
            badge.style.display = "none";
            $("lyricsOffsetCtrl").style.display = "none";
            $("lyricsCopyBtn").style.display = "none";
            $("lyricsDownloadBtn").style.display = "none";
        }

        const vp = $("lyricsViewport");
        if (hasSynced) {
            vp.innerHTML = state.lyricsLines.map((line, idx) => `
                <button type="button" class="lyric-line" data-lyric-idx="${idx}" data-lyric-time="${line.time}">
                    <span class="lyric-line-time">${formatTime(line.time)}</span>${escapeHtml(line.text)}
                </button>
            `).join("");
            updateSyncedLyricsHighlight(getMasterTime(), true);
        } else if (hasPlain) {
            vp.innerHTML = `<div class="lyrics-plain">${escapeHtml(record.plainLyrics)}</div>`;
        } else {
            vp.innerHTML = '<div class="lyrics-placeholder">No lyrics matched by filename.<br>Use <strong>Audio Fingerprint</strong>, <strong>Local Whisper</strong>, or <strong>Title Match</strong> above.</div>';
        }
    }

    function updateSyncedLyricsHighlight(currentTime, forceScroll) {
        if (!state.lyricsLines.length) return;
        const t = currentTime + state.lyricsOffset;
        let idx = -1;
        for (let i = 0; i < state.lyricsLines.length; i++) {
            if (state.lyricsLines[i].time <= t + 0.05) idx = i;
            else break;
        }
        if (idx === state.lyricsActiveIdx && !forceScroll) return;
        state.lyricsActiveIdx = idx;

        const vp = $("lyricsViewport");
        const nodes = vp.querySelectorAll(".lyric-line");
        nodes.forEach((node, i) => {
            node.classList.toggle("active", i === idx);
            node.classList.toggle("past", idx >= 0 && i < idx);
        });
        if (idx >= 0 && nodes[idx]) {
            const targetTop = nodes[idx].offsetTop - vp.offsetTop - vp.clientHeight / 2 + nodes[idx].clientHeight / 2;
            vp.scrollTo({ top: Math.max(0, targetTop), behavior: forceScroll ? "auto" : "smooth" });
        }
    }

    function renderLyricsCandidates() {
        const box = $("lyricsCandidates");
        if (!state.lyricsCandidates.length) {
            box.innerHTML = "";
            return;
        }
        const activeId = state.lyrics?.id;
        box.innerHTML = state.lyricsCandidates.slice(0, 10).map((c, idx) => `
            <button type="button" class="lyrics-candidate ${activeId && c.id === activeId ? "selected" : ""}" data-cand-idx="${idx}">
                <span class="lyrics-cand-main">
                    <strong>${escapeHtml(c.trackName || "Untitled")}</strong>
                    ${c.artistName ? `<span class="lyrics-cand-artist"> — ${escapeHtml(c.artistName)}</span>` : ""}
                </span>
                <span class="lyrics-cand-right">
                    <span>${c.duration ? formatTime(c.duration) : ""}</span>
                    <span class="lyrics-badge ${c.syncedLyrics ? "" : "plain"}">${c.syncedLyrics ? "Synced" : "Plain"}</span>
                </span>
            </button>
        `).join("");
    }

    async function persistLyrics(trackName, record) {
        if (!trackName || !record) return;
        try {
            await fetch("/lyrics/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ track: trackName, lyrics: record })
            });
        } catch {
            // non-fatal
        }
    }

    async function searchLyricsOnline(query, duration, autoPick = false, token = state.lyricsReqToken) {
        const q = (query || "").trim();
        if (!q) return;
        if (!autoPick) {
            $("lyricsCandidates").innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 2px">Searching LRCLIB...</div>';
        }
        try {
            const params = new URLSearchParams({ q });
            if (duration) params.set("duration", String(duration));
            const resp = await fetch(`/lyrics/search?${params.toString()}`);
            const res = await resp.json();
            if (token !== state.lyricsReqToken) return;

            if (res.code !== 0) {
                state.lyricsCandidates = [];
                $("lyricsCandidates").innerHTML = `<div style="font-size:12px;color:var(--danger);padding:6px 2px">${escapeHtml(res.msg || "Search failed")}</div>`;
                if (autoPick) applyLyricsRecord(null);
                return;
            }
            state.lyricsCandidates = res.results || [];
            if (autoPick) {
                if (state.lyricsCandidates.length > 0) {
                    const best = { ...state.lyricsCandidates[0], offset: 0 };
                    applyLyricsRecord(best);
                    persistLyrics(state.activeTrack?.name, best);
                } else {
                    applyLyricsRecord(null);
                    $("lyricsSearchBox").classList.add("show");
                }
            }
            renderLyricsCandidates();
            if (!autoPick && !state.lyricsCandidates.length) {
                $("lyricsCandidates").innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 2px">No matches found. Try adding or removing the artist name.</div>';
            }
        } catch {
            if (token !== state.lyricsReqToken) return;
            if (autoPick) {
                $("lyricsViewport").innerHTML = '<div class="lyrics-placeholder">Could not reach LRCLIB right now.</div>';
            }
        }
    }

    function setLyricsBusy(show, stage = "", pct = null) {
        const bar = $("lyricsBusyBar");
        bar.classList.toggle("show", show);
        if (show) {
            $("lyricsBusyStage").textContent = stage;
            $("lyricsBusyPct").textContent = pct !== null ? `${Math.round(pct)}%` : "";
            const fill = $("lyricsBusyFill");
            fill.style.width = pct !== null ? `${Math.max(5, Math.min(100, pct))}%` : "45%";
            fill.classList.remove("done", "error");
        }
        $("lyricsFingerprintBtn").disabled = show;
        $("lyricsWhisperBtn").disabled = show;
        $("whisperModelSelect").disabled = show;
        $("whisperLangSelect").disabled = show;
    }

    async function loadLyricsForTrack(trackName) {
        const token = ++state.lyricsReqToken;
        state.lyrics = null;
        state.lyricsLines = [];
        state.lyricsCandidates = [];
        state.lyricsActiveIdx = -1;
        setLyricsBusy(false);
        $("lyricsCandidates").innerHTML = "";
        $("lyricsSearchBox").classList.remove("show");
        $("lyricsMeta").textContent = "";
        $("lyricsBadge").style.display = "none";
        $("lyricsOffsetCtrl").style.display = "none";
        $("lyricsCopyBtn").style.display = "none";
        $("lyricsDownloadBtn").style.display = "none";
        $("lyricsViewport").innerHTML = '<div class="lyrics-placeholder">Searching for synced lyrics...</div>';

        try {
            const resp = await fetch(`/lyrics?track=${encodeURIComponent(trackName)}`);
            const res = await resp.json();
            if (token !== state.lyricsReqToken) return;
            const suggested = res.suggested_query || trackName;
            $("lyricsQueryInput").value = suggested;
            if (res.cached && res.lyrics) {
                applyLyricsRecord(res.lyrics);
                return;
            }
            await searchLyricsOnline(suggested, res.duration || state.duration || null, true, token);
        } catch {
            if (token !== state.lyricsReqToken) return;
            applyLyricsRecord(null);
        }
    }

    // Audio Fingerprinting (Shazam -> LRCLIB)
    $("lyricsFingerprintBtn").addEventListener("click", async () => {
        const trackName = state.activeTrack?.name;
        if (!trackName) return;
        const token = ++state.lyricsReqToken;
        setLyricsBusy(true, "Fingerprinting audio via Shazam...", 35);
        try {
            const resp = await fetch("/lyrics/fingerprint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ track: trackName })
            });
            const res = await resp.json();
            if (token !== state.lyricsReqToken) return;

            if (res.code !== 0) {
                showToast(res.msg || "Could not identify song");
                $("lyricsCandidates").innerHTML = `<div style="font-size:12px;color:var(--danger);padding:6px 2px">${escapeHtml(res.msg || "Fingerprint failed")}</div>`;
                $("lyricsSearchBox").classList.add("show");
                return;
            }

            if (res.query) $("lyricsQueryInput").value = res.query;
            state.lyricsCandidates = res.results || [];
            const idLabel = [res.identified?.title, res.identified?.artist].filter(Boolean).join(" — ");

            if (state.lyricsCandidates.length > 0) {
                const best = { ...state.lyricsCandidates[0], offset: 0 };
                applyLyricsRecord(best);
                persistLyrics(trackName, best);
                renderLyricsCandidates();
                showToast(`Identified: ${idLabel}`);
            } else {
                renderLyricsCandidates();
                $("lyricsSearchBox").classList.add("show");
                showToast(`Identified "${idLabel}", but no lyrics found on LRCLIB — try Local Whisper`);
            }
        } catch (err) {
            if (token === state.lyricsReqToken) {
                showToast(`Fingerprint error: ${err.message}`);
            }
        } finally {
            if (token === state.lyricsReqToken) setLyricsBusy(false);
        }
    });

    // Local Whisper Transcription on vocals.wav
    $("lyricsWhisperBtn").addEventListener("click", async () => {
        const trackName = state.activeTrack?.name;
        if (!trackName) return;
        const token = ++state.lyricsReqToken;
        const model = $("whisperModelSelect").value;
        const language = $("whisperLangSelect").value;

        setLyricsBusy(true, `Starting Whisper (${model})...`, 5);
        try {
            const createResp = await fetch("/lyrics/whisper", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ track: trackName, model, language })
            });
            const created = await createResp.json();
            if (token !== state.lyricsReqToken) return;
            if (created.code !== 0) {
                throw new Error(created.msg || "Could not start Whisper transcription.");
            }

            const jobId = created.job_id;
            while (true) {
                await new Promise((r) => setTimeout(r, 400));
                if (token !== state.lyricsReqToken) return;
                const pollResp = await fetch(`/jobs/${encodeURIComponent(jobId)}`);
                const job = await pollResp.json();
                if (token !== state.lyricsReqToken) return;
                if (job.code !== 0) {
                    throw new Error(job.msg || "Lost Whisper job status.");
                }
                setLyricsBusy(true, `${job.stage} (${formatTime(job.elapsed || 0)})`, job.progress ?? 30);

                if (job.status === "error") {
                    throw new Error(job.error || "Whisper transcription failed.");
                }
                if (job.status === "done") {
                    applyLyricsRecord(job.result);
                    $("lyricsSearchBox").classList.remove("show");
                    showToast(`Transcribed with Whisper (${model})`);
                    break;
                }
            }
        } catch (err) {
            if (token === state.lyricsReqToken) {
                showAlert(err.message || "Whisper transcription failed.");
            }
        } finally {
            if (token === state.lyricsReqToken) setLyricsBusy(false);
        }
    });

    $("lyricsViewport").addEventListener("click", (e) => {
        const lineBtn = e.target.closest(".lyric-line");
        if (!lineBtn) return;
        const targetTime = Math.max(0, Number(lineBtn.dataset.lyricTime) - state.lyricsOffset);
        seekAll(targetTime);
        if (!state.isPlaying) playAll();
    });

    $("lyricsSearchToggleBtn").addEventListener("click", () => {
        const box = $("lyricsSearchBox");
        const opening = !box.classList.contains("show");
        box.classList.toggle("show", opening);
        if (opening) {
            $("lyricsQueryInput").focus();
            $("lyricsQueryInput").select();
            if (state.lyricsCandidates.length) renderLyricsCandidates();
        }
    });

    $("lyricsSearchForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const q = $("lyricsQueryInput").value.trim();
        if (q) searchLyricsOnline(q, state.duration || null, false, state.lyricsReqToken);
    });

    $("lyricsCandidates").addEventListener("click", (e) => {
        const btn = e.target.closest(".lyrics-candidate");
        if (!btn) return;
        const cand = state.lyricsCandidates[Number(btn.dataset.candIdx)];
        if (!cand) return;
        const chosen = { ...cand, offset: 0 };
        applyLyricsRecord(chosen);
        renderLyricsCandidates();
        persistLyrics(state.activeTrack?.name, chosen);
        $("lyricsSearchBox").classList.remove("show");
        showToast("Lyrics updated & saved");
    });

    function nudgeLyricsOffset(delta) {
        if (!state.lyrics) return;
        state.lyricsOffset = Math.round((state.lyricsOffset + delta) * 10) / 10;
        state.lyrics.offset = state.lyricsOffset;
        $("lyricsOffsetVal").textContent = `${state.lyricsOffset >= 0 ? "+" : ""}${state.lyricsOffset.toFixed(1)}s`;
        updateSyncedLyricsHighlight(getMasterTime(), true);
        persistLyrics(state.activeTrack?.name, state.lyrics);
    }

    $("offsetMinusBtn").addEventListener("click", () => nudgeLyricsOffset(-0.5));
    $("offsetPlusBtn").addEventListener("click", () => nudgeLyricsOffset(0.5));

    $("lyricsCopyBtn").addEventListener("click", async () => {
        const text = state.lyrics?.plainLyrics || state.lyrics?.syncedLyrics;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            showToast("Lyrics copied");
        } catch {
            showToast("Could not copy lyrics");
        }
    });

    $("lyricsDownloadBtn").addEventListener("click", () => {
        if (!state.lyrics || !state.activeTrack) return;
        const isSynced = Boolean(state.lyrics.syncedLyrics);
        const content = isSynced ? state.lyrics.syncedLyrics : (state.lyrics.plainLyrics || "");
        const ext = isSynced ? "lrc" : "txt";
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${state.activeTrack.name}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    fetchLibrary();
    fetchModelStatuses();
})();
