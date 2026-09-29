const video = document.getElementById('camera-stream');
const canvas = document.getElementById('output-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const trailCanvas = document.getElementById('trail-canvas');
const trailCtx = trailCanvas.getContext('2d');
const cameraDataEl = document.getElementById('camera-data');
const tagDataEl = document.getElementById('tag-data');
const clearTrailButton = document.getElementById('clear-trail');
const nextMissionButton = document.getElementById('next-mission');
const missionModal = document.getElementById('mission-modal');

// Especificaciones solicitadas
const TARGET_ID = 0;
const LOST_AFTER_MS = 600; // 0.6 segundos en milisegundos
const MAX_TRAIL_POINTS = 450;
const MIN_TRAIL_DISTANCE = 3;
const GOAL_RADIUS = 42;

let tagTracker = {}; 
let cameraInfo = {};
let detectorReady = false;
let apriltagDetector = null;
let detectionInProgress = false;
let trailPoints = [];
let startPoint = null;
let finishPoint = null;
let missionComplete = false;

// 1. INICIALIZAR EL DETECTOR WEBASSEMBLY EN UN WEB WORKER
async function startDetector() {
    try {
        const Apriltag = Comlink.wrap(new Worker("apriltag.js?v=20260819-4"));
        apriltagDetector = await new Apriltag(Comlink.proxy(() => {
            detectorReady = true;
            console.log("Motor AprilTag WASM cargado y listo.");
        }));
    } catch (err) {
        console.error("No se pudo iniciar el detector:", err);
        tagDataEl.innerText = `Error al iniciar el detector: ${err.message || err}`;
    }
}

// Inicializar la cámara
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment", // Usar cámara trasera
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            video.play();
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            trailCanvas.width = video.videoWidth;
            trailCanvas.height = video.videoHeight;
            extractCameraData(stream.getVideoTracks()[0]);
            
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        console.error("Error al acceder a la cámara: ", err);
        cameraDataEl.innerText = "Error al acceder a la cámara. Revisa los permisos.";
    }
}

function extractCameraData(track) {
    const settings = track.getSettings();
    const width = settings.width || video.videoWidth;
    const height = settings.height || video.videoHeight;
    const fps = settings.frameRate || 30;

    const cx = width / 2.0;
    const cy = height / 2.0;
    const fx = width * 0.8; 
    const fy = fx; 

    cameraInfo = { index: 0, width, height, fps, cx, cy, fx, fy };
    cameraDataEl.innerText = JSON.stringify(cameraInfo, null, 2);
}

// Bucle principal
async function processFrame() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Solo intentamos detectar si el motor ya se descargó y activó
    if (detectorReady && apriltagDetector && !detectionInProgress) {
        detectionInProgress = true;
        const width = canvas.width;
        const height = canvas.height;
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Convertir la imagen a blanco y negro (Requisito del detector en C)
        const grayscale = new Uint8Array(width * height);
        for (let i = 0; i < grayscale.length; i++) {
            grayscale[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
        }
        
        try {
            // El detector asume por defecto la familia tag36h11
            const tags = await apriltagDetector.detect(grayscale, width, height);
            const targetTag = handleDetections(tags);
            drawTrail();
            if (targetTag) drawTag(targetTag);
        } catch (e) {
            console.error("Fallo leyendo el tag:", e);
            tagDataEl.innerText = `Error del detector: ${e.message || e}`;
        } finally {
            detectionInProgress = false;
        }
    }

    checkLostTags();
    requestAnimationFrame(processFrame);
}

function handleDetections(tags) {
    const now = Date.now();
    let targetTag = null;

    tags.forEach(tag => {
        // Filtramos por el Robot Tag ID 0
        if (tag.id === TARGET_ID) {
            tagTracker[TARGET_ID] = now;
            targetTag = tag;
            if (!missionComplete) {
                addTrailPoint(tag.center.x, tag.center.y);
                const distanceToGoal = finishPoint
                    ? Math.hypot(tag.center.x - finishPoint.x, tag.center.y - finishPoint.y)
                    : 0;

                if (finishPoint && distanceToGoal <= GOAL_RADIUS) {
                    completeMission();
                } else {
                    tagDataEl.innerText = `🟢 ¡Robot en movimiento!\nRuta: ${trailPoints.length} puntos\nDistancia a la meta: ${Math.round(distanceToGoal)} px`;
                }
            }
        }
    });

    return targetTag;
}

function addTrailPoint(x, y) {
    const lastPoint = trailPoints[trailPoints.length - 1];
    if (lastPoint && Math.hypot(x - lastPoint.x, y - lastPoint.y) < MIN_TRAIL_DISTANCE) return;

    trailPoints.push({ x, y });
    if (!startPoint) {
        startPoint = { x, y };
        finishPoint = createAutomaticGoal(startPoint);
    }
    if (trailPoints.length > MAX_TRAIL_POINTS) trailPoints.shift();
}

function createAutomaticGoal(start) {
    const margin = 70;
    const distance = Math.max(150, Math.min(canvas.width, canvas.height) * 0.32);
    const directions = [
        { x: distance, y: 0 },
        { x: -distance, y: 0 },
        { x: 0, y: distance },
        { x: 0, y: -distance }
    ].filter(direction => {
        const goalX = start.x + direction.x;
        const goalY = start.y + direction.y;
        return goalX >= margin && goalX <= canvas.width - margin &&
            goalY >= margin && goalY <= canvas.height - margin;
    });

    const direction = directions[Math.floor(Math.random() * directions.length)] || {
        x: start.x < canvas.width / 2 ? distance : -distance,
        y: 0
    };

    return {
        x: Math.max(margin, Math.min(canvas.width - margin, start.x + direction.x)),
        y: Math.max(margin, Math.min(canvas.height - margin, start.y + direction.y))
    };
}

function completeMission() {
    missionComplete = true;
    drawTrail();
    tagDataEl.innerText = `🏁 ¡Misión completada!\nRecorrido terminado con ${trailPoints.length} puntos.`;
    missionModal.hidden = false;
}

function drawTrail() {
    if (trailPoints.length === 0) return;

    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    trailCtx.save();
    trailCtx.lineCap = 'round';
    trailCtx.lineJoin = 'round';
    trailCtx.strokeStyle = '#579c9f';
    trailCtx.lineWidth = 7;
    trailCtx.shadowColor = '#579c9f';
    trailCtx.shadowBlur = 16;
    trailCtx.beginPath();
    trailCtx.moveTo(trailPoints[0].x, trailPoints[0].y);
    trailPoints.slice(1).forEach(point => trailCtx.lineTo(point.x, point.y));
    trailCtx.stroke();

    trailPoints.forEach((point, index) => {
        if (index % 16 !== 0) return;
        drawStar(point.x, point.y, 7);
    });
    trailCtx.restore();
    drawRouteMarker(startPoint, 'INICIO', '#bae0d5');
    if (finishPoint) drawFinishFlag(finishPoint);
}

function drawRouteMarker(point, label, color) {
    if (!point) return;
    trailCtx.save();
    trailCtx.fillStyle = color;
    trailCtx.strokeStyle = '#142b4d';
    trailCtx.lineWidth = 4;
    trailCtx.shadowColor = color;
    trailCtx.shadowBlur = 16;
    trailCtx.beginPath();
    trailCtx.arc(point.x, point.y, 13, 0, Math.PI * 2);
    trailCtx.fill();
    trailCtx.stroke();
    trailCtx.shadowBlur = 0;
    trailCtx.fillStyle = '#ffffff';
    trailCtx.font = '900 18px Nunito, sans-serif';
    trailCtx.strokeStyle = '#142b4d';
    trailCtx.lineWidth = 5;
    trailCtx.strokeText(label, point.x + 20, point.y - 14);
    trailCtx.fillText(label, point.x + 20, point.y - 14);
    trailCtx.restore();
}

function drawFinishFlag(point) {
    trailCtx.save();
    trailCtx.fillStyle = 'rgba(186, 224, 213, .18)';
    trailCtx.strokeStyle = '#bae0d5';
    trailCtx.lineWidth = 4;
    trailCtx.setLineDash([10, 8]);
    trailCtx.beginPath();
    trailCtx.arc(point.x, point.y, GOAL_RADIUS, 0, Math.PI * 2);
    trailCtx.fill();
    trailCtx.stroke();
    trailCtx.setLineDash([]);
    trailCtx.strokeStyle = '#ffffff';
    trailCtx.lineWidth = 5;
    trailCtx.shadowColor = '#579c9f';
    trailCtx.shadowBlur = 16;
    trailCtx.beginPath();
    trailCtx.moveTo(point.x, point.y + 18);
    trailCtx.lineTo(point.x, point.y - 25);
    trailCtx.stroke();
    trailCtx.fillStyle = '#579c9f';
    trailCtx.beginPath();
    trailCtx.moveTo(point.x, point.y - 25);
    trailCtx.lineTo(point.x + 34, point.y - 15);
    trailCtx.lineTo(point.x, point.y - 4);
    trailCtx.closePath();
    trailCtx.fill();
    trailCtx.restore();
    drawRouteMarker(point, 'META', '#579c9f');
}

function drawStar(x, y, radius) {
    trailCtx.fillStyle = '#bae0d5';
    trailCtx.beginPath();
    for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const pointRadius = i % 2 === 0 ? radius : radius * 0.42;
        const px = x + Math.cos(angle) * pointRadius;
        const py = y + Math.sin(angle) * pointRadius;
        i === 0 ? trailCtx.moveTo(px, py) : trailCtx.lineTo(px, py);
    }
    trailCtx.closePath();
    trailCtx.fill();
}

function checkLostTags() {
    const now = Date.now();
    if (tagTracker[TARGET_ID]) {
        const timeSinceLastSeen = now - tagTracker[TARGET_ID];
        
        if (timeSinceLastSeen > LOST_AFTER_MS) {
            tagDataEl.innerText = `🟡 Buscando el robot...\nAcerca el AprilTag ID 0 a la cámara.\nRuta guardada: ${trailPoints.length} puntos`;
        }
    }
}

clearTrailButton.addEventListener('click', () => {
    trailPoints = [];
    tagTracker = {};
    startPoint = null;
    finishPoint = null;
    missionComplete = false;
    missionModal.hidden = true;
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    tagDataEl.innerText = '✨ ¡Nueva misión! Muestra el robot para crear inicio y meta.';
});

nextMissionButton.addEventListener('click', () => clearTrailButton.click());

function drawTag(tag) {
    ctx.beginPath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#bae0d5";
    ctx.moveTo(tag.corners[0].x, tag.corners[0].y);
    ctx.lineTo(tag.corners[1].x, tag.corners[1].y);
    ctx.lineTo(tag.corners[2].x, tag.corners[2].y);
    ctx.lineTo(tag.corners[3].x, tag.corners[3].y);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = "#bae0d5";
    ctx.font = "24px Arial";
    ctx.fillText(`ID: ${tag.id}`, tag.center.x - 20, tag.center.y);
}

// Iniciar todo
startDetector();
startCamera();
