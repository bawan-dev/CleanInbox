const ENVELOPE_PREFIX = "ci1";
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;

type WebCryptoBytes = Uint8Array<ArrayBuffer>;

export type SecretAadContext = {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  field: string;
};

export class SecretEncryptionError extends Error {
  constructor(message = "The secret could not be encrypted safely.") {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

export class SecretDecryptionError extends Error {
  constructor() {
    super("The encrypted secret could not be authenticated or decrypted.");
    this.name = "SecretDecryptionError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): WebCryptoBytes {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Invalid base64url value.");
  }

  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");

  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError("Invalid base64url value.");
  }
}

function decodeKeyMaterial(value: string): WebCryptoBytes {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmed)) {
    throw new TypeError("APP_ENCRYPTION_KEY must be a base64-encoded 256-bit key.");
  }

  const unpadded = trimmed.replace(/=+$/u, "");
  const standard = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");

  let decoded: WebCryptoBytes;
  try {
    const binary = atob(padded);
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError("APP_ENCRYPTION_KEY must be a base64-encoded 256-bit key.");
  }

  if (decoded.byteLength !== AES_256_KEY_BYTES) {
    throw new TypeError("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return decoded;
}

export function isValidAes256KeyMaterial(value: string): boolean {
  try {
    decodeKeyMaterial(value);
    return true;
  } catch {
    return false;
  }
}

export async function importAes256GcmKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeKeyMaterial(value),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toBytes(value: string | Uint8Array): WebCryptoBytes {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value);
}

function requireAdditionalData(value: string | Uint8Array): WebCryptoBytes {
  const bytes = toBytes(value);
  if (bytes.byteLength === 0) {
    throw new TypeError("Authenticated additional data is required.");
  }
  return bytes;
}

function assertContextPart(name: keyof SecretAadContext, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new TypeError(`${name} must be between 1 and 256 characters.`);
  }
  return trimmed;
}

/**
 * Produces stable AAD that binds a ciphertext to one tenant, record, and field.
 * The returned value is safe to store beside the ciphertext; it is not a secret.
 */
export function buildSecretAad(context: SecretAadContext): string {
  return JSON.stringify([
    ENVELOPE_PREFIX,
    assertContextPart("tenantId", context.tenantId),
    assertContextPart("resourceType", context.resourceType),
    assertContextPart("resourceId", context.resourceId),
    assertContextPart("field", context.field),
  ]);
}

async function resolveKey(key: CryptoKey | string): Promise<CryptoKey> {
  return typeof key === "string" ? importAes256GcmKey(key) : key;
}

/**
 * Encrypts a non-empty secret into a versioned, storage-safe envelope.
 * WebCrypto appends the 128-bit authentication tag to the ciphertext.
 */
export async function encryptSecret(
  plaintext: string,
  key: CryptoKey | string,
  additionalData: string | Uint8Array,
): Promise<string> {
  if (!plaintext) {
    throw new SecretEncryptionError("An empty secret cannot be encrypted.");
  }

  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));

  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: requireAdditionalData(additionalData),
        tagLength: AES_GCM_TAG_BYTES * 8,
      },
      await resolveKey(key),
      new TextEncoder().encode(plaintext),
    );

    return `${ENVELOPE_PREFIX}.${encodeBase64Url(iv)}.${encodeBase64Url(
      new Uint8Array(ciphertext),
    )}`;
  } catch (error) {
    if (error instanceof TypeError || error instanceof SecretEncryptionError) {
      throw error;
    }
    throw new SecretEncryptionError();
  }
}

function parseEnvelope(envelope: string): {
  iv: WebCryptoBytes;
  ciphertext: WebCryptoBytes;
} {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) {
    throw new SecretDecryptionError();
  }

  try {
    const iv = decodeBase64Url(parts[1]);
    const ciphertext = decodeBase64Url(parts[2]);

    if (
      iv.byteLength !== AES_GCM_IV_BYTES ||
      ciphertext.byteLength < AES_GCM_TAG_BYTES
    ) {
      throw new SecretDecryptionError();
    }

    return { iv, ciphertext };
  } catch {
    throw new SecretDecryptionError();
  }
}

export async function decryptSecret(
  envelope: string,
  key: CryptoKey | string,
  additionalData: string | Uint8Array,
): Promise<string> {
  try {
    const { iv, ciphertext } = parseEnvelope(envelope);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: requireAdditionalData(additionalData),
        tagLength: AES_GCM_TAG_BYTES * 8,
      },
      await resolveKey(key),
      ciphertext,
    );

    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    // Deliberately collapse malformed envelopes, wrong keys, and AAD mismatches.
    throw new SecretDecryptionError();
  }
}

export async function sha256Bytes(value: string | Uint8Array): Promise<WebCryptoBytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(value)));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const digest = await sha256Bytes(value);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  return encodeBase64Url(await sha256Bytes(value));
}
