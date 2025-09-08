const fs = require("fs").promises
const path = require("path")
const https = require("https")
const http = require("http")

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

  async downloadAndStoreProfile(uid, serverUrl) {
    try {
      const profileUrl = `${serverUrl}/api/profile/${uid}`
      const profilePath = path.join(this.profilesDir, `${uid}.jpg`)

      // Check if profile already exists
      try {
        await fs.access(profilePath)
        return profilePath // Profile already exists
      } catch {
        // Profile doesn't exist, download it
      }

      await this.downloadFile(profileUrl, profilePath)
      return profilePath
    } catch (error) {
      console.error(`Error downloading profile for employee ${uid}:`, error)
      return null
    }
  }

  // NEW METHOD: Check how many profile images are downloaded
  async checkProfileImages(employeeUids = []) {
    try {
      let downloadedCount = 0
      const total = employeeUids.length

      // Check each employee UID to see if their profile image exists locally
      for (const uid of employeeUids) {
        const exists = await this.profileExists(uid)
        if (exists) {
          downloadedCount++
        }
      }

      return {
        success: true,
        downloaded: downloadedCount,
        total: total,
        missing: employeeUids.filter(async uid => !(await this.profileExists(uid)))
      }
    } catch (error) {
      console.error("Error checking profile images:", error)
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        total: 0
      }
    }
  }

  // Alternative method if you want to scan the directory instead of checking specific UIDs
  async checkAllProfileImages() {
    try {
      const files = await fs.readdir(this.profilesDir)
      const profileImages = files.filter(file => file.endsWith('.jpg'))
      
      return {
        success: true,
        downloaded: profileImages.length,
        profiles: profileImages.map(file => file.replace('.jpg', '')) // Return UIDs
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

  downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http

      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"))
          return
        }

        client
          .get(requestUrl, (response) => {
            // Handle redirects (301, 302, 307, 308)
            if ([301, 302, 307, 308].includes(response.statusCode)) {
              const redirectUrl = response.headers.location
              if (!redirectUrl) {
                reject(new Error("Redirect without location header"))
                return
              }

              // Handle relative URLs
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

            const fileStream = require("fs").createWriteStream(filePath)
            response.pipe(fileStream)

            fileStream.on("finish", () => {
              fileStream.close()
              resolve()
            })

            fileStream.on("error", (error) => {
              fs.unlink(filePath).catch(() => {}) // Clean up partial file
              reject(error)
            })
          })
          .on("error", reject)
      }

      makeRequest(url)
    })
  }

  getLocalProfilePath(uid) {
    const profilePath = path.join(this.profilesDir, `${uid}.jpg`)
    return profilePath
  }

  async profileExists(uid) {
    try {
      const profilePath = this.getLocalProfilePath(uid)
      await fs.access(profilePath)
      return true
    } catch {
      return false
    }
  }
}

module.exports = new ProfileService()