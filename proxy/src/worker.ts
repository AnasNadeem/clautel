interface Env {
  DODO_BASE_URL: string;
  ED25519_PRIVATE_KEY_HEX: string;
  LICENSE_KV: KVNamespace;
}

interface KVBinding {
  instanceName: string;
  instanceId: string;
  activatedAt: string;
}

interface SignedToken {
  licenseKey: string;
  instanceId: string;
  status: "active" | "invalid";
  issuedAt: number;
  expiresAt: number;
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

// Cache the imported private key within the isolate to avoid reimporting on every request
let _cachedPrivateKey: CryptoKey | null = null;
let _cachedKeyHex: string | null = null;

async function getPrivateKey(hexKey: string): Promise<CryptoKey> {
  if (_cachedPrivateKey && _cachedKeyHex === hexKey) return _cachedPrivateKey;

  const keyBytes = hexToBytes(hexKey);
  // Ed25519 PKCS8 prefix for a 32-byte private key
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + keyBytes.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(keyBytes, pkcs8Prefix.length);

  _cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  _cachedKeyHex = hexKey;
  return _cachedPrivateKey;
}

async function signToken(token: SignedToken, privateKey: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(token));
  const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
  return bytesToBase64(new Uint8Array(signature));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function parseJsonBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Parse JSON body once, return 400 on failure
    let body: Record<string, unknown>;
    try {
      const parsed = parseJsonBody(await request.json());
      if (!parsed) return errorResponse("Invalid JSON body", 400);
      body = parsed;
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    try {
      if (path === "/activate") {
        return await handleActivate(body, env);
      } else if (path === "/validate") {
        return await handleValidate(body, env);
      } else if (path === "/deactivate") {
        return await handleDeactivate(body, env);
      } else if (path === "/health-check") {
        return await handleHealthCheck(body, env);
      }
      return errorResponse("Not found", 404);
    } catch {
      return errorResponse("Internal error", 500);
    }
  },
};

async function handleActivate(body: Record<string, unknown>, env: Env): Promise<Response> {
  const licenseKey = body.license_key;
  const name = body.name;
  if (!licenseKey || typeof licenseKey !== "string" || !name || typeof name !== "string") {
    return errorResponse("Missing license_key or name", 400);
  }

  // Check if this key is already bound to a different machine
  const kvKey = `license:${licenseKey}`;
  const existing = await env.LICENSE_KV.get<KVBinding>(kvKey, "json");
  if (existing && existing.instanceName !== name) {
    return errorResponse(
      "This license key is already activated on another machine. Deactivate it first with: clautel deactivate",
      409
    );
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ license_key: licenseKey, name }),
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

  // Bind this key to this machine in KV
  const binding: KVBinding = {
    instanceName: name,
    instanceId: dodoData.id,
    activatedAt: new Date().toISOString(),
  };
  await env.LICENSE_KV.put(kvKey, JSON.stringify(binding));

  const now = Math.floor(Date.now() / 1000);
  const token: SignedToken = {
    licenseKey,
    instanceId: dodoData.id,
    status: "active",
    issuedAt: now,
    expiresAt: now + 3600,
  };

  const privateKey = await getPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
  const signature = await signToken(token, privateKey);

  return jsonResponse({ token, signature, id: dodoData.id });
}

async function handleValidate(body: Record<string, unknown>, env: Env): Promise<Response> {
  const licenseKey = body.license_key;
  const instanceId = body.license_key_instance_id;
  if (!licenseKey || typeof licenseKey !== "string" || !instanceId || typeof instanceId !== "string") {
    return errorResponse("Missing license_key or license_key_instance_id", 400);
  }

  // Check KV binding — reject if instanceId doesn't match the activated machine
  const kvKey = `license:${licenseKey}`;
  const existing = await env.LICENSE_KV.get<KVBinding>(kvKey, "json");
  if (existing && existing.instanceId !== instanceId) {
    const now = Math.floor(Date.now() / 1000);
    const token: SignedToken = {
      licenseKey,
      instanceId,
      status: "invalid",
      issuedAt: now,
      expiresAt: now + 3600,
    };
    const privateKey = await getPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
    const signature = await signToken(token, privateKey);
    return jsonResponse({ token, signature }, 403);
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      license_key_instance_id: instanceId,
    }),
  });

  const now = Math.floor(Date.now() / 1000);

  if (dodoRes.status === 200) {
    const dodoData = (await dodoRes.json()) as Record<string, unknown>;
    if (!dodoData.id || typeof dodoData.id !== "string") {
      return errorResponse("Invalid response from license server", 502);
    }

    const token: SignedToken = {
      licenseKey,
      instanceId,
      status: "active",
      issuedAt: now,
      expiresAt: now + 3600,
    };

    const privateKey = await getPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
    const signature = await signToken(token, privateKey);

    return jsonResponse({ token, signature });
  }

  if (dodoRes.status === 404 || dodoRes.status === 403 || dodoRes.status === 422) {
    const token: SignedToken = {
      licenseKey,
      instanceId,
      status: "invalid",
      issuedAt: now,
      expiresAt: now + 3600,
    };

    const privateKey = await getPrivateKey(env.ED25519_PRIVATE_KEY_HEX);
    const signature = await signToken(token, privateKey);

    return jsonResponse({ token, signature }, dodoRes.status);
  }

  return errorResponse("License server error", 502);
}

async function handleHealthCheck(body: Record<string, unknown>, env: Env): Promise<Response> {
  const licenseKey = body.license_key;
  const instanceId = body.instance_id;
  if (!licenseKey || typeof licenseKey !== "string" || !instanceId || typeof instanceId !== "string") {
    return errorResponse("Missing license_key or instance_id", 400);
  }

  // Verify the license key and instance ID match an existing activation
  const kvKey = `license:${licenseKey}`;
  const existing = await env.LICENSE_KV.get<KVBinding>(kvKey, "json");
  if (!existing || existing.instanceId !== instanceId) {
    return errorResponse("Unauthorized", 403);
  }

  const plan = typeof body.plan === "string" ? body.plan : undefined;

  await env.LICENSE_KV.put(
    `activity:${licenseKey}`,
    JSON.stringify({
      lastActiveAt: new Date().toISOString(),
      plan,
      instanceId,
    })
  );

  return jsonResponse({ ok: true });
}

async function handleDeactivate(body: Record<string, unknown>, env: Env): Promise<Response> {
  const licenseKey = body.license_key;
  const instanceId = body.license_key_instance_id;
  if (!licenseKey || typeof licenseKey !== "string" || !instanceId || typeof instanceId !== "string") {
    return errorResponse("Missing license_key or license_key_instance_id", 400);
  }

  const dodoRes = await fetch(`${env.DODO_BASE_URL}/licenses/deactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      license_key_instance_id: instanceId,
    }),
  });

  // Clear KV binding on successful deactivation — frees key for another machine
  if (dodoRes.status === 200) {
    await env.LICENSE_KV.delete(`license:${licenseKey}`);
  }

  const text = await dodoRes.text();
  return new Response(text, {
    status: dodoRes.status,
    headers: { "Content-Type": "application/json" },
  });
}
