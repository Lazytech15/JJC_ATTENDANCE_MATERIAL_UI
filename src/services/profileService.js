const fs = require("fs").promises
const path = require("path")
const https = require("https")
const http = require("http")
const yauzl = require("yauzl")
const { app } = require('electron')

class ProfileService {
  constructor() {
    // UPDATED: Always use AppData path for both dev and production
    this.profilesDir = this.getProfilesDirectory()
    this.ensureProfilesDirectory()
  }

  // UPDATED: Always use AppData directory for consistent behavior
  getProfilesDirectory() {
    // Always use userData directory for profiles (both dev and production)
    const userDataPath = app.getPath('userData')
    return path.join(userDataPath, "profiles")
  }

  async ensureProfilesDirectory() {
    try {
      console.log(`Creating profiles directory at: ${this.profilesDir}`)
      await fs.mkdir(this.profilesDir, { recursive: true })
      
      // Verify the directory was created and is writable
      await fs.access(this.profilesDir, fs.constants.W_OK)
      console.log(`✓ Profiles directory ready: ${this.profilesDir}`)
      
      return true
    } catch (error) {
      console.error("Error creating profiles directory:", error)
      
      // Try fallback location in AppData temp
      try {
        const fallbackDir = path.join(app.getPath('temp'), "jjc-attendance-profiles")
        console.log(`Trying fallback profiles directory: ${fallbackDir}`)
        
        await fs.mkdir(fallbackDir, { recursive: true })
        await fs.access(fallbackDir, fs.constants.W_OK)
        
        this.profilesDir = fallbackDir
        console.log(`✓ Using fallback profiles directory: ${this.profilesDir}`)
        return true
      } catch (fallbackError) {
        console.error("Fallback profiles directory also failed:", fallbackError)
        return false
      }
    }
  }

  // UPDATED: Bulk download all profiles as ZIP and extract them locally
  async bulkDownloadProfiles(serverUrl, options = {}) {
    try {
      const {
        uids = [], // Array of specific UIDs to download
        department = '', // Filter by department
        search = '', // Search filter
        onProgress = null // Progress callback function
      } = options

      console.log("Starting bulk profile download...")
      console.log(`Target directory: ${this.profilesDir}`)

      // Ensure profiles directory exists before starting
      const dirReady = await this.ensureProfilesDirectory()
      if (!dirReady) {
        throw new Error("Could not create profiles directory")
      }

      if (onProgress) {
        onProgress({ 
          stage: 'initializing', 
          message: 'Preparing bulk download...',
          total: uids.length || 'all',
          profilesDir: this.profilesDir
        })
      }

      // Determine which endpoint to use
      let downloadUrl
      let requestOptions = {}

      if (uids.length > 0) {
        // Use POST endpoint for specific UIDs
        downloadUrl = `${serverUrl}/api/profile/bulk/download`
        requestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            uids: uids,
            include_summary: true,
            compression_level: 6
          })
        }
        
        if (onProgress) {
          onProgress({ 
            stage: 'downloading', 
            message: `Downloading ${uids.length} specific profiles...`,
            uids: uids
          })
        }
      } else {
        // Use GET endpoint with query parameters
        const params = new URLSearchParams()
        if (department) params.append('department', department)
        if (search) params.append('search', search)
        
        downloadUrl = `${serverUrl}/api/profile/bulk/download${params.toString() ? '?' + params.toString() : ''}`
        requestOptions = { method: 'GET' }
        
        if (onProgress) {
          onProgress({ 
            stage: 'downloading', 
            message: 'downloading all profiles matching filters...',
            filters: { department, search }
          })
        }
      }

      // Download the ZIP file
      const timestamp = Date.now()
      const zipPath = path.join(this.profilesDir, `bulk_profiles_${timestamp}.zip`)
      
      console.log(`Downloading ZIP to: ${zipPath}`)
      await this.downloadFile(downloadUrl, zipPath, requestOptions)

      if (onProgress) {
        onProgress({ 
          stage: 'downloaded', 
          message: 'ZIP file downloaded successfully, extracting...',
          zipPath: zipPath
        })
      }

      // Extract the ZIP file
      const extractedFiles = await this.extractZipFile(zipPath)

      if (onProgress) {
        onProgress({ 
          stage: 'extracted', 
          message: `Extracted ${extractedFiles.length} files`,
          files: extractedFiles.map(f => f.originalName)
        })
      }

      // Process extracted files and organize them
      const profileMap = await this.organizeExtractedProfiles(extractedFiles)

      // Clean up ZIP file
      try {
        await fs.unlink(zipPath)
        console.log(`Cleaned up ZIP file: ${zipPath}`)
      } catch (cleanupError) {
        console.warn("Could not clean up ZIP file:", cleanupError)
      }

      if (onProgress) {
        onProgress({ 
          stage: 'completed', 
          message: `Successfully processed ${Object.keys(profileMap).length} profile images`,
          profiles: profileMap
        })
      }

      return {
        success: true,
        message: `Successfully downloaded and extracted ${Object.keys(profileMap).length} profile images`,
        profiles: profileMap,
        total: Object.keys(profileMap).length,
        extracted_files: extractedFiles.length,
        profilesDir: this.profilesDir,
        summary: await this.loadDownloadSummary(extractedFiles)
      }

    } catch (error) {
      console.error("Error in bulk profile download:", error)
      
      if (onProgress) {
        onProgress({ 
          stage: 'error', 
          message: `Download failed: ${error.message}`,
          error: error
        })
      }
      
      return {
        success: false,
        error: error.message,
        profiles: {},
        total: 0,
        profilesDir: this.profilesDir
      }
    }
  }

  // Load download summary if it exists
  async loadDownloadSummary(extractedFiles) {
    try {
      const summaryFile = extractedFiles.find(f => f.originalName === 'download_summary.json')
      if (summaryFile && summaryFile.localPath) {
        const summaryContent = await fs.readFile(summaryFile.localPath, 'utf8')
        const summary = JSON.parse(summaryContent)
        
        // Clean up summary file
        await fs.unlink(summaryFile.localPath).catch(() => {})
        
        return summary
      }
    } catch (error) {
      console.warn("Could not load download summary:", error)
    }
    return null
  }

  // IMPROVED: Extract ZIP file with better error handling
  async extractZipFile(zipPath) {
    console.log(`Starting extraction of: ${zipPath}`)
    
    return new Promise((resolve, reject) => {
      const extractedFiles = []
      let isFinalized = false

      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          console.error("Error opening ZIP file:", err)
          reject(err)
          return
        }

        console.log(`ZIP file opened successfully: ${zipfile.entryCount} entries`)
        zipfile.readEntry()

        zipfile.on("entry", (entry) => {
          console.log(`Processing entry: ${entry.fileName}`)
          
          // Skip directories
          if (/\/$/.test(entry.fileName)) {
            console.log(`Skipping directory: ${entry.fileName}`)
            zipfile.readEntry()
            return
          }

          // Process all files (including summary)
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              console.error(`Error reading ${entry.fileName}:`, err)
              zipfile.readEntry()
              return
            }

            const outputPath = path.join(this.profilesDir, entry.fileName)
            console.log(`Extracting to: ${outputPath}`)
            
            // Ensure the directory exists for the output file
            const outputDir = path.dirname(outputPath)
            require('fs').mkdirSync(outputDir, { recursive: true })
            
            const writeStream = require('fs').createWriteStream(outputPath)

            readStream.pipe(writeStream)

            writeStream.on('close', () => {
              console.log(`✓ Extracted: ${entry.fileName} (${entry.uncompressedSize} bytes)`)
              extractedFiles.push({
                originalName: entry.fileName,
                localPath: outputPath,
                size: entry.uncompressedSize
              })
              zipfile.readEntry()
            })

            writeStream.on('error', (writeErr) => {
              console.error(`Error writing ${entry.fileName}:`, writeErr)
              zipfile.readEntry()
            })
          })
        })

        zipfile.on("end", () => {
          console.log(`ZIP extraction completed. ${extractedFiles.length} files extracted.`)
          if (!isFinalized) {
            isFinalized = true
            resolve(extractedFiles)
          }
        })

        zipfile.on("error", (error) => {
          console.error("ZIP file error:", error)
          if (!isFinalized) {
            isFinalized = true
            reject(error)
          }
        })
      })
    })
  }

  // IMPROVED: Better organization of extracted profiles
  async organizeExtractedProfiles(extractedFiles) {
    const profileMap = {}
    console.log(`Organizing ${extractedFiles.length} extracted files...`)

    for (const file of extractedFiles) {
      try {
        // Skip summary file
        if (file.originalName === 'download_summary.json') {
          console.log("Skipping summary file")
          continue
        }

        // Extract UID from filename (format: "UID_Name.ext")
        const filename = path.basename(file.originalName)
        const uidMatch = filename.match(/^(\d+)_/)
        
        if (uidMatch) {
          const uid = parseInt(uidMatch[1])
          const extension = path.extname(filename)
          
          // Rename file to standard format for easier lookup
          const standardName = `${uid}${extension}`
          const standardPath = path.join(this.profilesDir, standardName)
          
          // Move file to standard location if different
          if (file.localPath !== standardPath) {
            console.log(`Moving ${file.localPath} to ${standardPath}`)
            await fs.rename(file.localPath, standardPath)
          }
          
          profileMap[uid] = {
            uid: uid,
            filename: standardName,
            path: standardPath,
            originalName: file.originalName,
            size: file.size,
            extension: extension,
            downloaded_at: new Date().toISOString()
          }
          
          console.log(`✓ Organized profile for UID ${uid}: ${standardName}`)
        } else {
          console.warn(`Could not extract UID from filename: ${filename}`)
          // Clean up unrecognized files
          await fs.unlink(file.localPath).catch(() => {})
        }
      } catch (error) {
        console.error(`Error organizing file ${file.originalName}:`, error)
        // Try to clean up problematic files
        if (file.localPath) {
          await fs.unlink(file.localPath).catch(() => {})
        }
      }
    }

    console.log(`✓ Organized ${Object.keys(profileMap).length} profiles`)
    return profileMap
  }

  // IMPROVED: Enhanced download method with better error handling and progress tracking
  downloadFile(url, filePath, options = {}) {
    console.log(`Starting download from: ${url}`)
    console.log(`Saving to: ${filePath}`)
    
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http
      const { method = 'GET', headers = {}, body = null } = options

      const requestOptions = {
        method: method,
        headers: headers,
        timeout: 120000 // Increased to 120 second timeout for large files
      }

      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"))
          return
        }

        console.log(`Making ${method} request to: ${requestUrl}`)
        
        const req = client.request(requestUrl, requestOptions, (response) => {
          console.log(`Response status: ${response.statusCode}`)
          
          // Handle redirects
          if ([301, 302, 307, 308].includes(response.statusCode)) {
            const redirectUrl = response.headers.location
            if (!redirectUrl) {
              reject(new Error("Redirect without location header"))
              return
            }

            const fullRedirectUrl = redirectUrl.startsWith("http")
              ? redirectUrl
              : new URL(redirectUrl, requestUrl).toString()

            console.log(`Following redirect to: ${fullRedirectUrl}`)
            makeRequest(fullRedirectUrl, redirectCount + 1)
            return
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
            return
          }

          // Track download progress if content-length is available
          const contentLength = parseInt(response.headers['content-length'])
          let downloadedBytes = 0

          if (contentLength) {
            console.log(`Content length: ${contentLength} bytes`)
          }

          // Ensure directory exists for the file
          const fileDir = path.dirname(filePath)
          require('fs').mkdirSync(fileDir, { recursive: true })
          
          const fileStream = require("fs").createWriteStream(filePath)
          
          response.on('data', (chunk) => {
            downloadedBytes += chunk.length
            if (contentLength) {
              const progress = Math.round((downloadedBytes / contentLength) * 100)
              if (downloadedBytes % 1000000 < chunk.length) { // Log every MB
                console.log(`Download progress: ${progress}% (${downloadedBytes}/${contentLength} bytes)`)
              }
            }
          })

          response.pipe(fileStream)

          fileStream.on("finish", () => {
            fileStream.close()
            console.log(`✓ Download completed: ${filePath} (${downloadedBytes} bytes)`)
            resolve()
          })

          fileStream.on("error", (error) => {
            console.error("File stream error:", error)
            fs.unlink(filePath).catch(() => {}) // Clean up partial file
            reject(error)
          })
        })

        req.on("error", (error) => {
          console.error("Request error:", error)
          reject(error)
        })
        
        req.on("timeout", () => {
          console.error("Request timeout")
          req.destroy()
          reject(new Error("Request timeout"))
        })

        // Write body for POST requests
        if (body && method === 'POST') {
          const bodyData = typeof body === 'string' ? body : JSON.stringify(body)
          console.log(`Writing request body: ${bodyData.length} bytes`)
          req.write(bodyData)
        }

        req.end()
      }

      makeRequest(url)
    })
  }

  // NEW: Bulk download by department
  async bulkDownloadByDepartment(serverUrl, department, onProgress = null) {
    return this.bulkDownloadProfiles(serverUrl, {
      department: department,
      onProgress: onProgress
    })
  }

  // NEW: Bulk download by search query
  async bulkDownloadBySearch(serverUrl, searchQuery, onProgress = null) {
    return this.bulkDownloadProfiles(serverUrl, {
      search: searchQuery,
      onProgress: onProgress
    })
  }

  // NEW: Bulk download specific employees
  async bulkDownloadSpecificEmployees(serverUrl, employeeUids, onProgress = null) {
    return this.bulkDownloadProfiles(serverUrl, {
      uids: employeeUids,
      onProgress: onProgress
    })
  }

  getLocalProfilePath(uid) {
    const fs = require('fs');
    const path = require('path');
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    for (const ext of extensions) {
      const profilePath = path.join(this.profilesDir, `${uid}${ext}`);
      try {
        fs.accessSync(profilePath);
        return profilePath;
      } catch {
        // File doesn't exist, try next extension
      }
    }

    // Check if .jpeg exists before defaulting to .jpg
    const jpegPath = path.join(this.profilesDir, `${uid}.jpeg`);
    try {
      fs.accessSync(jpegPath);
      return jpegPath;
    } catch {
      // If .jpeg doesn't exist, return .jpg as default
      return path.join(this.profilesDir, `${uid}.jpg`);
    }
  }

  // UPDATED: Check if profile exists
  async profileExists(uid) {
    try {
      const profilePath = this.getLocalProfilePath(uid)
      await fs.access(profilePath)
      return true
    } catch {
      return false
    }
  }

  // FIXED: Better array handling and error recovery
  async checkProfileImages(employeeUids = []) {
    console.log("Checking profile images for UIDs:", employeeUids);
    console.log(`Using profiles directory: ${this.profilesDir}`);
    
    try {
      // Ensure profiles directory exists
      await this.ensureProfilesDirectory()
      
      // Ensure employeeUids is an array
      if (!Array.isArray(employeeUids)) {
        console.warn('employeeUids is not an array, converting...', typeof employeeUids, employeeUids)
        if (employeeUids == null || employeeUids === undefined) {
          employeeUids = []
        } else if (typeof employeeUids === 'number') {
          employeeUids = [employeeUids]
        } else if (typeof employeeUids === 'string') {
          // Try to parse as JSON array or comma-separated values
          try {
            const parsed = JSON.parse(employeeUids)
            employeeUids = Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            // If not JSON, try comma-separated
            employeeUids = employeeUids.split(',').map(uid => parseInt(uid.trim())).filter(uid => !isNaN(uid))
          }
        } else if (employeeUids[Symbol.iterator] && typeof employeeUids[Symbol.iterator] === 'function') {
          // Convert iterable to array
          employeeUids = Array.from(employeeUids)
        } else {
          employeeUids = []
        }
      }

      let downloadedCount = 0
      const downloaded = []
      const missing = []
      const profileDetails = {}

      console.log(`Checking ${employeeUids.length} UIDs in directory: ${this.profilesDir}`)

      for (const uid of employeeUids) {
        const exists = await this.profileExists(uid)
        if (exists) {
          downloadedCount++
          downloaded.push(uid)
          
          // Get additional details about the profile
          try {
            const profilePath = this.getLocalProfilePath(uid)
            const stats = await fs.stat(profilePath)
            profileDetails[uid] = {
              path: profilePath,
              size: stats.size,
              modified: stats.mtime.toISOString(),
              extension: path.extname(profilePath)
            }
          } catch (error) {
            console.warn(`Could not get details for profile ${uid}:`, error)
          }
        } else {
          missing.push(uid)
        }
      }

      const result = {
        success: true,
        downloaded: downloadedCount,
        total: employeeUids.length,
        percentage: employeeUids.length > 0 ? Math.round((downloadedCount / employeeUids.length) * 100) : 0,
        downloadedUids: downloaded,
        missingUids: missing,
        profileDetails: profileDetails,
        profilesDir: this.profilesDir
      }

      console.log("Profile check result:", result)
      return result
      
    } catch (error) {
      console.error("Error checking profile images:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0,
        percentage: 0,
        downloadedUids: [],
        missingUids: Array.isArray(employeeUids) ? employeeUids : [],
        profilesDir: this.profilesDir
      }
    }
  }

  // UPDATED: Get all locally stored profile images with enhanced info
  async checkAllProfileImages() {
    try {
      // Ensure profiles directory exists
      await this.ensureProfilesDirectory()
      
      console.log(`Checking all profiles in: ${this.profilesDir}`)
      
      const files = await fs.readdir(this.profilesDir)
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
      
      const profiles = []
      
      for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        if (imageExtensions.includes(ext)) {
          const filename = path.basename(file, ext)
          const uid = parseInt(filename)
          if (!isNaN(uid)) {
            try {
              const filePath = path.join(this.profilesDir, file)
              const stats = await fs.stat(filePath)
              
              profiles.push({
                uid: uid,
                filename: file,
                path: filePath,
                extension: ext,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                created: stats.birthtime.toISOString()
              })
            } catch (error) {
              console.warn(`Could not get stats for ${file}:`, error)
            }
          }
        }
      }
      
      // Sort by UID
      profiles.sort((a, b) => a.uid - b.uid)
      
      // Find oldest and newest profiles safely
      let oldestProfile = null
      let newestProfile = null
      
      if (profiles.length > 0) {
        oldestProfile = profiles.reduce((oldest, p) => 
          new Date(p.modified) < new Date(oldest.modified) ? p : oldest
        )
        newestProfile = profiles.reduce((newest, p) => 
          new Date(p.modified) > new Date(newest.modified) ? p : newest
        )
      }
      
      return {
        success: true,
        downloaded: profiles.length,
        profiles: profiles,
        totalSize: profiles.reduce((sum, p) => sum + p.size, 0),
        oldestProfile: oldestProfile,
        newestProfile: newestProfile,
        profilesDir: this.profilesDir
      }
    } catch (error) {
      console.error("Error checking all profile images:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        profiles: [],
        profilesDir: this.profilesDir
      }
    }
  }

  // Legacy method for individual downloads (kept for backward compatibility but discouraged)
  async downloadAndStoreProfile(uid, serverUrl) {
    console.warn(`Individual profile download for UID ${uid} - Consider using bulk download instead`)
    console.log(`Target directory: ${this.profilesDir}`)
    
    try {
      // Ensure profiles directory exists
      await this.ensureProfilesDirectory()
      
      const profileUrl = `${serverUrl}/api/profile/${uid}`
      const profilePath = this.getLocalProfilePath(uid)

      // Check if profile already exists
      try {
        await fs.access(profilePath)
        console.log(`Profile for UID ${uid} already exists at: ${profilePath}`)
        return profilePath
      } catch {
        // Profile doesn't exist, download it
      }

      await this.downloadFile(profileUrl, profilePath)
      console.log(`Downloaded individual profile for UID ${uid} to: ${profilePath}`)
      return profilePath
    } catch (error) {
      console.error(`Error downloading profile for employee ${uid}:`, error)
      return null
    }
  }

  // NEW: Clean up orphaned or corrupted profile files
  async cleanupProfiles() {
    try {
      console.log(`Starting profile cleanup in: ${this.profilesDir}`)
      
      const files = await fs.readdir(this.profilesDir)
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
      let cleanedCount = 0
      const errors = []

      for (const file of files) {
        try {
          const ext = path.extname(file).toLowerCase()
          const filename = path.basename(file, ext)
          
          // Check if it's an image file
          if (imageExtensions.includes(ext)) {
            const uid = parseInt(filename)
            const filePath = path.join(this.profilesDir, file)
            
            // Check if UID is valid
            if (isNaN(uid)) {
              console.log(`Removing file with invalid UID: ${file}`)
              await fs.unlink(filePath)
              cleanedCount++
              continue
            }
            
            // Check if file is corrupted (0 bytes)
            const stats = await fs.stat(filePath)
            if (stats.size === 0) {
              console.log(`Removing empty file: ${file}`)
              await fs.unlink(filePath)
              cleanedCount++
              continue
            }
          }
        } catch (error) {
          errors.push({ file, error: error.message })
        }
      }

      console.log(`✓ Profile cleanup completed: ${cleanedCount} files cleaned`)

      return {
        success: true,
        cleaned: cleanedCount,
        errors: errors,
        profilesDir: this.profilesDir
      }
    } catch (error) {
      console.error("Error during cleanup:", error)
      return {
        success: false,
        error: error.message,
        cleaned: 0,
        errors: [],
        profilesDir: this.profilesDir
      }
    }
  }

  // UPDATED: Get profiles directory info for debugging
  getProfilesDirectoryInfo() {
    const isDev = process.env.NODE_ENV === "development" || process.argv.includes("--dev")
    return {
      path: this.profilesDir,
      isDev: isDev,
      exists: require('fs').existsSync(this.profilesDir),
      userDataPath: app.getPath('userData')
    }
  }
}

module.exports = new ProfileService()