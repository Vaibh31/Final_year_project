/**
 * Brainify AI Proxy Worker (Final Stable Version)
 * Handles GET (pings), OPTIONS (CORS), and POST (AI).
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-skip-sw",
};

export default {
  async fetch(request, env) {
    // 1. Handle Browser "Ping" (GET)
    if (request.method === "GET") {
      return new Response("Brainify Worker is ALIVE and READY! (Use POST for AI responses)", {
        status: 200,
        headers: { "Content-Type": "text/plain", ...CORS_HEADERS }
      });
    }

    // 2. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // 3. Process AI Request (POST)
    try {
      const body = await request.json().catch(() => ({}));
      const { messages } = body;

      if (!messages || !Array.isArray(messages)) {
        return new Response(JSON.stringify({ reply: "Error: No messages provided in request body." }), {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      // Call Groq API
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GROQ_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: messages,
          temperature: 0.7,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error?.message || "Unknown Groq Error";
        return new Response(JSON.stringify({ reply: `Error: Groq API said: ${errorMsg}` }), {
          status: response.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      const reply = data.choices?.[0]?.message?.content || "Error: Groq returned no content choices.";

      return new Response(JSON.stringify({ reply }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ reply: `Error: Worker Internal Failure: ${err.message}` }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }
  },
};
