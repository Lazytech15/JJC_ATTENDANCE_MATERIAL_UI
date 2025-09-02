const WebSocket = require("ws")
const { getDatabase } = require("../database/setup")

let wss
const clients = new Set()

function startWebSocketServer() {
  wss = new WebSocket.Server({ port: 8080 })

  wss.on("connection", (ws) => {
    clients.add(ws)
    console.log("WebSocket client connected")

    ws.on("close", () => {
      clients.delete(ws)
      console.log("WebSocket client disconnected")
    })

    ws.on("error", (error) => {
      console.error("WebSocket error:", error)
      clients.delete(ws)
    })
  })

  console.log("WebSocket server started on port 8080")
}

function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() })

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message)
      } catch (error) {
        console.error("Error sending WebSocket message:", error)
        clients.delete(client)
      }
    }
  })
}

module.exports = {
  startWebSocketServer,
  broadcastUpdate,
}
