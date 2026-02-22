interface Env {
  DODO_BASE_URL: string;
  ED25519_PRIVATE_KEY_HEX: string;
}

interface SignedToken {
  licenseKey: string;
  instanceId: string;
  status: "active" | "invalid";
  issuedAt: number;
  expiresAt: number;
}

interface SignedResponse {
  token: SignedToken;
  signature: string;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function importPrivateKey(hexKey: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(hexKey);
  // Ed25519 PKCS8 prefix for a 32-byte private key
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + keyBytes.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(keyBytes, pkcs8Prefix.length);

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
}

async function signToken(token: SignedToken, privateKey: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(token));
  const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
  return bytesToBase64(new Uint8Array(signature));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/activate") {
        return await handleActivate(request, env);
      } else if (path === "/validate") {
        return await handleValidate(request, env);
      } else if (path === "/deactivate") {
        return await handleDeactivate(request, env);
      }
      return errorResponse("Not found", 404);
    } catch (err) {
      return errorResponse("Internal error", 500);
    }
  },
};

async function handleActivate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { license_key?: string; name?: string };
  if (!body.license_key || !body.name) {
    return errorResponse("Missing license_key or name", 400);
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ license_key: body.license_key, name: body.name }),
  });

  if (dodoRes.status !== 200 && dodoRes.status !== 201) {
    const text = await dodoRes.text();
    return new Response(text, {
      status: dodoRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const dodoData = (await dodoRes.json()) as { id: string };
  if (!dodoData.id || typeof dodoData.id !== "string") {
    return errorResponse("Invalid response from license server", 502);
  }

  const now = Math.floor(Date.now() / 1000);
  const token: SignedToken = {
    licenseKey: body.license_key,
    instanceId: dodoData.id,
    status: "active",
    issuedAt: now,
    expiresAt: now + 3600,
  };

  const privateKey = await importPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
  const signature = await signToken(token, privateKey);

  return jsonResponse({ token, signature, id: dodoData.id });
}

async function handleValidate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    license_key?: string;
    license_key_instance_id?: string;
  };
  if (!body.license_key || !body.license_key_instance_id) {
    return errorResponse("Missing license_key or license_key_instance_id", 400);
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: body.license_key,
      license_key_instance_id: body.license_key_instance_id,
    }),
  });

  const now = Math.floor(Date.now() / 1000);

  if (dodoRes.status === 200) {
    const dodoData = (await dodoRes.json()) as Record<string, unknown>;
    if (!dodoData.id || typeof dodoData.id !== "string") {
      return errorResponse("Invalid response from license server", 502);
    }

    const token: SignedToken = {
      licenseKey: body.license_key,
      instanceId: body.license_key_instance_id,
      status: "active",
      issuedAt: now,
      expiresAt: now + 3600,
    };

    const privateKey = await importPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
    const signature = await signToken(token, privateKey);

    return jsonResponse({ token, signature });
  }

  if (dodoRes.status === 404 || dodoRes.status === 403 || dodoRes.status === 422) {
    const token: SignedToken = {
      licenseKey: body.license_key,
      instanceId: body.license_key_instance_id,
      status: "invalid",
      issuedAt: now,
      expiresAt: now + 3600,
    };

    const privateKey = await importPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
    const signature = await signToken(token, privateKey);

    return jsonResponse({ token, signature }, dodoRes.status);
  }

  return errorResponse("License server error", 502);
}

async function handleDeactivate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    license_key?: string;
    license_key_instance_id?: string;
  };
  if (!body.license_key || !body.license_key_instance_id) {
    return errorResponse("Missing license_key or license_key_instance_id", 400);
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/deactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: body.license_key,
      license_key_instance_id: body.license_key_instance_id,
    }),
  });

  const text = await dodoRes.text();
  return new Response(text, {
    status: dodoRes.status,
    headers: { "Content-Type": "application/json" },
  });
}
