import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Small helpers around one server secret (UNDERCUT_SECRET): signed cookies,
 * and encryption of stored tokens such as a shop's Shopify access token.
 */
export class Secrets {
  private readonly signKey: Buffer;
  private readonly encKey: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 24) throw new Error("UNDERCUT_SECRET must be at least 24 characters.");
    this.signKey = createHash("sha256").update(`sign:${secret}`).digest();
    this.encKey = createHash("sha256").update(`encrypt:${secret}`).digest();
  }

  sign(value: string): string {
    return `${value}.${createHmac("sha256", this.signKey).update(value).digest("base64url")}`;
  }

  /** The value inside a signed string, or null if it was tampered with. */
  unsign(signed: string | undefined): string | null {
    if (!signed) return null;
    const i = signed.lastIndexOf(".");
    if (i <= 0) return null;
    const value = signed.slice(0, i);
    return safeEqual(this.sign(value), signed) ? value : null;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognised encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
