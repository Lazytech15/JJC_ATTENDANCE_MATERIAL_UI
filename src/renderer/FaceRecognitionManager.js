// FaceRecognitionManager.js - ULTRA OPTIMIZED for Maximum FPS
class FaceRecognitionManager {
  constructor(attendanceApp) {
    this.attendanceApp = attendanceApp;
    this.electronAPI = window.electronAPI;
    
    // Face-api.js configuration
    this.modelsLoaded = false;
    this.modelPath = 'models';
    
    // Face recognition state
    this.isActive = false;
    this.videoStream = null;
    this.videoElement = null;
    this.canvasElement = null;
    this.animationFrameId = null;
    
    // ULTRA OPTIMIZED: Adaptive detection based on face presence
    this.detectionIntervalMs = 300; // Faster: 300ms (3.3 FPS)
    this.fastModeIntervalMs = 150;  // When face detected: 150ms (6.6 FPS)
    this.slowModeIntervalMs = 500;  // When no face: 500ms (2 FPS)
    this.lastDetectionTime = 0;
    this.confidenceThreshold = 0.45; // Lower for better detection
    this.matchThreshold = 0.55; // Higher for better accuracy (default: 0.6)
    this.faceDescriptors = new Map();
    
    // Recognition state with cooldown
    this.lastRecognizedUID = null;
    this.lastRecognitionTime = 0;
    this.recognitionCooldown = 5000;
    
    // OPTIMIZED: Adaptive detection speed
    this.consecutiveNoFaceFrames = 0;
    this.consecutiveFaceFrames = 0;
    this.currentMode = 'normal'; // 'normal', 'fast', 'slow'
    
    // OPTIMIZED: Skip descriptor calculation when not needed
    this.lastFacePosition = null;
    this.faceMovementThreshold = 30; // pixels
    
    // DOM elements
    this.container = null;
    this.statusElement = null;
    
    // Lazy loading flags
    this.initializationStarted = false;
    this.descriptorsLoaded = false;
    
    // OPTIMIZED: Debounce and batch updates
    this.statusDebounceTimeout = null;
    this.pendingStatusUpdate = null;
    
    // OPTIMIZED: Reuse detection options
    this.detectionOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: 160,        // Smaller = faster (128, 160, 224, 320, 416, 512, 608)
      scoreThreshold: 0.4    // Lower = more detections
    });
    
    // OPTIMIZED: Cache face matcher
    this.cachedFaceMatcher = null;
    this.faceMatcherDirty = true;
    
    console.log('FaceRecognitionManager created (ULTRA OPTIMIZED)');
  }

  async init() {
    if (this.initializationStarted) {
      return;
    }
    
    this.initializationStarted = true;
    
    try {
      console.log('Starting ULTRA optimized FaceRecognitionManager...');
      
      this.createFaceRecognitionUI();
      this.showStatus('Initializing...', 'info');
      
      await this.setTensorFlowBackend();
      await this.loadModelsOptimized();
      
      // Load descriptors in background
      this.loadEmployeeFaceDescriptorsFromDB();
      
      console.log('✓ FaceRecognitionManager initialized (ULTRA mode)');
    } catch (error) {
      console.error('Failed to initialize:', error);
      this.showStatus('Initialization failed: ' + error.message, 'error');
    }
  }

  async setTensorFlowBackend() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }
      
      if (faceapi.tf?.setBackend) {
        // Suppress WebGL initialization errors
        const originalConsoleError = console.error;
        console.error = (...args) => {
          const msg = args.join(' ');
          if (!msg.includes('WebGL') && !msg.includes('backend webgl')) {
            originalConsoleError.apply(console, args);
          }
        };
        
        // Try WebGL first (much faster), fallback to CPU
        try {
          // Check if WebGL is actually available
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          
          if (gl && gl instanceof WebGLRenderingContext) {
            await faceapi.tf.setBackend('webgl');
            await faceapi.tf.ready();
            console.log('✓ TensorFlow backend: WebGL (GPU accelerated)');
          } else {
            throw new Error('WebGL not available');
          }
        } catch (e) {
          // Fallback to CPU
          await faceapi.tf.setBackend('cpu');
          await faceapi.tf.ready();
          console.log('✓ TensorFlow backend: CPU (WebGL unavailable)');
        } finally {
          // Restore console.error
          console.error = originalConsoleError;
        }
      }
    } catch (error) {
      console.warn('Could not set TensorFlow backend:', error);
    }
  }

  waitForFaceApi(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkInterval = setInterval(() => {
        if (typeof faceapi !== 'undefined') {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for face-api.js'));
        }
      }, 100);
    });
  }

  async loadModelsOptimized() {
    try {
      if (typeof faceapi === 'undefined') {
        await this.waitForFaceApi();
      }
      
      this.showStatus('Loading AI models (ultra-fast)...', 'info');
      
      // Load all models in parallel for speed
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(this.modelPath),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(this.modelPath),
        faceapi.nets.faceRecognitionNet.loadFromUri(this.modelPath)
      ]);
      
      this.modelsLoaded = true;
      console.log('✓ Models loaded (TinyFaceDetector + GPU mode)');
      this.showStatus('AI models ready', 'success');
      
    } catch (error) {
      console.error('Error loading models:', error);
      this.showStatus('Failed to load AI models', 'error');
      throw error;
    }
  }

  async loadEmployeeFaceDescriptorsFromDB() {
    try {
      this.showStatus('Loading profiles...', 'info');
      
      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success || !employeesResult.data) {
        this.showStatus('No employee profiles found', 'info');
        this.descriptorsLoaded = true;
        return;
      }
      
      const employees = employeesResult.data;
      let loadedCount = 0;
      let skippedCount = 0;
      
      // OPTIMIZED: Process all at once (no batching needed)
      employees.forEach((employee) => {
        try {
          if (!employee.face_descriptor) {
            skippedCount++;
            return;
          }
          
          const descriptorArray = JSON.parse(employee.face_descriptor);
          
          if (!Array.isArray(descriptorArray) || descriptorArray.length !== 128) {
            skippedCount++;
            return;
          }
          
          const descriptor = new Float32Array(descriptorArray);
          const uidString = String(employee.uid);
          
          this.faceDescriptors.set(uidString, {
            descriptor: descriptor,
            employee: employee,
            name: `${employee.first_name} ${employee.last_name}`
          });
          
          loadedCount++;
          
        } catch (error) {
          console.error(`Error processing descriptor for ${employee.uid}:`, error);
          skippedCount++;
        }
      });
      
      // Invalidate cached matcher
      this.faceMatcherDirty = true;
      
      this.descriptorsLoaded = true;
      console.log(`✓ Loaded ${loadedCount} descriptors (${skippedCount} skipped)`);
      
      if (loadedCount === 0) {
        this.showStatus('No valid face descriptors', 'error');
      } else {
        this.showStatus(`Ready: ${loadedCount} profiles`, 'success');
      }
      
      this.updateLoadedCount(loadedCount);
      
    } catch (error) {
      console.error('Error loading descriptors:', error);
      this.showStatus('Error loading profiles', 'error');
      this.descriptorsLoaded = true;
    }
  }

  updateLoadedCount(count) {
    const countElement = document.getElementById('facesLoadedCount');
    if (countElement) {
      countElement.textContent = count;
    }
  }

  // OPTIMIZED: Get or create cached face matcher
  getFaceMatcher() {
    if (!this.faceMatcherDirty && this.cachedFaceMatcher) {
      return this.cachedFaceMatcher;
    }
    
    const labeledDescriptors = Array.from(this.faceDescriptors.entries()).map(
      ([uid, data]) => new faceapi.LabeledFaceDescriptors(uid, [data.descriptor])
    );
    
    this.cachedFaceMatcher = new faceapi.FaceMatcher(labeledDescriptors, this.matchThreshold);
    this.faceMatcherDirty = false;
    
    return this.cachedFaceMatcher;
  }

  createFaceRecognitionUI() {
    this.container = document.createElement('div');
    this.container.id = 'faceRecognitionContainer';
    this.container.className = 'face-recognition-container hidden';
    this.container.innerHTML = `
      <div class="face-recognition-header">
        <h3>Face Recognition <span class="badge badge-ultra">Ultra Mode</span></h3>
        <button id="closeFaceRecognition" class="close-btn">✕</button>
      </div>
      
      <div class="face-recognition-content">
        <div class="video-wrapper">
          <video id="faceRecognitionVideo" autoplay muted playsinline></video>
          <canvas id="faceRecognitionCanvas"></canvas>
          <div class="performance-indicator" id="performanceIndicator">
            <span class="perf-dot"></span>
            <span id="perfMode">Normal</span>
          </div>
        </div>
        
        <div class="face-recognition-status" id="faceRecognitionStatus">
          Ready to scan faces...
        </div>
        
        <div class="face-recognition-info">
          <div class="info-item">
            <span class="info-label">Profiles:</span>
            <span class="info-value" id="facesLoadedCount">0</span>
          </div>
          <div class="info-item">
            <span class="info-label">Status:</span>
            <span class="info-value" id="detectionStatus">Inactive</span>
          </div>
          <div class="info-item">
            <span class="info-label">FPS:</span>
            <span class="info-value" id="fpsCounter">0</span>
          </div>
          <div class="info-item">
            <span class="info-label">Backend:</span>
            <span class="info-value" id="backendType">CPU</span>
          </div>
        </div>
        
        <div class="face-recognition-controls">
          <button id="startFaceRecognition" class="btn btn-primary">
            📷 Start Recognition
          </button>
          <button id="stopFaceRecognition" class="btn btn-secondary" disabled>
            ⏹️ Stop
          </button>
        </div>
        
        <div class="performance-tips">
          <small>💡 Tips: Good lighting improves accuracy. Position face 1-2 meters from camera.</small>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.container);
    
    this.videoElement = document.getElementById('faceRecognitionVideo');
    this.canvasElement = document.getElementById('faceRecognitionCanvas');
    this.statusElement = document.getElementById('faceRecognitionStatus');
    
    this.setupEventListeners();
    this.addStyles();
    
    this.updateLoadedCount(this.faceDescriptors.size);
    this.updateBackendType();
  }

  updateBackendType() {
    const backendElement = document.getElementById('backendType');
    if (backendElement && typeof faceapi !== 'undefined' && faceapi.tf) {
      const backend = faceapi.tf.getBackend();
      backendElement.textContent = backend === 'webgl' ? 'GPU' : 'CPU';
      
      if (backend === 'webgl') {
        backendElement.style.color = '#22c55e';
      }
    }
  }

  setupEventListeners() {
    document.getElementById('closeFaceRecognition').addEventListener('click', () => {
      this.hide();
    });
    
    document.getElementById('startFaceRecognition').addEventListener('click', () => {
      this.startRecognition();
    });
    
    document.getElementById('stopFaceRecognition').addEventListener('click', () => {
      this.stopRecognition();
    });
    
    if (this.videoElement) {
      this.videoElement.addEventListener('loadedmetadata', () => {
        this.setupCanvas();
      });
    }
  }

  addStyles() {
    if (document.getElementById('faceRecognitionStyles')) return;
    
    const style = document.createElement('style');
    style.id = 'faceRecognitionStyles';
    style.textContent = `
      .face-recognition-container {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90%;
        max-width: 700px;
        background: white;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        max-height: 90vh;
      }
      
      .face-recognition-container.hidden {
        display: none;
      }
      
      .face-recognition-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .face-recognition-header h3 {
        margin: 0;
        font-size: 20px;
        color: #1f2937;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .badge {
        font-size: 11px;
        font-weight: 600;
        background: #22c55e;
        color: white;
        padding: 2px 8px;
        border-radius: 4px;
      }
      
      .badge-ultra {
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        animation: pulse 2s ease-in-out infinite;
      }
      
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
      }
      
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: #6b7280;
        cursor: pointer;
        padding: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: all 0.2s;
      }
      
      .close-btn:hover {
        background: #f3f4f6;
        color: #1f2937;
      }
      
      .face-recognition-content {
        padding: 20px;
        overflow-y: auto;
      }
      
      .video-wrapper {
        position: relative;
        width: 100%;
        background: #000;
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 20px;
      }
      
      #faceRecognitionVideo {
        width: 100%;
        height: auto;
        display: block;
      }
      
      #faceRecognitionCanvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      
      .performance-indicator {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 6px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .perf-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c55e;
        animation: blink 1s ease-in-out infinite;
      }
      
      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      
      .face-recognition-status {
        padding: 16px;
        background: #f3f4f6;
        border-radius: 8px;
        text-align: center;
        font-weight: 500;
        margin-bottom: 20px;
        color: #1f2937;
        transition: all 0.2s;
      }
      
      .face-recognition-status.detecting {
        background: #dbeafe;
        color: #1e40af;
      }
      
      .face-recognition-status.recognized {
        background: #dcfce7;
        color: #166534;
      }
      
      .face-recognition-status.error {
        background: #fee2e2;
        color: #991b1b;
      }
      
      .face-recognition-info {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-bottom: 20px;
      }
      
      .info-item {
        padding: 10px;
        background: #f9fafb;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .info-label {
        font-size: 11px;
        color: #6b7280;
        font-weight: 500;
      }
      
      .info-value {
        font-size: 16px;
        color: #1f2937;
        font-weight: 600;
      }
      
      .face-recognition-controls {
        display: flex;
        gap: 12px;
        margin-bottom: 12px;
      }
      
      .face-recognition-controls .btn {
        flex: 1;
        padding: 12px 24px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .btn-primary {
        background: #3b82f6;
        color: white;
      }
      
      .btn-primary:hover:not(:disabled) {
        background: #2563eb;
        transform: translateY(-1px);
      }
      
      .btn-secondary {
        background: #ef4444;
        color: white;
      }
      
      .btn-secondary:hover:not(:disabled) {
        background: #dc2626;
        transform: translateY(-1px);
      }
      
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .performance-tips {
        padding: 12px;
        background: #fef3c7;
        border-radius: 6px;
        text-align: center;
      }
      
      .performance-tips small {
        color: #92400e;
        font-size: 12px;
      }
    `;
    
    document.head.appendChild(style);
  }

  setupCanvas() {
    if (!this.videoElement || !this.canvasElement) return;
    
    const displaySize = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight
    };
    
    faceapi.matchDimensions(this.canvasElement, displaySize);
  }

  async startRecognition() {
    if (!this.modelsLoaded) {
      this.showStatus('AI models not loaded yet', 'error');
      return;
    }
    
    if (!this.descriptorsLoaded) {
      this.showStatus('Employee profiles loading...', 'info');
      return;
    }
    
    if (this.faceDescriptors.size === 0) {
      this.showStatus('No employee profiles available', 'error');
      return;
    }
    
    try {
      // OPTIMIZED: Even lower resolution for maximum speed
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 480 },  // Lower resolution = faster
          height: { ideal: 360 },
          facingMode: 'user',
          frameRate: { ideal: 30, max: 30 } // Limit frame rate
        }
      });
      
      this.videoElement.srcObject = this.videoStream;
      this.isActive = true;
      this.currentMode = 'normal';
      this.consecutiveNoFaceFrames = 0;
      this.consecutiveFaceFrames = 0;
      
      document.getElementById('startFaceRecognition').disabled = true;
      document.getElementById('stopFaceRecognition').disabled = false;
      document.getElementById('detectionStatus').textContent = 'Active';
      this.showStatus('Face recognition active', 'detecting');
      
      this.startDetectionLoop();
      
    } catch (error) {
      console.error('Error starting recognition:', error);
      this.showStatus('Failed to access camera: ' + error.message, 'error');
    }
  }

  stopRecognition() {
    this.isActive = false;
    
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
    }
    
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
    
    if (this.canvasElement) {
      const ctx = this.canvasElement.getContext('2d');
      ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
    }
    
    document.getElementById('startFaceRecognition').disabled = false;
    document.getElementById('stopFaceRecognition').disabled = true;
    document.getElementById('detectionStatus').textContent = 'Inactive';
    document.getElementById('fpsCounter').textContent = '0';
    this.showStatus('Face recognition stopped', 'info');
    this.updatePerformanceMode('Stopped');
  }

  // ULTRA OPTIMIZED: Adaptive speed based on detection
  startDetectionLoop() {
    let frameCount = 0;
    let lastFpsUpdate = Date.now();
    let totalFrames = 0;
    
    const detectLoop = async () => {
      if (!this.isActive) return;
      
      const currentTime = Date.now();
      
      // Adaptive interval based on face presence
      let currentInterval = this.detectionIntervalMs;
      if (this.currentMode === 'fast') {
        currentInterval = this.fastModeIntervalMs;
      } else if (this.currentMode === 'slow') {
        currentInterval = this.slowModeIntervalMs;
      }
      
      // Only detect at specified interval
      if (currentTime - this.lastDetectionTime >= currentInterval) {
        this.lastDetectionTime = currentTime;
        
        try {
          await this.detectAndRecognizeFaces();
        } catch (error) {
          console.error('Detection error:', error);
        }
        
        frameCount++;
        totalFrames++;
      }
      
      // Update FPS counter every second
      if (currentTime - lastFpsUpdate >= 1000) {
        const fps = Math.round((frameCount * 1000) / (currentTime - lastFpsUpdate));
        const fpsElement = document.getElementById('fpsCounter');
        if (fpsElement) {
          fpsElement.textContent = fps;
        }
        frameCount = 0;
        lastFpsUpdate = currentTime;
      }
      
      this.animationFrameId = requestAnimationFrame(detectLoop);
    };
    
    detectLoop();
  }

  async detectAndRecognizeFaces() {
    if (!this.videoElement || this.videoElement.paused) return;
    
    const displaySize = {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight
    };
    
    // OPTIMIZED: Use cached detection options
    const detections = await faceapi
      .detectAllFaces(this.videoElement, this.detectionOptions)
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    
    if (detections.length === 0) {
      this.clearCanvas();
      this.consecutiveNoFaceFrames++;
      this.consecutiveFaceFrames = 0;
      
      // Switch to slow mode after 3 frames with no face
      if (this.consecutiveNoFaceFrames > 3 && this.currentMode !== 'slow') {
        this.currentMode = 'slow';
        this.updatePerformanceMode('Power Save');
      }
      
      this.showStatusDebounced('No face detected', 'detecting');
      return;
    }
    
    // Face detected - switch to fast mode
    this.consecutiveFaceFrames++;
    this.consecutiveNoFaceFrames = 0;
    
    if (this.consecutiveFaceFrames > 2 && this.currentMode !== 'fast') {
      this.currentMode = 'fast';
      this.updatePerformanceMode('High Speed');
    }
    
    const resizedDetections = faceapi.resizeResults(detections, displaySize);
    
    this.clearCanvas();
    
    // OPTIMIZED: Use cached face matcher
    const faceMatcher = this.getFaceMatcher();
    
    let recognized = false;
    
    resizedDetections.forEach(detection => {
      const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
      
      const box = detection.detection.box;
      this.drawDetectionBox(box, bestMatch);
      
      if (bestMatch.label !== 'unknown') {
        recognized = true;
        const employeeData = this.faceDescriptors.get(bestMatch.label);
        
        if (employeeData) {
          this.handleRecognition(employeeData, bestMatch.distance);
        }
      }
    });
    
    if (!recognized) {
      this.showStatusDebounced('Face detected but not recognized', 'detecting');
    }
  }

  updatePerformanceMode(mode) {
    const perfElement = document.getElementById('perfMode');
    if (perfElement) {
      perfElement.textContent = mode;
    }
  }

  drawDetectionBox(box, match) {
    const ctx = this.canvasElement.getContext('2d');
    const isRecognized = match.label !== 'unknown';
    
    // OPTIMIZED: Simpler, cleaner drawing
    ctx.strokeStyle = isRecognized ? '#22c55e' : '#3b82f6';
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    
    if (isRecognized) {
      const employeeData = this.faceDescriptors.get(match.label);
      const label = employeeData ? employeeData.name : match.label;
      const confidence = Math.round((1 - match.distance) * 100);
      
      // Background
      ctx.fillStyle = 'rgba(34, 197, 94, 0.95)';
      const padding = 8;
      const textHeight = 22;
      ctx.fillRect(box.x, box.y + box.height + 5, box.width, textHeight + padding);
      
      // Text
      ctx.fillStyle = 'white';
      ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `${label} (${confidence}%)`, 
        box.x + padding, 
        box.y + box.height + 5 + (textHeight + padding) / 2
      );
    }
  }

  clearCanvas() {
    if (!this.canvasElement) return;
    const ctx = this.canvasElement.getContext('2d');
    ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
  }

  async handleRecognition(employeeData, distance) {
    const currentTime = Date.now();
    const confidence = Math.round((1 - distance) * 100);
    
    const uidString = String(employeeData.employee.uid);
    
    // Cooldown check
    if (
      this.lastRecognizedUID === uidString &&
      currentTime - this.lastRecognitionTime < this.recognitionCooldown
    ) {
      return;
    }
    
    this.lastRecognizedUID = uidString;
    this.lastRecognitionTime = currentTime;
    
    this.showStatus(
      `✓ ${employeeData.name} (${confidence}%)`,
      'recognized'
    );
    
    await this.processAttendance(employeeData.employee);
  }

  async processAttendance(employee) {
    try {
      const result = await this.electronAPI.clockAttendance({
        input: employee.uid,
        inputType: 'barcode'
      });
      
      if (result.success) {
        if (this.attendanceApp?.showEmployeeDisplay) {
          this.attendanceApp.showEmployeeDisplay(result.data);
        }
        
        this.showStatus(
          `✓ Recorded: ${employee.first_name} ${employee.last_name}`,
          'recognized'
        );
        
        setTimeout(() => {
          if (this.isActive) {
            this.showStatus('Ready for next scan', 'detecting');
          }
        }, 2500);
        
      } else {
        this.showStatus(`Error: ${result.error}`, 'error');
      }
      
    } catch (error) {
      console.error('Error processing attendance:', error);
      this.showStatus('Failed to record attendance', 'error');
    }
  }

  showStatusDebounced(message, type = 'info', delay = 200) {
    if (this.statusDebounceTimeout) {
      clearTimeout(this.statusDebounceTimeout);
    }
    
    this.statusDebounceTimeout = setTimeout(() => {
      this.showStatus(message, type);
    }, delay);
  }

  showStatus(message, type = 'info') {
    if (!this.statusElement) return;
    
    // Only update if different
    if (this.statusElement.textContent === message && 
        this.statusElement.classList.contains(type)) {
      return;
    }
    
    this.statusElement.textContent = message;
    this.statusElement.className = `face-recognition-status ${type}`;
  }

  async show() {
    if (!this.initializationStarted) {
      await this.init();
    }
    
    if (this.container) {
      this.container.classList.remove('hidden');
    }
  }

  hide() {
    this.stopRecognition();
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  async refreshEmployeeFaceDescriptors() {
    this.faceDescriptors.clear();
    this.descriptorsLoaded = false;
    this.faceMatcherDirty = true;
    this.cachedFaceMatcher = null;
    await this.loadEmployeeFaceDescriptorsFromDB();
  }

  async refreshSingleDescriptor(uid) {
    try {
      const uidString = String(uid);
      
      const employeesResult = await this.electronAPI.getEmployees();
      if (!employeesResult.success) return false;
      
      const employee = employeesResult.data.find(e => String(e.uid) === uidString);
      if (!employee?.face_descriptor) return false;
      
      const descriptorArray = JSON.parse(employee.face_descriptor);
      if (!Array.isArray(descriptorArray) || descriptorArray.length !== 128) {
        return false;
      }
      
      const descriptor = new Float32Array(descriptorArray);
      this.faceDescriptors.set(uidString, {
        descriptor: descriptor,
        employee: employee,
        name: `${employee.first_name} ${employee.last_name}`
      });
      
      // Invalidate matcher cache
      this.faceMatcherDirty = true;
      
      this.updateLoadedCount(this.faceDescriptors.size);
      
      console.log(`✓ Refreshed: ${employee.first_name} ${employee.last_name}`); 
      return true;
      
    } catch (error) {
      console.error('Error refreshing descriptor:', error);
      return false;
    }
  }

  destroy() {
    this.stopRecognition();
    
    if (this.statusDebounceTimeout) {
      clearTimeout(this.statusDebounceTimeout);
    }
    
    if (this.container) {
      this.container.remove();
    }
    
    this.faceDescriptors.clear();
    this.cachedFaceMatcher = null;
    console.log('FaceRecognitionManager destroyed');
  }
}

window.FaceRecognitionManager = FaceRecognitionManager;