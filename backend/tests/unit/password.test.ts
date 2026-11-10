import { hashPassword, verifyPassword } from "../../src/common/password";

describe("Password hashing", () => {
  it("hashes a password to something that isn't the plaintext", async () => {
    const hash = await hashPassword("Passw0rd123");
    expect(hash).not.toBe("Passw0rd123");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("verifies a correct password against its hash", async () => {
    const hash = await hashPassword("Passw0rd123");
    expect(await verifyPassword(hash, "Passw0rd123")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Passw0rd123");
    expect(await verifyPassword(hash, "WrongPassword1")).toBe(false);
  });

  it("returns false (not throw) for a malformed hash", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const hash1 = await hashPassword("Passw0rd123");
    const hash2 = await hashPassword("Passw0rd123");
    expect(hash1).not.toBe(hash2);
  });
});
