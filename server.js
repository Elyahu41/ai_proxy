import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const APP_SECRET = process.env.APP_SECRET || null;

app.use((req, res, next) => {
  if (APP_SECRET && req.headers.authorization !== `Bearer ${APP_SECRET}`) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "awake", message: "AI Proxy Server is running ✅" });
});


app.post("/ask", async (req, res) => {
  try {
    const { provider = "openai", prompt, model, messages } = req.body;

    if (!prompt && !messages)
      return res.status(400).json({ error: "Missing prompt or messages" });

    let responseText = "";

    switch (provider.toLowerCase()) {
      // OPENAI / ChatGPT
      case "openai": {
        const result = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: model || "gpt-4o-mini",
            messages: messages || [{ role: "user", content: prompt }],
          }),
        });

        const data = await result.json();
        responseText = data.choices?.[0]?.message?.content || JSON.stringify(data);
        break;
      }

      // GOOGLE GEMINI
      case "gemini": {
        const result = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-2.0-flash"}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          }
        );

        const data = await result.json();
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
        break;
      }

      // ANTHROPIC CLAUDE
      case "claude": {
        const result = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        const data = await result.json();
        responseText = data.content?.[0]?.text || JSON.stringify(data);
        break;
      }

      // MISTRAL AI
      case "mistral": {
        const result = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`,
          },
          body: JSON.stringify({
            model: model || "mistral-small-latest",
            messages: messages || [{ role: "user", content: prompt }],
          }),
        });

        const data = await result.json();
        responseText = data.choices?.[0]?.message?.content || JSON.stringify(data);
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    res.json({ answer: responseText });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Render uses PORT env variable automatically
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ AI proxy running on port ${PORT}`));


