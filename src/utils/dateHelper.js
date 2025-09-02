function formatDate(date) {
  return date.toISOString().split("T")[0]
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDateTime(date) {
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function isToday(date) {
  const today = new Date()
  const checkDate = new Date(date)
  return formatDate(today) === formatDate(checkDate)
}

function getWorkingHours() {
  return {
    start: 8, // 8:00 AM
    end: 17, // 5:00 PM
    lunchStart: 12, // 12:00 PM
    lunchEnd: 13, // 1:00 PM
  }
}

module.exports = {
  formatDate,
  formatTime,
  formatDateTime,
  isToday,
  getWorkingHours,
}
