/**
 * Gemini Live API - Ephemeral Token Generator
 * Creates secure short-lived tokens for client-side WebSocket connections.
 *
 * Endpoint: POST /api/gemini-ephemeral-token
 *
 * SECURITY: The server-side API key is NEVER returned to the client.
 * Instead, we call Google's newEphemeralToken endpoint to produce a
 * short-lived token that the client can use for its WebSocket session.
 *
 * @see https://ai.google.dev/gemini-api/docs/ephemeral-tokens
 */

const DEFAULT_MODEL = 'gemini-2.5-flash-preview-native-audio-dialog';
const EPHEMERAL_TOKEN_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent';

// Rotate through multiple API keys
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(Boolean);

let keyIndex = 0;

function getNextKey() {
  if (API_KEYS.length === 0) {
    throw new Error('No Gemini API keys configured');
  }
  const key = API_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % API_KEYS.length;
  return key;
}

/**
 * Request a short-lived ephemeral token from Google so that
 * the raw API key never leaves the server.
 */
async function requestEphemeralToken(apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${apiKey}`;

  // Make a minimal server-side call to validate that the key + model
  // combination is live. The client will use the ephemeral token
  // returned here (or, when Google ships the dedicated endpoint,
  // swap to that).
  //
  // Google's current ephemeral-token endpoint (preview):
  //   POST https://generativelanguage.googleapis.com/v1beta/models/MODEL:newEphemeralToken
  //
  // Until the dedicated endpoint is GA we proxy through a minimal
  // generateContent call whose sole purpose is to prove liveness and
  // return the model name so the client knows what to connect to.

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:newEphemeralToken?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' },
          },
        },
      }),
    }
  );

  if (response.ok) {
    const data = await response.json();
    return {
      token: data.token ?? data.ephemeralToken ?? null,
      expiresIn: data.expiresIn ?? data.expireTime ? Math.floor((new Date(data.expireTime).getTime() - Date.now()) / 1000) : 120,
    };
  }

  // Fallback: if the dedicated endpoint is not yet available, return
  // a server-generated proxy indicator so the client knows to route
  // through the server-side WebSocket proxy instead.
  return null;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { language = 'en-US', model = DEFAULT_MODEL } = req.body || {};

    const apiKey = getNextKey();

    // Attempt to get an ephemeral token from Google so the raw key
    // is never exposed to the client.
    const ephemeral = await requestEphemeralToken(apiKey, model);

    if (ephemeral?.token) {
      // Build the WS URL using the short-lived token (NOT the API key).
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${ephemeral.token}`;

      return res.status(200).json({
        success: true,
        wsUrl,
        language,
        model,
        expiresIn: ephemeral.expiresIn,
      });
    }

    // Ephemeral token endpoint unavailable — signal the client to
    // use the server-side WebSocket proxy instead of a direct connection.
    return res.status(200).json({
      success: true,
      useProxy: true,
      proxyUrl: '/api/gemini-ws-proxy',
      language,
      model,
      expiresIn: 3600,
      note: 'Ephemeral token endpoint unavailable. Use the server-side proxy for WebSocket connections.',
    });
  } catch (error) {
    console.error('Ephemeral token error:', error);
    res.status(500).json({
      error: 'Failed to generate ephemeral token',
      message: error.message,
    });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
