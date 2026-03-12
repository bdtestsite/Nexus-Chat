import { readFileSync } from "fs";
import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("nexus.db");

// Initialize Database
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      avatar TEXT,
      role TEXT DEFAULT 'user',
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Robust Migration Helper
  const addColumnIfNotExists = (table: string, column: string, type: string) => {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!info.find(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`Added column ${column} to ${table}`);
    }
  };

  addColumnIfNotExists('users', 'password', 'TEXT');
  addColumnIfNotExists('users', 'role', "TEXT DEFAULT 'user'");
  addColumnIfNotExists('users', 'avatar', 'TEXT');
  addColumnIfNotExists('messages', 'is_read', 'INTEGER DEFAULT 0');

  // Ensure Nexus AI bot exists
  const aiBot = db.prepare("SELECT * FROM users WHERE id = ?").get('nexus-ai-bot');
  if (!aiBot) {
    db.prepare("INSERT INTO users (id, username, password, avatar, role) VALUES (?, ?, ?, ?, ?)")
      .run('nexus-ai-bot', 'Nexus AI', 'AI_BOT_SECRET_NO_LOGIN', 'https://api.dicebear.com/7.x/bottts/svg?seed=NexusAI', 'user');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      receiver_id TEXT,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT DEFAULT 'text'
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT,
      user_id TEXT,
      emoji TEXT,
      PRIMARY KEY (message_id, user_id)
    );
  `);
} catch (err) {
  console.error("Database initialization failed:", err);
}

async function startServer() {
  console.log("Starting server with NODE_ENV:", process.env.NODE_ENV);
  const app = express();
  const PORT = 3000;

  // WebSocket Server setup (early to be available for routes)
  const clients = new Map<string, WebSocket>();

  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", clients: clients.size });
  });

  // API Routes
  app.get("/api/users", (req, res) => {
    try {
      const users = db.prepare("SELECT * FROM users").all() as any[];
      const usersWithStatus = users.map(user => ({
        ...user,
        isOnline: clients.has(user.id)
      }));
      res.json(usersWithStatus);
    } catch (err) {
      console.error("Error in /api/users:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    const { username, password, avatar, roleSecret } = req.body;
    console.log(`Registration attempt for: ${username}`);
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    
    try {
      // Check if user exists
      const existingUser = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
      
      if (existingUser) {
        if (!existingUser.password) {
          // User was created by old system without password, update it
          // Also set role if it's missing
          const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
          const role = existingUser.role || ((userCount === 1 || roleSecret === "OWNER_SECRET_123") ? 'owner' : 'user');
          
          db.prepare("UPDATE users SET password = ?, avatar = ?, role = ? WHERE id = ?").run(password, avatar, role, existingUser.id);
          console.log(`Updated existing user ${username} with password and role: ${role}`);
          return res.json({ id: existingUser.id, username, avatar, role });
        } else {
          return res.status(400).json({ error: "Username already exists. Please login instead." });
        }
      }

      // First user becomes owner, or if roleSecret matches
      const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
      const role = (userCount === 0 || roleSecret === "OWNER_SECRET_123") ? 'owner' : 'user';

      const id = uuidv4();
      db.prepare("INSERT INTO users (id, username, password, avatar, role) VALUES (?, ?, ?, ?, ?)").run(id, username, password, avatar, role);
      console.log(`User registered: ${username} as ${role}`);
      res.json({ id, username, avatar, role });
    } catch (e) {
      console.error("Registration error:", e);
      res.status(400).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    console.log(`Login attempt for: ${username}`);
    try {
      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
      
      if (!user) {
        return res.status(401).json({ error: "User not found. Please register first." });
      }

      if (!user.password) {
        return res.status(401).json({ error: "This account was created in an older version. Please use 'Create an account' with the same username to set a password." });
      }

      if (user.password !== password) {
        return res.status(401).json({ error: "Invalid password" });
      }

      console.log(`User logged in: ${username}`);
      res.json({ id: user.id, username: user.username, avatar: user.avatar, role: user.role });
    } catch (e) {
      console.error("Login error:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/users/profile", (req, res) => {
    const { userId, avatar } = req.body;
    try {
      db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(avatar, userId);
      res.json({ success: true, avatar });
    } catch (e) {
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Admin endpoint: Delete user (Owner only)
  app.delete("/api/admin/users/:id", (req, res) => {
    const { id } = req.params;
    const { adminId } = req.body;
    
    const admin = db.prepare("SELECT role FROM users WHERE id = ?").get(adminId) as any;
    if (!admin || admin.role !== 'owner') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?").run(id, id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  app.get("/api/messages/:userId/:otherId", (req, res) => {
    const { userId, otherId } = req.params;
    
    try {
      // Mark messages as read when fetching them
      db.prepare("UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0").run(otherId, userId);
      
      const messages = db.prepare(`
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
        OR (sender_id = ? AND receiver_id = ?)
        ORDER BY timestamp ASC
      `).all(userId, otherId, otherId, userId) as any[];

    // Fetch reactions for these messages
    const messageIds = messages.map(m => m.id);
    if (messageIds.length > 0) {
      const placeholders = messageIds.map(() => '?').join(',');
      const reactions = db.prepare(`
        SELECT * FROM message_reactions 
        WHERE message_id IN (${placeholders})
      `).all(...messageIds) as any[];

      // Attach reactions to messages
      messages.forEach(msg => {
        msg.reactions = reactions.filter(r => r.message_id === msg.id);
      });
    }

    res.json(messages);
    } catch (e) {
      console.error("Error fetching messages:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    // Fallback to index.html for SPA
    app.get('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // WebSocket Server
  const wss = new WebSocketServer({ server });

  const broadcastStatus = (userId: string, isOnline: boolean) => {
    const statusMsg = JSON.stringify({
      type: "status-update",
      userId,
      isOnline
    });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(statusMsg);
      }
    });
  };

  wss.on("connection", (ws) => {
    let currentUserId: string | null = null;

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case "auth":
          currentUserId = message.userId;
          clients.set(currentUserId!, ws);
          db.prepare("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(currentUserId);
          console.log(`User ${currentUserId} connected`);
          broadcastStatus(currentUserId!, true);
          break;

        case "chat":
          const msgId = uuidv4();
          const msgType = message.msgType || 'text';
          db.prepare("INSERT INTO messages (id, sender_id, receiver_id, content, type) VALUES (?, ?, ?, ?, ?)")
            .run(msgId, message.senderId, message.receiverId, message.content, msgType);
          
          const chatMsg = {
            type: "chat",
            id: msgId,
            senderId: message.senderId,
            receiverId: message.receiverId,
            content: message.content,
            timestamp: new Date().toISOString(),
            reactions: [],
            is_read: 0,
            msgType: msgType
          };

          // Send to receiver if online
          const receiverWs = clients.get(message.receiverId);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify(chatMsg));
          }
          // Echo back to sender for confirmation
          ws.send(JSON.stringify(chatMsg));
          break;

        case "reaction":
          const { messageId, userId, emoji, targetId } = message;
          try {
            // Upsert reaction
            const existing = db.prepare("SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ?").get(messageId, userId) as any;
            if (existing && existing.emoji === emoji) {
              // Remove if same emoji (toggle)
              db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?").run(messageId, userId);
            } else {
              db.prepare("INSERT OR REPLACE INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)").run(messageId, userId, emoji);
            }

            const reactionUpdate = JSON.stringify({
              type: "reaction-update",
              messageId,
              userId,
              emoji,
              // Send the full list of reactions for this message to keep clients synced
              reactions: db.prepare("SELECT * FROM message_reactions WHERE message_id = ?").all(messageId)
            });

            // Notify both parties
            clients.get(userId)?.send(reactionUpdate);
            clients.get(targetId)?.send(reactionUpdate);
          } catch (err) {
            console.error("Reaction error:", err);
          }
          break;

        case "read-receipt":
          try {
            const { senderId, userId: receiverId } = message;
            db.prepare("UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0").run(senderId, receiverId);
            
            const readUpdate = JSON.stringify({
              type: "read-update",
              senderId,
              receiverId
            });

            clients.get(senderId)?.send(readUpdate);
          } catch (e) {
            console.error("Read receipt error:", e);
          }
          break;

        case "typing":
          const targetTypingWs = clients.get(message.targetId);
          if (targetTypingWs && targetTypingWs.readyState === WebSocket.OPEN) {
            targetTypingWs.send(JSON.stringify({
              type: "typing",
              senderId: message.senderId,
              isTyping: message.isTyping
            }));
          }
          break;

        case "signal":
          // WebRTC Signaling (offer, answer, candidate)
          const targetWs = clients.get(message.targetId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: "signal",
              senderId: message.senderId,
              data: message.data,
              signalType: message.signalType
            }));
          }
          break;
        
        case "call-request":
          const calleeWs = clients.get(message.targetId);
          if (calleeWs && calleeWs.readyState === WebSocket.OPEN) {
            calleeWs.send(JSON.stringify({
              type: "call-request",
              senderId: message.senderId,
              callType: message.callType // 'audio' or 'video'
            }));
          }
          break;

        case "call-response":
          const callerWs = clients.get(message.targetId);
          if (callerWs && callerWs.readyState === WebSocket.OPEN) {
            callerWs.send(JSON.stringify({
              type: "call-response",
              senderId: message.senderId,
              accepted: message.accepted
            }));
          }
          break;
      }
    });

    ws.on("close", () => {
      if (currentUserId) {
        clients.delete(currentUserId);
        db.prepare("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?").run(currentUserId);
        console.log(`User ${currentUserId} disconnected`);
        broadcastStatus(currentUserId, false);
      }
    });
  });
}

startServer();
