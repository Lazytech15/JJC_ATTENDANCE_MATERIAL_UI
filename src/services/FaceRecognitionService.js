// src/services/FaceRecognitionService.js
const faceapi = require('face-api.js');
const { Canvas, Image, ImageData } = require('canvas');
const fs = require('fs');
const path = require('path');

// Patch face-api.js to work with Node.js
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

class FaceRecognitionService {
  constructor() {
    this.isInitialized = false;
    this.faceDescriptors = new Map(); // Store employee face descriptors
    this.modelsPath = path.join(__dirname, '../../models'); // Path to face-api.js models
  }

  async initialize() {
    try {
      // Load face-api.js models
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(this.modelsPath);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelsPath);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelsPath);
      
      console.log('Face recognition models loaded successfully');
      this.isInitialized = true;
      
      // Load existing employee face data
      await this.loadEmployeeFaceData();
    } catch (error) {
      console.error('Failed to initialize face recognition:', error);
      throw error;
    }
  }

  async loadEmployeeFaceData() {
    try {
      const dataPath = path.join(__dirname, '../data/face_descriptors.json');
      if (fs.existsSync(dataPath)) {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        
        // Convert stored arrays back to Float32Array
        for (const [employeeId, descriptorArray] of Object.entries(data)) {
          this.faceDescriptors.set(employeeId, new Float32Array(descriptorArray));
        }
        
        console.log(`Loaded face data for ${this.faceDescriptors.size} employees`);
      }
    } catch (error) {
      console.error('Error loading employee face data:', error);
    }
  }

  async saveEmployeeFaceData() {
    try {
      const dataPath = path.join(__dirname, '../data/face_descriptors.json');
      const data = {};
      
      // Convert Float32Array to regular array for JSON storage
      for (const [employeeId, descriptor] of this.faceDescriptors.entries()) {
        data[employeeId] = Array.from(descriptor);
      }
      
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
      console.log('Face data saved successfully');
    } catch (error) {
      console.error('Error saving face data:', error);
    }
  }

  async registerEmployee(employeeId, imageBuffer) {
    if (!this.isInitialized) {
      throw new Error('Face recognition service not initialized');
    }

    try {
      // Convert buffer to face-api.js compatible format
      const img = await faceapi.bufferToImage(imageBuffer);
      
      // Detect face and get descriptor
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        throw new Error('No face detected in the image');
      }

      // Store the face descriptor
      this.faceDescriptors.set(employeeId, detection.descriptor);
      await this.saveEmployeeFaceData();
      
      console.log(`Employee ${employeeId} registered successfully`);
      return true;
    } catch (error) {
      console.error('Error registering employee:', error);
      throw error;
    }
  }

  async recognizeFace(imageBuffer, threshold = 0.6) {
    if (!this.isInitialized) {
      throw new Error('Face recognition service not initialized');
    }

    try {
      const img = await faceapi.bufferToImage(imageBuffer);
      
      // Detect face and get descriptor
      const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        return { success: false, message: 'No face detected' };
      }

      // Compare with stored employee faces
      let bestMatch = null;
      let bestDistance = Infinity;

      for (const [employeeId, storedDescriptor] of this.faceDescriptors.entries()) {
        const distance = faceapi.euclideanDistance(detection.descriptor, storedDescriptor);
        
        if (distance < bestDistance && distance < threshold) {
          bestDistance = distance;
          bestMatch = employeeId;
        }
      }

      if (bestMatch) {
        return {
          success: true,
          employeeId: bestMatch,
          confidence: 1 - bestDistance, // Convert distance to confidence
          message: 'Face recognized successfully'
        };
      } else {
        return {
          success: false,
          message: 'Face not recognized',
          confidence: 0
        };
      }
    } catch (error) {
      console.error('Error recognizing face:', error);
      return { success: false, message: 'Recognition failed', error: error.message };
    }
  }

  async detectMultipleFaces(imageBuffer) {
    if (!this.isInitialized) {
      throw new Error('Face recognition service not initialized');
    }

    try {
      const img = await faceapi.bufferToImage(imageBuffer);
      
      const detections = await faceapi
        .detectAllFaces(img)
        .withFaceLandmarks()
        .withFaceDescriptors();

      return detections.map(detection => ({
        box: detection.detection.box,
        landmarks: detection.landmarks,
        descriptor: detection.descriptor
      }));
    } catch (error) {
      console.error('Error detecting faces:', error);
      throw error;
    }
  }

  removeEmployee(employeeId) {
    if (this.faceDescriptors.has(employeeId)) {
      this.faceDescriptors.delete(employeeId);
      this.saveEmployeeFaceData();
      console.log(`Employee ${employeeId} removed from face recognition`);
      return true;
    }
    return false;
  }

  getRegisteredEmployees() {
    return Array.from(this.faceDescriptors.keys());
  }

  isEmployeeRegistered(employeeId) {
    return this.faceDescriptors.has(employeeId);
  }
}

module.exports = FaceRecognitionService;