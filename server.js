import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json({ limit: '10mb' }));

const APP_SECRET = process.env.APP_SECRET || null;

app.use((req, res, next) => {
  if (APP_SECRET && req.headers.authorization !== `Bearer ${APP_SECRET}`) {
    console.warn("Unauthorized request blocked:", req.method, req.path);
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

    console.log("responded with this text:");
    console.log(responseText);
    console.log("--------------------------------------------------");

    res.json({ answer: responseText });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
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
      prompt =
      `You are a professional nutritionist AI. Carefully analyze this food image.

Return ONLY a valid JSON object — no markdown fences, no explanation, nothing else.
Use this exact structure:

{
  "food_name": "Cheeseburger with fries",
  "total_calories": 850,
  "serving_size": "1 burger + medium fries (~450g)",
  "confidence": "high",
  "macros": {
    "protein_g": 32,
    "carbs_g": 95,
    "fat_g": 38
  },
  "food_items": ["cheeseburger", "french fries"],
  "notes": "Standard fast-food portion estimate"
}

Rules:
- confidence must be one of: "high", "medium", "low"
- All numeric values must be plain integers (no decimals)
- If no food is visible or identifiable, set total_calories to -1
- food_items should list each distinct food item visible
- Return ONLY the JSON object, nothing else`
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
          `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-3.5-flash"}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: imageBase64 } }
              ]}],
              generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
            }),
          }
        );
        const data = await result.json();
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
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
            model: model || "gpt-4o-mini",
            max_tokens: 512,
            messages: [{ role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
            ]}],
          }),
        });
        const data = await result.json();
        responseText = data.choices?.[0]?.message?.content || JSON.stringify(data);
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
            model: model || "claude-3-haiku-20240307",
            max_tokens: 512,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
              { type: "text", text: prompt }
            ]}],
          }),
        });
        const data = await result.json();
        responseText = data.content?.[0]?.text || JSON.stringify(data);
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
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Render uses PORT env variable automatically
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ AI proxy running on port ${PORT}`));



