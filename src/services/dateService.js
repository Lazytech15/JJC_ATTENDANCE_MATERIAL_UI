class DateService {
  constructor() {
    this.lastValidDate = null
    this.dateOffset = 0
  }

  getCurrentDate() {
    const systemDate = new Date()
    // Use local date string format YYYY-MM-DD
    const currentDateString =
      systemDate.getFullYear() +
      "-" +
      String(systemDate.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(systemDate.getDate()).padStart(2, "0")

    // Initialize on first run
    if (!this.lastValidDate) {
      this.lastValidDate = currentDateString
      return currentDateString
    }

    // Check if date went backward
    if (currentDateString < this.lastValidDate) {
      console.warn(
        `[DateService] System date went backward from ${this.lastValidDate} to ${currentDateString}. Using last valid date.`,
      )
      return this.lastValidDate
    }

    // Update last valid date if moving forward
    this.lastValidDate = currentDateString
    return currentDateString
  }

  getCurrentDateTime() {
    const now = new Date()
    const currentDate = this.getCurrentDate()

    // Get system local date string
    const systemDateString =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0")

    if (currentDate !== systemDateString) {
      // System date went backward, create new date with cached date and current local time
      const hours = now.getHours()
      const minutes = now.getMinutes()
      const seconds = now.getSeconds()
      const milliseconds = now.getMilliseconds()

      const [year, month, day] = currentDate.split("-").map(Number)
      const localDateTime = new Date(year, month - 1, day, hours, minutes, seconds, milliseconds)
      return this.formatLocalDateTime(localDateTime)
    }

    return this.formatLocalDateTime(now)
  }

  isDateChangeValid(newDate) {
    if (!this.lastValidDate) return true

    const timeDiff = new Date(newDate) - new Date(this.lastValidDate)
    const daysDiff = timeDiff / (1000 * 60 * 60 * 24)

    // Allow forward movement or same day, but warn on backward movement
    if (daysDiff < 0) {
      console.warn(`[DateService] Date moved backward by ${Math.abs(daysDiff)} days`)
      return false
    }

    return true
  }

  forceUpdateDate(newDate) {
    console.log(`[DateService] Manually updating date to ${newDate}`)
    this.lastValidDate = newDate
  }

  reset() {
    this.lastValidDate = null
    this.dateOffset = 0
  }

  formatLocalDateTime(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    const hours = String(date.getHours()).padStart(2, "0")
    const minutes = String(date.getMinutes()).padStart(2, "0")
    const seconds = String(date.getSeconds()).padStart(2, "0")
    const milliseconds = String(date.getMilliseconds()).padStart(3, "0")

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}`
  }
}

// Singleton instance
const dateService = new DateService()

module.exports = dateService
