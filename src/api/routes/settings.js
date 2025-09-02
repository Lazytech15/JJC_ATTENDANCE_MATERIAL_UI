const { getDatabase } = require("../../database/setup")

async function getSettings() {
  try {
    const db = getDatabase()
    const stmt = db.prepare("SELECT key, value FROM settings")
    const rows = stmt.all()

    const settings = {}
    rows.forEach((row) => {
      settings[row.key] = row.value
    })

    return { success: true, data: settings }
  } catch (error) {
    console.error("Error getting settings:", error)
    return { success: false, error: error.message }
  }
}

async function updateSettings(event, settings) {
  try {
    const db = getDatabase()
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")

    const transaction = db.transaction((settings) => {
      for (const [key, value] of Object.entries(settings)) {
        stmt.run(key, value)
      }
    })

    transaction(settings)

    return { success: true, message: "Settings updated successfully" }
  } catch (error) {
    console.error("Error updating settings:", error)
    return { success: false, error: error.message }
  }
}

module.exports = {
  getSettings,
  updateSettings,
}
