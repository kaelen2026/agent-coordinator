import { authUserSchema } from "@agent-coordinator/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/errors.js";
import { getCurrentUser, type ReadSession, type SessionUser } from "./service.js";

const headers = new Headers();

const makeSessionUser = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: "user_1",
  email: "ada@example.com",
  name: "Ada",
  emailVerified: false,
  image: null,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  ...overrides,
});

const sessionOf =
  (user: SessionUser): ReadSession =>
  async () => ({ user });
const noSession: ReadSession = async () => null;

describe("getCurrentUser", () => {
  it("throws_unauthenticated_when_no_session", async () => {
    await expect(getCurrentUser(noSession, headers)).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    await expect(getCurrentUser(noSession, headers)).rejects.toBeInstanceOf(AppError);
  });

  it("returns_only_whitelisted_fields_for_active_session", async () => {
    // better-auth 的 user 行带 updatedAt 等内部字段，且未来可能新增——不得原样透出
    const raw = { ...makeSessionUser(), updatedAt: new Date(), password: "hashed-secret" };
    const user = await getCurrentUser(sessionOf(raw as SessionUser), headers);

    expect(Object.keys(user).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "image",
      "name",
    ]);
    expect(authUserSchema.parse(user)).toEqual(user);
  });

  it("serializes_created_at_as_iso_8601_string", async () => {
    const user = await getCurrentUser(
      sessionOf(makeSessionUser({ createdAt: new Date("2026-01-02T03:04:05.000Z") })),
      headers,
    );
    expect(user.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("accepts_created_at_already_serialized_by_the_driver", async () => {
    const user = await getCurrentUser(
      sessionOf(makeSessionUser({ createdAt: "2026-01-02T03:04:05.000Z" })),
      headers,
    );
    expect(user.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("fails_loudly_on_an_unparsable_created_at_rather_than_inventing_a_timestamp", async () => {
    // image 可以降级为 null，时间戳不行——编一个出来只会让排障更难
    await expect(
      getCurrentUser(sessionOf(makeSessionUser({ createdAt: "garbage" })), headers),
    ).rejects.toThrow(/createdAt/);
  });

  it("degrades_unparsable_image_to_null_instead_of_breaking_the_contract", async () => {
    const user = await getCurrentUser(sessionOf(makeSessionUser({ image: "not-a-url" })), headers);
    expect(user.image).toBeNull();
  });

  it("keeps_a_valid_image_url", async () => {
    const user = await getCurrentUser(
      sessionOf(makeSessionUser({ image: "https://cdn.example.com/a.png" })),
      headers,
    );
    expect(user.image).toBe("https://cdn.example.com/a.png");
  });

  it("treats_missing_image_as_null", async () => {
    const user = await getCurrentUser(sessionOf(makeSessionUser({ image: undefined })), headers);
    expect(user.image).toBeNull();
  });
});
