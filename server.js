import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json({ limit: '10mb' }));

const APP_SECRET = process.env.APP_SECRET || null;

// ---- Response helpers -------------------------------------------------------
// Newer models can return thinking/reasoning blocks before the answer, so never assume
// the answer is the first block. If no text comes back, report an error instead of
// sending the raw JSON as the "answer" (apps would try to parse numbers out of it).
class UpstreamError extends Error {
  constructor(provider, status, data) {
    super(`${provider} returned no text (HTTP ${status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
    this.status = 502;
  }
}

function openAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => p?.text || "").join("");
  return "";
}

function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("");
}

function claudeText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter(b => b.type === "text").map(b => b.text).join("");
}

async function readText(provider, result, extract) {
  const data = await result.json();
  const text = (extract(data) || "").trim();
  if (!result.ok || !text) throw new UpstreamError(provider, result.status, data);
  return text;
}

app.get("/", (req, res) => {
  res.json({ status: "awake", message: "AI Proxy Server is running ✅" });
});

app.use((req, res, next) => {
  if (APP_SECRET && req.headers.authorization !== `Bearer ${APP_SECRET}`) {
    console.warn("Unauthorized request blocked:", req.method, req.path);
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/ask", async (req, res) => {
  try {
    const { provider = "openai", prompt, model, messages } = req.body;

    if (!prompt && !messages)
      return res.status(400).json({ error: "Missing prompt or messages" });

    console.log("Received Prompt from user:")
    console.log("Provider:", provider);
    console.log(prompt);
    console.log("--------------------------------------------------");

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
            model: model || "gpt-5.4-mini",
            messages: messages || [{ role: "user", content: prompt }],
          }),
        });

        responseText = await readText("openai", result, openAIText);
        break;
      }

      // GOOGLE GEMINI
      case "gemini": {
        const result = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-3.5-flash-lite"}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
          }
        );

        responseText = await readText("gemini", result, geminiText);
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
            model: model || "claude-haiku-5-5",
            // Current Claude models think before answering; leave room for that plus the answer
            max_tokens: 8000,
            messages: messages || [{ role: "user", content: prompt }],
          }),
        });

        responseText = await readText("claude", result, claudeText);
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

        responseText = await readText("mistral", result, openAIText);
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }

    console.log("responded with this text:");
    console.log(responseText);
    console.log("--------------------------------------------------");

    res.json({ answer: responseText });
  } catch (err) {
    console.error("Error:", err);
    res.status(err.status || 500).json({ error: err.status ? "Upstream error" : "Server error", details: err.message });
  }
});

app.post("/analyze-image", async (req, res) => {
  console.log("Received Prompt from user for image analysis");
  console.log("--------------------------------------------------");
  try {
    const {
      provider = "gemini",
      model,
      imageBase64,
      mimeType = "image/jpeg",
      prompt = "Please analyze the image and provide a detailed description of its content."
    } = req.body;
    console.log("Provider:", provider);
    console.log("Model:", model);
    console.log("--------------------------------------------------");

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    console.log("Image analysis request — Provider:", provider);

    let responseText = "";

    switch (provider.toLowerCase()) {

      case "gemini": {
        const result = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-3.1-flash-lite"}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: mimeType, data: imageBase64 } }
                ]
              }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingBudget: 0 }
              }
            }),
          }
        );
        responseText = await readText("gemini", result, geminiText);
        break;
      }

      case "openai": {
        const result = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: model || "gpt-5.4-mini",
            max_completion_tokens: 2048,
            messages: [{
              role: "user", content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
              ]
            }],
          }),
        });
        responseText = await readText("openai", result, openAIText);
        break;
      }

      case "claude": {
        const result = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-haiku-5-5",
            max_tokens: 4000,
            messages: [{
              role: "user", content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
                { type: "text", text: prompt }
              ]
            }],
          }),
        });
        responseText = await readText("claude", result, claudeText);
        break;
      }

      default:
        return res.status(400).json({ error: `Unsupported provider: ${provider}. Use gemini, openai, or claude.` });
    }

    console.log("Image analysis response:");
    console.log(responseText);
    console.log("--------------------------------------------------");

    res.json({ answer: responseText });

  } catch (err) {
    console.error("Error:", err);
    res.status(err.status || 500).json({ error: err.status ? "Upstream error" : "Server error", details: err.message });
  }
});

// Render uses PORT env variable automatically
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ AI proxy running on port ${PORT}`));