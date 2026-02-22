import { ApiError } from './errors'

const AES_GCM_IV_LENGTH = 12

function normalizeBase64(value: string, label: string): string {
  const trimmed = value.trim()
  const withoutWhitespace = trimmed.replace(/\s+/g, '')
  const replacedMinus = withoutWhitespace.replace(/-/g, '+')
  const normalized = replacedMinus.replace(/_/g, '/')
  const lengthRemainder = normalized.length % 4

  if (lengthRemainder === 1) {
    throw new ApiError(500, 'VALIDATION_ERROR', `${label} has invalid base64 length`)
  }

  if (lengthRemainder === 0) {
    return normalized
  }

  const missingPadding = 4 - lengthRemainder
  const padding = '='.repeat(missingPadding)

  return `${normalized}${padding}`
}

function base64ToBytes(value: string, label: string): Uint8Array {
  const normalized = normalizeBase64(value, label)
  let binary = ''

  try {
    binary = atob(normalized)
  } catch {
    throw new ApiError(500, 'VALIDATION_ERROR', `${label} is not valid base64 data`)
  }

  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)

  copy.set(bytes)

  return copy.buffer
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key, 'SECRETS_ENCRYPTION_KEY_B64')
  const keyBuffer = toArrayBuffer(keyBytes)
  const hasValidLength = keyBytes.byteLength === 32

  if (!hasValidLength) {
    throw new ApiError(
      500,
      'VALIDATION_ERROR',
      'SECRETS_ENCRYPTION_KEY_B64 must decode to 32 bytes'
    )
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    {
      name: 'AES-GCM'
    },
    false,
    ['decrypt', 'encrypt']
  )

  return cryptoKey
}

export async function decryptSecret(
  ciphertextBase64: string,
  ivBase64: string,
  keyBase64: string
): Promise<string> {
  const key = await importAesKey(keyBase64)
  const iv = base64ToBytes(ivBase64, 'Stored secret IV')
  const ivBuffer = toArrayBuffer(iv)
  const ciphertext = base64ToBytes(ciphertextBase64, 'Stored secret ciphertext')
  const ciphertextBuffer = toArrayBuffer(ciphertext)

  try {
    const plainBuffer = await crypto.subtle.decrypt(
      {
        iv: ivBuffer,
        name: 'AES-GCM'
      },
      key,
      ciphertextBuffer
    )
    const decoder = new TextDecoder()
    const plainText = decoder.decode(plainBuffer)

    return plainText
  } catch {
    throw new ApiError(
      500,
      'VALIDATION_ERROR',
      'Stored secret cannot be decrypted with current key'
    )
  }
}

export async function encryptSecret(
  secret: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importAesKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH))
  const ivBuffer = toArrayBuffer(iv)
  const encoder = new TextEncoder()
  const plainBytes = encoder.encode(secret)
  const plainBuffer = toArrayBuffer(plainBytes)
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      iv: ivBuffer,
      name: 'AES-GCM'
    },
    key,
    plainBuffer
  )
  const encryptedBytes = new Uint8Array(encryptedBuffer)

  return {
    ciphertext: bytesToBase64(encryptedBytes),
    iv: bytesToBase64(iv)
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const digestBytes = new Uint8Array(digest)
  let output = ''

  for (const byte of digestBytes) {
    output += byte.toString(16).padStart(2, '0')
  }

  return output
}
