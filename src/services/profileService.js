const fs = require("fs").promises
const path = require("path")
const https = require("https")
const http = require("http")
const yauzl = require("yauzl") 
const { pipeline } = require('stream/promises')

class ProfileService {
  constructor() {
    this.profilesDir = path.join(__dirname, "../renderer/profiles")
    this.ensureProfilesDirectory()
  }

  async ensureProfilesDirectory() {
    try {
      await fs.mkdir(this.profilesDir, { recursive: true })
    } catch (error) {
      console.error("Error creating profiles directory:", error)
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

      if (onProgress) {
        onProgress({ 
          stage: 'initializing', 
          message: 'Preparing bulk download...',
          total: uids.length || 'all'
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
            message: 'Downloading all profiles matching filters...',
            filters: { department, search }
          })
        }
      }

      // Download the ZIP file
      const timestamp = Date.now()
      const zipPath = path.join(this.profilesDir, `bulk_profiles_${timestamp}.zip`)
      
      await this.downloadFile(downloadUrl, zipPath, requestOptions)

      if (onProgress) {
        onProgress({ 
          stage: 'downloaded', 
          message: 'ZIP file downloaded successfully, extracting...' 
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
        total: 0
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
    return new Promise((resolve, reject) => {
      const extractedFiles = []
      let isFinalized = false

      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(err)
          return
        }

        zipfile.readEntry()

        zipfile.on("entry", (entry) => {
          // Skip directories
          if (/\/$/.test(entry.fileName)) {
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
            const writeStream = require('fs').createWriteStream(outputPath)

            readStream.pipe(writeStream)

            writeStream.on('close', () => {
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
          if (!isFinalized) {
            isFinalized = true
            resolve(extractedFiles)
          }
        })

        zipfile.on("error", (error) => {
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

    for (const file of extractedFiles) {
      try {
        // Skip summary file
        if (file.originalName === 'download_summary.json') {
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
          
          console.log(`Organized profile for UID ${uid}: ${standardName}`)
        } else {
          console.warn(`Could not extract UID from filename: ${filename}`)
          // Clean up unrecognized files
          await fs.unlink(file.localPath).catch(() => {})
        }
      } catch (error) {
        console.warn(`Error organizing file ${file.originalName}:`, error)
        // Try to clean up problematic files
        if (file.localPath) {
          await fs.unlink(file.localPath).catch(() => {})
        }
      }
    }

    return profileMap
  }

  // IMPROVED: Enhanced download method with better error handling and progress tracking
  downloadFile(url, filePath, options = {}) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http
      const { method = 'GET', headers = {}, body = null } = options

      const requestOptions = {
        method: method,
        headers: headers,
        timeout: 60000 // 60 second timeout
      }

      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"))
          return
        }

        const req = client.request(requestUrl, requestOptions, (response) => {
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

          const fileStream = require("fs").createWriteStream(filePath)
          
          response.on('data', (chunk) => {
            downloadedBytes += chunk.length
            if (contentLength) {
              const progress = Math.round((downloadedBytes / contentLength) * 100)
              // Could emit progress events here if needed
            }
          })

          response.pipe(fileStream)

          fileStream.on("finish", () => {
            fileStream.close()
            console.log(`Download completed: ${filePath} (${downloadedBytes} bytes)`)
            resolve()
          })

          fileStream.on("error", (error) => {
            fs.unlink(filePath).catch(() => {}) // Clean up partial file
            reject(error)
          })
        })

        req.on("error", reject)
        req.on("timeout", () => {
          req.destroy()
          reject(new Error("Request timeout"))
        })

        // Write body for POST requests
        if (body && method === 'POST') {
          req.write(typeof body === 'string' ? body : JSON.stringify(body))
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

  // UPDATED: Get local profile path for a specific UID (unchanged but improved logging)
  getLocalProfilePath(uid) {
    // Check for different extensions
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']
    
    for (const ext of extensions) {
      const profilePath = path.join(this.profilesDir, `${uid}${ext}`)
      try {
        require('fs').accessSync(profilePath)
        return profilePath
      } catch {
        // File doesn't exist, try next extension
      }
    }
    
    // Return default path if none found
    return path.join(this.profilesDir, `${uid}.jpg`)
  }

  // UPDATED: Check if profile exists (unchanged)
  async profileExists(uid) {
    try {
      const profilePath = this.getLocalProfilePath(uid)
      await fs.access(profilePath)
      return true
    } catch {
      return false
    }
  }

    async checkProfileImages(employeeUids = []) {
      console.log(employeeUids);
    try {
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
              modified: stats.mtime.toISOString(), // Convert Date to string
              extension: path.extname(profilePath)
            }
          } catch (error) {
            console.warn(`Could not get details for profile ${uid}:`, error)
          }
        } else {
          missing.push(uid)
        }
      }

      return {
        success: true,
        downloaded: downloadedCount,
        total: employeeUids.length,
        percentage: employeeUids.length > 0 ? Math.round((downloadedCount / employeeUids.length) * 100) : 0,
        downloadedUids: downloaded,
        missingUids: missing,
        profileDetails: profileDetails
      }
    } catch (error) {
      console.error("Error checking profile images:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0,
        percentage: 0,
        downloadedUids: [],
        missingUids: Array.isArray(employeeUids) ? employeeUids : []
      }
    }
  }

  // UPDATED: Get all locally stored profile images with enhanced info
   async checkAllProfileImages() {
    try {
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
                modified: stats.mtime.toISOString(), // Convert Date to string
                created: stats.birthtime.toISOString() // Convert Date to string
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
        newestProfile: newestProfile
      }
    } catch (error) {
      console.error("Error checking all profile images:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        profiles: []
      }
    }
  }

  // Legacy method for individual downloads (kept for backward compatibility but discouraged)
  async downloadAndStoreProfile(uid, serverUrl) {
    console.warn(`Individual profile download for UID ${uid} - Consider using bulk download instead`)
    
    try {
      const profileUrl = `${serverUrl}/api/profile/${uid}`
      const profilePath = this.getLocalProfilePath(uid)

      // Check if profile already exists
      try {
        await fs.access(profilePath)
        console.log(`Profile for UID ${uid} already exists`)
        return profilePath
      } catch {
        // Profile doesn't exist, download it
      }

      await this.downloadFile(profileUrl, profilePath)
      console.log(`Downloaded individual profile for UID ${uid}`)
      return profilePath
    } catch (error) {
      console.error(`Error downloading profile for employee ${uid}:`, error)
      return null
    }
  }

  // NEW: Clean up orphaned or corrupted profile files
  async cleanupProfiles() {
    try {
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

      return {
        success: true,
        cleaned: cleanedCount,
        errors: errors
      }
    } catch (error) {
      console.error("Error during cleanup:", error)
      return {
        success: false,
        error: error.message,
        cleaned: 0,
        errors: []
      }
    }
  }
}

module.exports = new ProfileService()