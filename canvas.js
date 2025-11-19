
//a helper to grab the elements
const $ = (s) => document.querySelector(s);

// DOM refs
const video      = $("#video"); // preview element
const fileVideo  = $("#video-file"); //file input for the video

//Watermark mode + option panles
const textRadio  = $("#wm-text-type"); //text option
const imgRadio   = $("#wm-image-type"); //image option
const textPanel  = document.querySelector('[data-panel="text"]') || null; //UI for the text option
const imgPanel   = document.querySelector('[data-panel="image"]') || null;//UI for the image option 

//Live overlay in the player
const wmTextOverlay = $("#wm-overlay-text"); // showing the text in the preview
const wmImgOverlay  = $("#wm-overlay-img");  // showing the image in the preview
const overlayBox    = $("#wm-overlay");//overlay container(positions)

//text watermark controls
const textInput   = $("#wm-text");//input for the text
const fontSel     = $("#wm-font");//select the font
const weightSel   = $("#wm-weight");//select the weight
const sizeInput   = $("#wm-size");//size
const colorInput  = $("#wm-color");//color
const outlineSel  = $("#wm-outline");//outline
const opacityRng  = $("#wm-opacity");//opacity
const rotationInp = $("#wm-rotation");//rotation
const paddingInp  = $("#wm-padding");//padding
const tileChk     = $("#wm-tile");//tile checkbox

//common controls
const imgFile     = $("#wm-image");//input file for the image
const scaleInp    = $("#wm-img-scale");//image scale
const posRadios   = Array.from(document.querySelectorAll('input[name="wm-pos"]'));//3x3 grid

//export controls
const exportBtn   = $("#btn-export");//start export
const fpsInput    = $("#export-fps");//number of the fps

//Canvas
const canvas = document.getElementById("render-canvas");//hidden canvas used to burn watermark
const ctx = canvas.getContext("2d", { alpha: false });// 2D context; alpha:false = opaque for efficiency

//State
let rafId = null; // requestAnimationFrame id for canceling the render loop
let rendering = false;//rendering frames to the canvas
let wmImgBitmap = null; // decoded image for canvas drawing
let imgNaturalW = 0, imgNaturalH = 0;   // for live preview scaling
let lastPos = "middle-center";
let mediaRecorder = null;//for recording the canvas stream
let chunks = [];//already recordeddata chunks
let autoStopTimer = null;//safety timer to stop 

//Config and utils
const SAFE_PCT = 0.06; // safe-inset
const safe  = (v, fb) => (v ?? fb);//helper which returns v unless v is null or undefined
const px    = (n) => `${n}px`;//it turns n in npx
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));//n between min and max


//chose a compatible mediaRecorder MIME type
function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

//UI (preview)
//hideing the image options when text is selected and vice-versa
function syncPanels() {
  const isText = textRadio?.checked ?? true;
  if (textPanel && imgPanel) {
    textPanel.hidden = !isText;
    imgPanel.hidden  =  isText;
  }
  if (wmTextOverlay && wmImgOverlay) {
    wmTextOverlay.hidden = !isText;
    wmImgOverlay.hidden  =  isText;
  }
}
[textRadio, imgRadio].filter(Boolean).forEach(el => el.addEventListener("change", syncPanels));
syncPanels();

//live preview for the text watermarks
textInput?.addEventListener("input", () => {
  if (wmTextOverlay) wmTextOverlay.textContent = textInput.value || "© YourName";
});
fontSel?.addEventListener("change", () => {
  if (wmTextOverlay) wmTextOverlay.style.fontFamily = `${fontSel.value}, Arial, sans-serif`;
});
weightSel?.addEventListener("change", () => {
  if (wmTextOverlay) wmTextOverlay.style.fontWeight = weightSel.value;
});
sizeInput?.addEventListener("input", () => {
  if (wmTextOverlay) wmTextOverlay.style.fontSize = px(parseInt(sizeInput.value || "24", 10));
});
colorInput?.addEventListener("input", () => {
  if (wmTextOverlay) wmTextOverlay.style.color = colorInput.value;
});

//outline toggleing in preview
outlineSel?.addEventListener("change", () => {
  if (!wmTextOverlay) return;
  wmTextOverlay.classList.remove("outline-light","outline-dark");
  if (outlineSel.value === "light") wmTextOverlay.classList.add("outline-light");
  if (outlineSel.value === "dark")  wmTextOverlay.classList.add("outline-dark");
});

//opacity live in preview
opacityRng?.addEventListener("input", () => {
  const o = (parseInt(opacityRng.value || "60", 10)) / 100;
  if (wmTextOverlay) wmTextOverlay.style.opacity = o;
  if (wmImgOverlay)  wmImgOverlay.style.opacity  = o;
});

/* Compose transforms so image preview supports both rotate + scale */
function applyPreviewTransforms() {
  const deg = `${rotationInp?.value || 0}deg`;

  // text: rotate only
  if (wmTextOverlay) wmTextOverlay.style.transform = `rotate(${deg})`;

  // image: rotate + scale
  if (wmImgOverlay) {
    const s = clamp(parseFloat(scaleInp?.value || "30") / 100, 0.05, 4);
    wmImgOverlay.style.transform = `rotate(${deg}) scale(${s})`;
  }
}
rotationInp?.addEventListener("input", applyPreviewTransforms);
scaleInp?.addEventListener("input", applyPreviewTransforms);

//padding in live
paddingInp?.addEventListener("input", () => {
  if (overlayBox) overlayBox.style.padding = px(parseInt(paddingInp.value || "16", 10));
});

//tile checkbox in live
tileChk?.addEventListener("change", () => {
  if (overlayBox) overlayBox.classList.toggle("tile", tileChk.checked);
});


//updating the position based on the the 3x3 selection
posRadios.forEach(r => r.addEventListener("change", () => {
  lastPos = r.value;
  const map = {
    "top-left":"start start","top-center":"start center","top-right":"start end",
    "middle-left":"center start","middle-center":"center center","middle-right":"center end",
    "bottom-left":"end start","bottom-center":"end center","bottom-right":"end end"
  };
  if (overlayBox) overlayBox.style.placeItems = map[lastPos] || "center center";
}));
const checkedPos = document.querySelector('input[name="wm-pos"]:checked');
if (checkedPos) lastPos = checkedPos.value;

//Watermark image loader
//loader
imgFile?.addEventListener("change", async () => {
  const f = imgFile.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);

  //live change of the image
  if (wmImgOverlay) {
    wmImgOverlay.onload = () => {
      //natural size 
      imgNaturalW = wmImgOverlay.naturalWidth || wmImgOverlay.width || 0;
      imgNaturalH = wmImgOverlay.naturalHeight || wmImgOverlay.height || 0;
      applyPreviewTransforms(); // current roatation and scale values
    };
    wmImgOverlay.src = url;
  }

  //decodes the image into a bitmap for faster export
  try {
    wmImgBitmap = await createImageBitmap(f);
  } catch (e) {
    console.error("Watermark image decode failed:", e);
    wmImgBitmap = null;
  }
});

//Video loader
fileVideo?.addEventListener("change", () => {
  const f = fileVideo.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  video.src = url;
  video.load();//forces the browser to parse the metadata
});

video?.addEventListener("loadedmetadata", () => {
  exportBtn.disabled = false;//allow the export with the width and the height
});
video?.addEventListener("error", () => {
  console.error('Video error:', video.error);
  alert('This file cannot be decoded by the browser. Please use MP4 or WebM.');
});

//Canvas helpers

//the canvas should be the ame size as the source vid
function fitCanvas() {
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
}

//the anchor for the safe rectangle
function anchor(w, h, pad) {
  const safeX = Math.round(w * SAFE_PCT);
  const safeY = Math.round(h * SAFE_PCT);

  const left   = safeX + pad;
  const right  = w - safeX - pad;
  const top    = safeY + pad;
  const bottom = h - safeY - pad;

  //center of the safe rectengale
  const cx = Math.round((left + right) / 2);
  const cy = Math.round((top + bottom) / 2);

  const xs = [left, cx, right];
  const ys = [top,  cy, bottom];

  //convert the position names to indices
  const idx = {
    "top-left":[0,0],"top-center":[1,0],"top-right":[2,0],
    "middle-left":[0,1],"middle-center":[1,1],"middle-right":[2,1],
    "bottom-left":[0,2],"bottom-center":[1,2],"bottom-right":[2,2]
  }[lastPos] || [1,1];

  return { x: xs[idx[0]], y: ys[idx[1]] };
}

//put the tezt in the canvas whit at the x and y with the rotation and opacity
function drawText(ctx, x, y, angleDeg, opacity) {
  const size   = parseInt(safe(sizeInput?.value, "24"), 10);
  const weight = safe(weightSel?.value, "600");
  const fam    = safe(fontSel?.value, "Inter");
  let   text   = safe(textInput?.value, "© YourName");
  if (!text || !text.trim()) text = "© YourName"; //initial hint
  const color  = safe(colorInput?.value, "#ffffff");

  ctx.save();//saves the drawing
  ctx.globalAlpha = opacity;//setting the opacity
  ctx.globalCompositeOperation = 'source-over';//default; new pixels are drawn on top
  ctx.translate(x, y);//moves the canvas to the origin
  ctx.rotate((angleDeg * Math.PI) / 180);//rotates the drawing
  ctx.font = `${weight} ${size}px ${fam}, Arial, sans-serif`;//sets the font
  ctx.fillStyle = color;//sets the color

  //soft outline
  const o = safe(outlineSel?.value, "none");
  if (o === "light") { ctx.shadowColor = "rgba(255,255,255,.9)"; ctx.shadowBlur = 8; }
  else if (o === "dark"){ ctx.shadowColor = "rgba(0,0,0,.9)";   ctx.shadowBlur = 10; }
  else { ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 6; }


  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

//draw the image in the canvas at x and y with rotation and opacity
function drawImage(ctx, x, y, angleDeg, opacity) {
  if (!wmImgBitmap) return;
  const scalePct = parseFloat(safe(scaleInp?.value, "30"));
  const scale = Math.max(0.05, scalePct / 100);//minimmum 0.05 to avoid the invisible images
  const w = wmImgBitmap.width * scale;
  const h = wmImgBitmap.height * scale;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = 'source-over';
  ctx.translate(x, y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(wmImgBitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
}

//draw many copies
function drawTiled(ctx, painter, angle, opacity) {
  // keep tiles inside safe rect as well
  const safeX = Math.round(canvas.width  * SAFE_PCT);
  const safeY = Math.round(canvas.height * SAFE_PCT);
  const pad = parseInt(safe(paddingInp?.value, "16"), 10);

  const left   = safeX + pad;
  const right  = canvas.width - safeX - pad;
  const top    = safeY + pad;
  const bottom = canvas.height - safeY - pad;

  //spacing between them
  const step = 220;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      painter(ctx, x, y, angle, opacity);
    }
  }
}

//Render loop while exporting
function renderFrame() {
  if (!rendering) return;

  //draw the current video
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  //overlay the watermark
  const opacity = clamp((parseInt(safe(opacityRng?.value, "60"), 10) / 100), 0, 1);
  const angle   = parseFloat(safe(rotationInp?.value, "0"));

  // Clamp padding inside SAFE area
  const padIn   = parseInt(safe(paddingInp?.value, "16"), 10);
  const safeX   = Math.round(canvas.width  * SAFE_PCT);
  const safeY   = Math.round(canvas.height * SAFE_PCT);
  const maxPad  = Math.max(0, Math.min(canvas.width - 2*safeX, canvas.height - 2*safeY) / 2 - 2);
  const pad     = clamp(padIn, 0, maxPad);

  const { x, y } = anchor(canvas.width, canvas.height, pad);
  const isText  = (textRadio?.checked ?? true);

  if (tileChk?.checked) {
    drawTiled(ctx, isText ? drawText : drawImage, angle, opacity);
  } else {
    (isText ? drawText : drawImage)(ctx, x, y, angle, opacity);
  }

  //schedule the next frame
  rafId = requestAnimationFrame(renderFrame);
}

//Export
function startExportFullDuration() {
  if (!video || !video.videoWidth) {
    alert("Load a supported video (MP4/WebM) first.");
    return;
  }
  if ((imgRadio?.checked) && !wmImgBitmap) {
    alert("Choose a watermark image or switch to Text.");
    return;
  }

  //callinf to endure the canvas matches the resolution of the vid
  fitCanvas();

  // Reset and play from start
  video.pause();
  try { video.currentTime = 0; } catch {}
  video.playbackRate = 1.0;

  // Start the loop
  rendering = true;
  cancelAnimationFrame(rafId);
  renderFrame();

  // Capture the stream
  const fps = clamp(parseInt(safe(fpsInput?.value, "30"), 10), 10, 60);
  const stream = canvas.captureStream(fps);
  const mime = pickMime();
  if (!mime) {
    alert('MediaRecorder not supported here. Try Chrome or Edge.');
    rendering = false;
    cancelAnimationFrame(rafId);
    return;
  }

  //putting it in the recorder
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
  mediaRecorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    //stop the rendering and savve the file
    clearTimeout(autoStopTimer);
    rendering = false;
    cancelAnimationFrame(rafId);

    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url, download: `watermarked_${Date.now()}.webm`
    });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    exportBtn.textContent = "Export Watermarked Video";
    exportBtn.disabled = false;
  };

  //update the export button while exporting
  exportBtn.textContent = "Exporting full video…";
  exportBtn.disabled = true;

  // Stop when source video ends
  const onEnded = () => {
    mediaRecorder?.stop();
    video.removeEventListener('ended', onEnded);
  };
  video.addEventListener('ended', onEnded);

  // Safety timeout stop after the video in case it didn't end
  const durationMs = Math.max(0, (video.duration || 0) * 1000);
  autoStopTimer = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    video.removeEventListener('ended', onEnded);
  }, durationMs + 500);

  //start the recording and the playback
  mediaRecorder.start();
  video.play().catch(()=>{});
}

// One-click exports full duration
exportBtn?.addEventListener("click", startExportFullDuration);

// Pause loop when user pauses outside export
video?.addEventListener("pause", () => {
  if (rendering && mediaRecorder?.state !== 'recording') {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
});
video?.addEventListener("play", () => {
  if (rendering && !rafId) renderFrame();
});
